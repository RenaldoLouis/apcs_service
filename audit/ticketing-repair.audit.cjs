// Repair regressions, 7 October 2026. Offline: actual repository/controller/service/job source runs
// against the in-memory fixture from public-ticket.audit.cjs. Paper.id, email and timers are substituted.
// See docs/TICKETING_REPAIR_PLAN_2026-10-07.md. These do not replace the emulator integration audit.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fixtureFile = path.join(__dirname, 'public-ticket.audit.cjs');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').split("test('CONTROL:")[0]
    .replace('return { records, seed, timestamp', 'return { db, records, seed, timestamp');
const context = { require, __dirname, module: { exports: {} } };
vm.runInNewContext(fixtureSource + '\nmodule.exports = fixture;', context, { filename: fixtureFile });
const baseFixture = context.module.exports;

const MODULES = {
    '../repositories/PublicTicketRepository': 'src/repositories/PublicTicketRepository.js',
    './PublicTicketRepository': 'src/repositories/PublicTicketRepository.js',
    '../repositories/PublicTicketPaymentReceiptRepository': 'src/repositories/PublicTicketPaymentReceiptRepository.js',
    '../services/PublicTicketPaymentService': 'src/services/PublicTicketPaymentService.js',
    '../services/PublicTicketService': 'src/services/PublicTicketService.js',
    '../utils/DatabaseUtil': 'src/utils/DatabaseUtil.js',
    '../repositories/TicketSeatAdminRepository': 'src/repositories/TicketSeatAdminRepository.js',
    '../services/PublicTicketAdminReleaseService': 'src/services/PublicTicketAdminReleaseService.js',
};

function fixture(options = {}) {
    const emails = [];
    const emailService = new Proxy({}, { get: (_, name) => async data => {
        emails.push({ name, bookingId: data?.id });
    } });
    const extraRequire = (name, load) => {
        if (MODULES[name]) return load(MODULES[name]);
        if (name === './EmailService' || name === '../services/EmailService') return emailService;
        if (name === '../utils/Logger.js') return { logger: { info() {}, warn() {}, error() {} } };
        if (['express-validator', '../utils/discountUtils', '../services/PaperService.js'].includes(name)) return {};
        return undefined;
    };
    const f = baseFixture({ ...options, extraRequire });
    const receipts = () => [...f.records.entries()].filter(([key]) => key.startsWith('ticketPaymentReceipts/'))
        .map(([key, value]) => ({ id: key.split('/')[1], ...value }));
    const confirmations = id => emails.filter(email => email.name === 'sendPublicBookingConfirmationEmail' && email.bookingId === id).length;
    return { ...f, emails, receipts, confirmations };
}

const paid = (bookingId, invoiceId, total) => ({ invoice: { id: invoiceId, number: bookingId, status: 'paid', total_amount: total } });
const response = () => ({ statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } });
const booking = (f, id) => f.records.get(`publicBookings/${id}`);
async function callback(f, route, body) {
    const res = response();
    const controller = route === 'generic'
        ? f.load('src/controllers/PaperController.js')
        : f.load('src/controllers/PublicTicketController.js');
    await (route === 'generic' ? controller.handlePaperWebhook : controller.handlePublicTicketWebhook)({ body }, res, error => { throw error; });
    return res;
}
// Fails only a transaction that tries to mark a booking PAID, before its commit.
function failPaidCommits(f) {
    const original = f.db.runTransaction;
    f.db.runTransaction = callback => original(transaction => callback({
        ...transaction,
        update: (target, values) => {
            if (values.paymentStatus === 'PAID') throw new Error('Injected fulfillment failure before commit');
            return transaction.update(target, values);
        },
    }));
    return () => { f.db.runTransaction = original; };
}
const seatBooking = { selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] };

test('REPAIR PAYMENT: both callback routes store a durable receipt when fulfillment fails, and recovery after restart pays once', async () => {
    const f = fixture(); f.seat();
    const { error, result } = await f.book(seatBooking);
    assert.ifError(error);
    const id = result.bookingId;
    const current = booking(f, id);
    const restore = failPaidCommits(f);
    for (const route of ['dedicated', 'generic']) {
        const res = await callback(f, route, paid(id, current.invoiceId, current.totalAmount));
        assert.equal(res.statusCode, 200, `${route} route acknowledged only after the receipt was stored`);
        assert.equal(res.body.status, 'RECEIVED_FOR_RECONCILIATION');
    }
    restore();
    const [receipt] = f.receipts();
    assert.equal(f.receipts().length, 1);
    assert.equal(receipt.status, 'pending');
    assert.equal(receipt.deliveryCount, 2);
    assert.equal(receipt.reason, 'fulfillment_failed');
    assert.equal(booking(f, id).paymentStatus, 'pending');
    assert.equal(booking(f, id).paymentReceipt.status, 'pending');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');

    // A fresh module load models a service restart; the job's startup pass replays the receipt.
    const job = f.load('src/jobs/PublicTicketPaymentRecoveryJob.js');
    job.startPublicTicketPaymentRecovery();
    f.advance(30 * 60 * 1000);
    await f.timers[f.timers.length - 1]();
    assert.equal(booking(f, id).paymentStatus, 'PAID');
    assert.ok(booking(f, id).paymentDetails);
    assert.equal(f.receipts()[0].status, 'processed');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'booked');
    assert.equal(f.confirmations(id), 1);
    await f.intervals[f.intervals.length - 1]();
    assert.equal(f.confirmations(id), 1, 'A later recovery pass does not resend the confirmation');
});

test('REPAIR PAYMENT: a callback that cannot be stored is never acknowledged as success; registrations keep their route', async () => {
    const f = fixture();
    const { result } = await f.book();
    const current = booking(f, result.bookingId);
    const original = f.db.runTransaction;
    f.db.runTransaction = async () => { throw new Error('Firestore unavailable'); };
    for (const route of ['dedicated', 'generic']) {
        const res = await callback(f, route, paid(result.bookingId, current.invoiceId, current.totalAmount));
        assert.equal(res.statusCode, 500);
        assert.equal(res.body.status, 'RECEIPT_NOT_STORED');
    }
    f.db.runTransaction = original;
    assert.equal(booking(f, result.bookingId).paymentStatus, 'pending');

    f.seed('Registrants2025/registration-1', { eventId: 'APCS2026', performers: [], amountToPay: 500000 });
    const registration = await callback(f, 'generic', { invoice: { id: 'reg-invoice', number: 'registration-1', status: 'paid', amount: 500000 } });
    assert.equal(registration.statusCode, 200);
    assert.equal(f.records.get('Registrants2025/registration-1').paymentStatus, 'PAID');
    assert.equal(f.receipts().length, 0, 'Registration payments do not use ticket receipts');
});

test('REPAIR PAYMENT: an early paid callback is preserved and applied once checkout saves the invoice', async () => {
    let early;
    const f = fixture({
        getInvoice: async id => ({ invoiceId: id, number: early.bookingId, paymentStatus: 'unpaid', total: early.total }),
        beforeInvoiceResponse: async ({ body, records }) => {
            const record = records.get(`publicBookings/${body.externalId}`);
            early = { bookingId: body.externalId, total: record.totalAmount };
            early.response = await callback(f, 'dedicated', paid(body.externalId, `invoice-${body.externalId}`, record.totalAmount));
        },
    });
    const controller = f.load('src/controllers/PublicTicketController.js');
    const res = response();
    await controller.createPublicTicketBooking({ body: f.body({}) }, res, error => { throw error; });
    assert.equal(res.statusCode, 201);
    assert.equal(early.response.statusCode, 200);
    assert.equal(early.response.body.status, 'RECEIVED_FOR_RECONCILIATION');
    assert.equal(booking(f, early.bookingId).paymentStatus, 'PAID', 'The early receipt was replayed after the invoice was saved');
    assert.equal(f.receipts()[0].status, 'processed');
    assert.equal(f.confirmations(early.bookingId), 1);
    assert.equal(f.emails.filter(email => email.name === 'sendPublicSeatHoldEmail').length, 0, 'A paid booking gets no payment-pending email');
});

test('REPAIR PAYMENT: a lost invoice response recovers only through provider-verified payment and keeps inventory held until then', async () => {
    let provider = { paymentStatus: 'unpaid' };
    const f = fixture({ invoiceFails: true, getInvoice: async id => ({ invoiceId: id, ...provider }) });
    f.seat();
    const attempt = await f.book(seatBooking);
    assert.ok(attempt.error);
    const [id] = [...f.records.keys()].filter(key => key.startsWith('publicBookings/')).map(key => key.split('/')[1]);
    const failed = booking(f, id);
    assert.equal(failed.paymentStatus, 'failed');
    assert.equal(failed.checkoutFailure.invoiceCancellationStatus, 'unknown');
    provider = { ...provider, number: id, total: failed.totalAmount };

    const unpaid = await callback(f, 'dedicated', paid(id, 'provider-invoice-1', failed.totalAmount));
    assert.equal(unpaid.statusCode, 200);
    assert.equal(f.receipts()[0].reason, 'provider_not_paid');
    assert.equal(booking(f, id).paymentStatus, 'failed');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked', 'Unverified payment never releases or books inventory');
    const capacity = [...f.records.entries()].find(([key]) => key.startsWith('ticketCapacity/'))[1];
    assert.equal(capacity.reservedByTier.presto, 1);

    provider.paymentStatus = 'paid';
    f.advance(30 * 60 * 1000);
    await f.load('src/services/PublicTicketPaymentService.js').processDueReceipts();
    const recovered = booking(f, id);
    assert.equal(recovered.paymentStatus, 'PAID');
    assert.equal(recovered.invoiceId, 'provider-invoice-1', 'The provider-verified invoice identity is adopted');
    assert.equal(recovered.paymentVerification.source, 'paper_sales_invoice_api');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'booked');
    assert.equal(f.confirmations(id), 1);
});

test('REPAIR PAYMENT: forged invoice IDs, provider outages, mismatches and cancelled bookings never become PAID', async () => {
    const f = fixture({ invoiceFails: true, getInvoice: async id => {
        if (id === 'outage') throw new Error('Provider unavailable');
        return { invoiceId: id, number: 'another-booking', paymentStatus: 'paid', total: 150000 };
    } });
    await f.book();
    const [failedId] = [...f.records.keys()].filter(key => key.startsWith('publicBookings/')).map(key => key.split('/')[1]);
    const forged = await callback(f, 'dedicated', paid(failedId, 'forged-invoice', 150000));
    assert.equal(forged.statusCode, 200);
    assert.equal(f.receipts().find(receipt => receipt.providerInvoiceId === 'forged-invoice').status, 'needs_review');
    await callback(f, 'generic', paid(failedId, 'outage', 150000));
    const outage = f.receipts().find(receipt => receipt.providerInvoiceId === 'outage');
    assert.equal(outage.status, 'pending');
    assert.equal(outage.reason, 'provider_verification_unavailable');
    assert.equal(booking(f, failedId).paymentStatus, 'failed');
    assert.equal(booking(f, failedId).paymentReceipt.status, 'pending');

    const healthy = fixture();
    const pending = (await healthy.book()).result.bookingId;
    await callback(healthy, 'dedicated', paid(pending, 'different-invoice', 150000));
    assert.equal(healthy.receipts()[0].reason, 'invoice_mismatch');
    await callback(healthy, 'dedicated', paid(pending, booking(healthy, pending).invoiceId, 1));
    assert.equal(healthy.receipts().find(receipt => receipt.providerInvoiceId === booking(healthy, pending).invoiceId).reason, 'payment_amount_mismatch');
    assert.equal(booking(healthy, pending).paymentStatus, 'pending');

    healthy.seat();
    const expiring = (await healthy.book(seatBooking)).result.bookingId;
    healthy.advance(31 * 60 * 1000);
    await healthy.load('src/repositories/PublicTicketFailureRepository.js').expirePublicTicketBooking(expiring);
    assert.equal(booking(healthy, expiring).paymentStatus, 'expired');
    await callback(healthy, 'dedicated', paid(expiring, booking(healthy, expiring).invoiceId, booking(healthy, expiring).totalAmount));
    assert.equal(healthy.receipts().find(receipt => receipt.bookingId === expiring).reason, 'booking_canceled_before_payment');
    assert.equal(booking(healthy, expiring).paymentStatus, 'expired');
    assert.equal(healthy.records.get('seatsAPCS2026/seat-1').status, 'available');
});

test('REPAIR PAYMENT: duplicate paid callbacks converge on one receipt, one paid transition and one confirmation', async () => {
    const f = fixture();
    const id = (await f.book()).result.bookingId;
    const current = booking(f, id);
    for (const route of ['dedicated', 'generic', 'dedicated']) {
        const res = await callback(f, route, paid(id, current.invoiceId, current.totalAmount));
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.status, 'OK', `${route} duplicate converges on the processed receipt`);
    }
    assert.equal(booking(f, id).paymentStatus, 'PAID');
    assert.equal(f.receipts().length, 1);
    assert.equal(f.receipts()[0].deliveryCount, 3);
    assert.equal(f.receipts()[0].status, 'processed');
    assert.equal(f.confirmations(id), 1);
    assert.equal(booking(f, id).emailSent, true);
});

test('REPAIR CLASSIFICATION: attendance-only members are hidden from discovery and rejected by stale or forged checkout; direct orchestra still sells', async () => {
    const f = fixture();
    f.seed('Registrants2025/winner2', { eventId: 'APCS2026', finalAward: 'Gold', performers: [{ fullName: 'Second Winner' }] });
    // A stale projection still lists the attendance member; the published attendance list must win.
    f.seed('sessionAssignments/APCS2026', {
        assignments: { 'V1_2026-11-01_09:00-10:00': [{ registrantId: 'winner' }, { registrantId: 'winner2' }] },
        attendanceOnlyRegistrantIds: ['winner'],
    });
    for (const buyerType of ['public', undefined]) {
        let discovered;
        await f.repo.getEligibleWinners({ buyerType }, (error, data) => { assert.ifError(error); discovered = data; });
        assert.equal(discovered.winners.map(item => item.registrantId).join(','), 'winner2');
    }
    for (const bookingType of ['public_competition', 'winner']) {
        const forged = await f.book({ bookingType, registrantId: 'winner' });
        assert.match(forged.error.message, /orchestra attendance group/);
    }
    assert.ifError((await f.book({ bookingType: 'public_competition', registrantId: 'winner2' })).error);
    f.records.get('events/APCS2026').venues[0].sessions['2026-11-01'].push('19:00-20:00');
    const direct = await f.book({ bookingType: 'public_orchestra', session: '19:00-20:00', tickets: [{ id: 'presto', quantity: 2 }] });
    assert.ifError(direct.error);
    assert.equal(booking(f, direct.result.bookingId).registrantId, '');
    assert.ok((await f.book({ bookingType: 'public_orchestra', registrantId: 'winner', session: '19:00-20:00' })).error,
        'Direct orchestra purchases still cannot carry a registrant');
});

test('REPAIR GENERATION: regeneration preserves locked, booked and canonically owned chairs and refuses unsafe input', async () => {
    const g = fixture();
    const generator = g.load('src/repositories/TicketSeatAdminRepository.js');
    const sessionId = '2026-11-01_09:00-10:00';
    const id = label => `V1-presto-${label}_APCS2026_${sessionId}`;
    g.seed(`seatsAPCS2026/${id('A1')}`, { eventId: 'APCS2026', venueId: 'V1', sessionId, row: 'A', number: 1, areaType: 'presto', seatLabel: 'A1', status: 'locked', lockedByBookingId: 'checkout-1' });
    g.seed(`seatsAPCS2026/${id('A2')}`, { eventId: 'APCS2026', venueId: 'V1', sessionId, row: 'A', number: 2, areaType: 'presto', seatLabel: 'A2', status: 'booked', bookingId: 'paid-1' });
    g.seed(`seatsAPCS2026/${id('A4')}`, { eventId: 'APCS2026', venueId: 'V1', sessionId, row: 'A', number: 4, areaType: 'presto', seatLabel: 'A4', status: 'available', stale: true });
    // Chair A3 is canonically owned through an alias document with a different ID format.
    g.seed('seatsAPCS2026/alias-a3', { eventId: 'APCS2026', venueId: 'V1', sessionId, row: 'A', number: 3, areaType: 'presto', seatLabel: 'A3', status: 'booked', bookingId: 'paid-2' });
    g.seed(`ticketSeatOwnership/${encodeURIComponent(`APCS2026|V1|${sessionId.toUpperCase()}|A|3`).replace(/%/g, '_')}`, { bookingId: 'paid-2', active: true, status: 'booked' });
    const result = await generator.generateSeatLayout({ eventId: 'APCS2026', venueId: 'V1', sessionIds: [sessionId] });
    assert.equal(result.preserved, 3);
    assert.equal(result.refreshed, 1);
    assert.equal(result.created, 16);
    assert.equal(g.records.get(`seatsAPCS2026/${id('A1')}`).lockedByBookingId, 'checkout-1');
    assert.equal(g.records.get(`seatsAPCS2026/${id('A2')}`).status, 'booked');
    assert.equal(g.records.has(`seatsAPCS2026/${id('A3')}`), false, 'No misleading available alias is created for an owned chair');
    assert.equal(g.records.get(`seatsAPCS2026/${id('A4')}`).stale, undefined);
    assert.equal(g.records.get(`seatsAPCS2026/${id('A4')}`).status, 'available');
    await assert.rejects(generator.generateSeatLayout({ eventId: 'APCS2026', venueId: 'V1', sessionIds: ['2026-11-02_09:00-10:00'] }), /not configured/);
    g.records.get('events/APCS2026').competitionScheduleState = { status: 'draft', revision: 1 };
    await assert.rejects(generator.generateSeatLayout({ eventId: 'APCS2026', venueId: 'V1', sessionIds: [sessionId] }), /Publish the competition schedule/);
});

test('REPAIR ASSIGNMENT: backend staff assignment keeps payment, free-seating, tier quantity and alias protection', async () => {
    const f = fixture();
    const seatAdmin = f.load('src/repositories/TicketSeatAdminRepository.js');
    const actor = { uid: 'staff-1', email: 'staff@example.invalid' };
    f.seat('seat-1'); f.seat('seat-2', { number: 2, seatLabel: 'A2' }); f.seat('seat-3', { number: 3, seatLabel: 'A3' });
    f.seat('alias-3', { number: 3, seatLabel: 'A-3', status: 'booked', bookingId: 'someone-else' });
    const id = (await f.book()).result.bookingId;
    await assert.rejects(seatAdmin.assignPaidBookingSeats({ bookingId: id, seatIds: ['seat-1'] }, actor), /paid booking/);
    await f.repo.handlePublicTicketWebhookPaid(id, paid(id, booking(f, id).invoiceId, booking(f, id).totalAmount));
    await assert.rejects(seatAdmin.assignPaidBookingSeats({ bookingId: id, seatIds: ['seat-1', 'seat-2'] }, actor), /Too many presto/);
    await assert.rejects(seatAdmin.assignPaidBookingSeats({ bookingId: id, seatIds: ['seat-3'] }, actor), /already occupied/);
    const assigned = await seatAdmin.assignPaidBookingSeats({ bookingId: id, seatIds: ['seat-2'] }, actor);
    assert.equal(assigned.seatLabels.join(','), 'A2');
    assert.equal(f.records.get('seatsAPCS2026/seat-2').bookingId, id);
    assert.equal(booking(f, id).physicalSeatKeys.length, 1);
    await assert.rejects(seatAdmin.assignPaidBookingSeats({ bookingId: id, seatIds: ['seat-1'] }, actor), /Too many presto/);

    f.records.get('events/APCS2026').venues[0].sessions['2026-11-01'].push('19:00-20:00');
    const orchestra = (await f.book({ bookingType: 'public_orchestra', session: '19:00-20:00' })).result.bookingId;
    await f.repo.handlePublicTicketWebhookPaid(orchestra, paid(orchestra, booking(f, orchestra).invoiceId, booking(f, orchestra).totalAmount));
    await assert.rejects(seatAdmin.assignPaidBookingSeats({ bookingId: orchestra, seatIds: ['seat-1'] }, actor), /free seating/);
});

test('REPAIR ROUTES: new staff seat endpoints require ticketing-admin authentication', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    assert.match(routes, /'\/public-ticket\/admin\/assign-seats', requireTicketingAdmin,/);
    assert.match(routes, /'\/public-ticket\/admin\/seats\/generate', requireTicketingAdmin,/);
    const seatEvent = fs.readFileSync(path.join(__dirname, '../../apcs_web/src/Pages/AdminDashboard/SeatEvent.js'), 'utf8');
    const generator = seatEvent.slice(seatEvent.indexOf('export const uploadFullSeatLayout'), seatEvent.indexOf('const SeatingEvent ='));
    assert.match(generator, /apis\.publicTicket\.generateSeats\(/);
    assert.doesNotMatch(generator, /writeBatch|batch\.set/, 'The browser no longer writes seat documents with an unconditional batch');
});


test('ATTENDANCE: dual membership keeps performance discovery and public/winner checkout available', async () => {
    const f = fixture();
    f.seed('competitionSessionPlans/APCS2026/groups/attendance', {
        purpose: 'orchestra_attendance', registrantIds: ['winner', 'guest-only'],
    });
    // Publication retains the winner's performance and excludes only the attendance-only guest.
    f.seed('sessionAssignments/APCS2026', {
        assignments: { 'V1_2026-11-01_09:00-10:00': [{ registrantId: 'winner' }] },
        attendanceOnlyRegistrantIds: ['guest-only'],
    });
    for (const buyerType of ['public', undefined]) {
        let discovered;
        await f.repo.getEligibleWinners({ buyerType }, (error, data) => { assert.ifError(error); discovered = data; });
        assert.equal(discovered.winners.map(item => item.registrantId).join(','), 'winner');
    }
    for (const bookingType of ['public_competition', 'winner']) {
        const attempt = await f.book({ bookingType, registrantId: 'winner' });
        assert.ifError(attempt.error);
        assert.equal(booking(f, attempt.result.bookingId).registrantId, 'winner');
    }
});
