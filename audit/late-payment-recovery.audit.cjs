// Actual production repository/controller code with isolated database, provider and email substitutes.
// No browser, credentials, real provider, SMTP or production data is used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixtureFile = path.join(__dirname, 'public-ticket.audit.cjs');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').split("test('PUBLIC:")[0]
    .replace('return { records, seed, timestamp', 'return { db, records, seed, timestamp');
const context = { require, __dirname, module: { exports: {} } };
vm.runInNewContext(fixtureSource + '\nmodule.exports = fixture;', context, { filename: fixtureFile });
const actor = { uid: 'staff-1', email: 'staff@example.invalid' };

async function fixture({ released = false, selected = true, emailFails = false, bookingType = 'winner' } = {}) {
    const emails = [];
    const f = context.module.exports({ extraRequire(name, load) {
        if (name.endsWith('/PublicTicketRepository')) return load('src/repositories/PublicTicketRepository.js');
        if (name.endsWith('/PublicTicketReconciliationRepository')) return load('src/repositories/PublicTicketReconciliationRepository.js');
        if (name.endsWith('/PublicTicketPaymentReceiptRepository')) return load('src/repositories/PublicTicketPaymentReceiptRepository.js');
        if (name.endsWith('/EmailService')) return { async sendPublicBookingConfirmationEmail(booking) {
            emails.push(booking);
            if (emailFails) throw new Error('Fixture email failure');
        } };
        if (name.endsWith('/PublicTicketService') || name.endsWith('/PublicTicketPaymentService')
            || name.endsWith('/PublicTicketAdminReleaseService') || name.endsWith('/TicketSeatAdminRepository')) return {};
    } });
    f.seat();
    const created = await f.book({ bookingType, registrantId: 'winner',
        selectedSeatIds: selected ? ['seat-1'] : [], addOnIds: selected ? ['seat_selection_performer'] : [] });
    assert.ifError(created.error);
    const id = created.result.bookingId;
    const booking = () => f.records.get(`publicBookings/${id}`);
    const capacity = () => f.records.get(`ticketCapacity/${booking().capacityReservation.capacityId}`);
    if (released) {
        f.advance(31 * 60 * 1000);
        await f.timers[0]();
        assert.equal(booking().paymentStatus, 'expired');
    } else {
        // Production-shaped partial expiry: the seat rows were made available, while
        // canonical ownership and paid-capacity demand were left untouched.
        booking().paymentStatus = 'expired';
        const seat = f.records.get('seatsAPCS2026/seat-1');
        Object.assign(seat, { status: 'available', lockedByBookingId: null, lockedAt: null });
    }
    const receiptId = f.repo.safeDocumentId(`${id}|${booking().invoiceId}`);
    const receiptKey = `ticketPaymentReceipts/${receiptId}`;
    f.seed(receiptKey, { bookingId: id, providerInvoiceId: booking().invoiceId,
        status: 'needs_review', reason: 'booking_canceled_before_payment', attempts: 1,
        payload: { invoice: { id: booking().invoiceId, number: id, amount: booking().totalAmount, status: 'paid' } } });
    booking().paymentReceipt = { receiptId, status: 'needs_review', reason: 'booking_canceled_before_payment' };
    const input = { bookingId: id, eventId: booking().eventId, invoiceId: booking().invoiceId, receiptId,
        amount: booking().totalAmount, seatIds: selected ? ['seat-1'] : [], confirmedPaid: true, note: 'Verified in Paper.id' };
    const repo = f.load('src/repositories/PublicTicketReconciliationRepository.js');
    const recover = (overrides = {}, user = actor) => repo.reconcileVerifiedExpiredBooking({ ...input, ...overrides }, user);
    const controller = f.load('src/controllers/PublicTicketController.js');
    const request = async () => {
        const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
        await controller.reconcileExpiredPayment({ body: input, ticketingAdmin: actor }, res, error => { throw error; });
        return res;
    };
    return { ...f, id, input, booking, capacity, recover, request, emails, receiptKey,
        chair: () => f.records.get('seatsAPCS2026/seat-1'),
        ownerKey: () => 'ticketSeatOwnership/' + f.repo.safeDocumentId(f.repo.physicalSeatKey('APCS2026', f.records.get('seatsAPCS2026/seat-1'))) };
}
const snapshot = f => JSON.stringify([...f.records]);
async function refusesWithoutWrites(f, overrides = {}, expression = /./, user = actor) {
    const before = snapshot(f);
    await assert.rejects(f.recover(overrides, user), expression);
    assert.equal(snapshot(f), before, 'Rejected recovery must change no booking, seat, capacity or receipt');
}

for (const released of [false, true]) {
    test(`LATE PAYMENT: ${released ? 'fully canceled' : 'partial legacy expiry'} restores original places exactly once`, async () => {
        const f = await fixture({ released });
        f.seat('same-chair-alias');
        f.seat('other-session', { sessionId: '2026-11-01_10:00-11:00' });
        const untouched = JSON.stringify(f.records.get('seatsAPCS2026/other-session'));
        const result = await f.recover();
        assert.equal(result.alreadyPaid, false);
        assert.equal(f.booking().paymentStatus, 'PAID');
        assert.equal(f.booking().amountPaid, f.input.amount);
        assert.equal(f.booking().paymentReconciliation.reconciledByUid, actor.uid);
        assert.equal(f.booking().paymentReconciliation.recoveredFromStatus, 'expired');
        assert.equal(f.booking().paymentReconciliation.previousReceiptReason, 'booking_canceled_before_payment');
        assert.equal(f.capacity().reservedByTier.presto, 1);
        assert.equal(f.chair().status, 'booked');
        assert.equal(f.chair().bookingId, f.id);
        assert.equal(f.chair().lockedByBookingId, undefined);
        assert.equal(f.records.get('seatsAPCS2026/same-chair-alias').bookingId, f.id);
        assert.equal(f.records.get(f.ownerKey()).status, 'booked');
        assert.equal(f.records.get(f.ownerKey()).active, true);
        assert.equal(f.records.get(f.receiptKey).status, 'processed');
        assert.equal(f.booking().paymentReceipt.reason, 'admin_reconciled');
        assert.equal(JSON.stringify(f.records.get('seatsAPCS2026/other-session')), untouched);
        const once = snapshot(f);
        assert.equal((await f.recover()).alreadyPaid, true);
        assert.equal(snapshot(f), once, 'Replay performs no write');
        assert.equal(f.emails.length, 0, 'The repository never dispatches external effects');
    });
}

test('LATE PAYMENT: public competition and purchases without selected seats use the original ticket entitlement', async () => {
    const f = await fixture({ released: true, selected: false, bookingType: 'public_competition' });
    await f.recover();
    assert.equal(f.booking().paymentStatus, 'PAID');
    assert.equal(f.booking().selectedSeatIds.length, 0);
    assert.equal(f.capacity().reservedByTier.presto, 1);
    assert.equal(f.chair().status, 'available');
});

for (const field of ['eventId', 'invoiceId', 'receiptId', 'amount', 'seatIds']) {
    test(`LATE PAYMENT: rejects changed or stale ${field}`, async () => {
        const f = await fixture();
        await refusesWithoutWrites(f, { [field]: field === 'amount' ? f.input.amount + 1 : field === 'seatIds' ? [] : 'changed' }, /changed/);
    });
}

test('LATE PAYMENT: requires explicit full-payment verification and authenticated actor', async () => {
    const f = await fixture();
    for (const confirmedPaid of [false, undefined, 'true']) await refusesWithoutWrites(f, { confirmedPaid }, /Confirm/);
    await refusesWithoutWrites(f, {}, /authentication/, {});
    await refusesWithoutWrites(f, { note: 'x'.repeat(501) }, /Confirm/);
    await refusesWithoutWrites(f, { seatIds: ['seat-1', 'seat-1'] }, /Confirm/);
});

for (const change of [
    b => { b.paymentStatus = 'pending'; }, b => { b.paymentStatus = 'archived_test'; },
    b => { b.ticketingVersion = 1; }, b => { b.paymentMode = 'manual'; },
    b => { b.seatingMode = 'free'; }, b => { b.complimentaryTickets = 1; },
    b => { b.paymentReceipt.reason = 'invoice_mismatch'; },
]) {
    test(`LATE PAYMENT: refuses unsupported scope ${change.toString()}`, async () => {
        const f = await fixture(); change(f.booking()); await refusesWithoutWrites(f, {}, /Only expired/);
    });
}

for (const change of [
    r => { r.providerInvoiceId = 'wrong'; }, r => { r.bookingId = 'wrong'; },
    r => { r.payload.invoice.number = 'wrong'; }, r => { r.payload.invoice.status = 'pending'; },
    r => { r.payload.invoice.amount = 1; }, r => { r.payload.invoice.total_amount = 1; },
    r => { r.payload.invoice.currency = 'USD'; }, r => { r.status = 'pending'; },
]) {
    test(`LATE PAYMENT: rejects mismatched receipt ${change.toString()}`, async () => {
        const f = await fixture(); change(f.records.get(f.receiptKey)); await refusesWithoutWrites(f, {}, /receipt/);
    });
}

for (const status of ['locked', 'booked', 'reserved', 'blocked']) {
    test(`LATE PAYMENT: a ${status} original seat stops recovery`, async () => {
        const f = await fixture(); Object.assign(f.chair(), { status, bookingId: 'another-customer' });
        await refusesWithoutWrites(f, {}, /held, booked or blocked/);
    });
}
test('LATE PAYMENT: active foreign canonical ownership and blocked aliases stop recovery', async () => {
    const f = await fixture(); f.records.get(f.ownerKey()).bookingId = 'another-customer';
    await refusesWithoutWrites(f, {}, /owned or blocked/);
    const g = await fixture(); g.seat('old-alias', { status: 'blocked' });
    await refusesWithoutWrites(g, {}, /held, booked or blocked/);
});
test('LATE PAYMENT: active booking references protect a chair even when its seat/ownership records are stale', async () => {
    const f = await fixture();
    f.seed('publicBookings/other-customer', { eventId: 'APCS2026', venue: 'V1', date: '2026-11-01', session: '09:00-10:00',
        paymentStatus: 'PAID', tickets: [{ id: 'presto', quantity: 1 }], selectedSeatIds: ['seat-1'] });
    await refusesWithoutWrites(f, {}, /Another active booking/);
});
test('LATE PAYMENT: missing seats or changed session/layout refuse atomically', async () => {
    const f = await fixture(); f.records.delete('seatsAPCS2026/seat-1'); await refusesWithoutWrites(f, {}, /no longer exists/);
    const g = await fixture(); g.records.get('events/APCS2026').venues[0].sessions = {}; await refusesWithoutWrites(g, {}, /session/);
    const h = await fixture(); h.records.get('events/APCS2026').venues[0].seatConfig[0].row = 'C';
    await refusesWithoutWrites(h, {}, /layout/);
});
test('LATE PAYMENT: unexplained capacity drift refuses instead of silently overwriting other demand', async () => {
    const f = await fixture(); f.capacity().reservedByTier.presto = 4; await refusesWithoutWrites(f, {}, /counter differs/);
});

function seedRetainedExpiredHold(f) {
    const seatIds = ['retained-7', 'retained-8'];
    seatIds.forEach((id, index) => {
        // Legacy expiry made aliases available but left canonical ownership active.
        f.seat(id, { number: index + 7, seatLabel: `A${index + 7}`, status: 'available' });
        const key = f.repo.physicalSeatKey('APCS2026', f.records.get(`seatsAPCS2026/${id}`));
        f.seed('ticketSeatOwnership/' + f.repo.safeDocumentId(key), {
            eventId: 'APCS2026', physicalSeatKey: key, bookingId: 'other-expired', seatId: id,
            active: true, status: 'locked',
        });
    });
    const booking = { eventId: 'APCS2026', venue: 'V1', date: '2026-11-01', session: '09:00-10:00',
        paymentStatus: 'expired', expiry: { invoiceCancellationStatus: 'failed' },
        selectedSeatIds: seatIds, physicalSeatKeys: seatIds.map(id =>
            f.repo.physicalSeatKey('APCS2026', f.records.get(`seatsAPCS2026/${id}`))),
        tickets: [{ id: 'presto', quantity: 2 }],
        capacityReservation: { capacityId: f.booking().capacityReservation.capacityId, byTier: { presto: 2 } } };
    f.seed('publicBookings/other-expired', booking);
    return { booking: () => f.records.get('publicBookings/other-expired'), seatIds,
        owners: () => booking.physicalSeatKeys.map(key => f.records.get('ticketSeatOwnership/' + f.repo.safeDocumentId(key))) };
}

for (const released of [true, false]) {
    test(`LATE PAYMENT: no-seat recovery preserves another expired two-chair hold; target released=${released}`, async () => {
        const f = await fixture({ released, selected: false, bookingType: 'public_competition' });
        const hold = seedRetainedExpiredHold(f);
        f.capacity().reservedByTier.presto = released ? 2 : 3;
        const before = new Map([...f.records].map(([key, value]) => [key, JSON.stringify(value)]));
        await f.recover();
        assert.equal(f.booking().paymentStatus, 'PAID');
        assert.equal(f.capacity().reservedByTier.presto, 3);
        assert.equal(f.booking().selectedSeatIds.length, 0);
        for (const [key, value] of before) if (![ `publicBookings/${f.id}`, f.receiptKey,
            `ticketCapacity/${f.booking().capacityReservation.capacityId}` ].includes(key)) {
            assert.equal(JSON.stringify(f.records.get(key)), value, `${key} is preserved`);
        }
        assert.equal(hold.booking().paymentStatus, 'expired');
        assert.ok(hold.owners().every(owner => owner.active && owner.bookingId === 'other-expired'));
        const once = snapshot(f); await f.recover(); assert.equal(snapshot(f), once);
    });
}

test('LATE PAYMENT: retained expired holds still count toward the layout ceiling', async () => {
    const f = await fixture({ released: true, selected: false }); seedRetainedExpiredHold(f);
    f.records.get('events/APCS2026').venues[0].seatConfig[0].seatCount = 8;
    f.seed('publicBookings/other-paid', { eventId: 'APCS2026', venue: 'V1', date: '2026-11-01', session: '09:00-10:00',
        paymentStatus: 'PAID', tickets: [{ id: 'presto', quantity: 6 }] });
    f.capacity().reservedByTier.presto = 8;
    await refusesWithoutWrites(f, {}, /insufficient valid capacity/);
});

test('LATE PAYMENT: expired reservations with released ownership are not counted again', async () => {
    const f = await fixture({ released: true, selected: false }); const hold = seedRetainedExpiredHold(f);
    hold.owners().forEach(owner => { owner.active = false; owner.status = 'released'; });
    f.capacity().reservedByTier.presto = 0;
    await f.recover(); assert.equal(f.capacity().reservedByTier.presto, 1);
});

test('LATE PAYMENT: reassigned chairs count only their current active booking', async () => {
    const f = await fixture({ released: true, selected: false }); const hold = seedRetainedExpiredHold(f);
    hold.owners().forEach(owner => { owner.bookingId = 'current-buyer'; });
    f.seed('publicBookings/current-buyer', { ...hold.booking(), paymentStatus: 'PAID' });
    f.capacity().reservedByTier.presto = 2;
    const owners = JSON.stringify(hold.owners());
    await f.recover();
    assert.equal(f.capacity().reservedByTier.presto, 3);
    assert.equal(JSON.stringify(hold.owners()), owners);
});

for (const [name, change] of [
    ['partial ownership', (f, hold) => { hold.owners()[1].active = false; }],
    ['wrong capacity scope', (f, hold) => { hold.booking().capacityReservation.capacityId = 'other-session'; }],
    ['wrong reservation quantities', (f, hold) => { hold.booking().capacityReservation.byTier.presto = 1; }],
    ['unselected remainder', (f, hold) => { hold.booking().tickets[0].quantity = 3; hold.booking().capacityReservation.byTier.presto = 3; }],
    ['mismatched chair', (f, hold) => { f.records.get(`seatsAPCS2026/${hold.seatIds[0]}`).number = 9; }],
    ['invalid ticket quantity', (f, hold) => { hold.booking().tickets[0].quantity = -1; }],
    ['foreign owner event', (f, hold) => { hold.owners()[0].eventId = 'other-event'; }],
    ['unknown owner state', (f, hold) => { hold.owners()[0].status = 'released'; }],
    ['missing original chair', (f, hold) => { f.records.delete(`seatsAPCS2026/${hold.seatIds[0]}`); }],
    ['duplicate selected chair', (f, hold) => { hold.booking().selectedSeatIds[1] = hold.seatIds[0]; }],
]) {
    test(`LATE PAYMENT: ${name} cannot justify another expired reservation`, async () => {
        const f = await fixture({ released: true, selected: false }); const hold = seedRetainedExpiredHold(f);
        f.capacity().reservedByTier.presto = 2; change(f, hold);
        await refusesWithoutWrites(f);
    });
}

test('LATE PAYMENT: an unproven no-seat expired hold does not explain counter drift', async () => {
    const f = await fixture({ released: true, selected: false }); const hold = seedRetainedExpiredHold(f);
    Object.assign(hold.booking(), { selectedSeatIds: [], physicalSeatKeys: [] });
    f.capacity().reservedByTier.presto = 2;
    await refusesWithoutWrites(f, {}, /counter differs/);
});

test('LATE PAYMENT: verified holds do not excuse additional unexplained drift', async () => {
    const f = await fixture({ released: true, selected: false }); seedRetainedExpiredHold(f);
    f.capacity().reservedByTier.presto = 4;
    await refusesWithoutWrites(f, {}, /counter differs/);
});

test('LATE PAYMENT: retained-hold reads are bounded before any inventory write', async () => {
    const f = await fixture({ released: true, selected: false }); const hold = seedRetainedExpiredHold(f);
    hold.booking().physicalSeatKeys = Array.from({ length: 401 }, (_, index) => `original-chair-${index}`);
    await refusesWithoutWrites(f, {}, /Other expired booking inventory/);
});

test('LATE PAYMENT: existing customers and operational blocks retain capacity', async () => {
    const f = await fixture({ released: true });
    const other = await f.book({ bookingType: 'public_competition', registrantId: 'winner', tickets: [{ id: 'presto', quantity: 2 }] });
    assert.ifError(other.error);
    f.seat('blocked-chair', { number: 2, seatLabel: 'A2', status: 'blocked' });
    f.capacity().blockedByTier = { presto: 1 };
    const otherBefore = JSON.stringify(f.records.get(`publicBookings/${other.result.bookingId}`));
    await f.recover();
    assert.equal(f.capacity().reservedByTier.presto, 3);
    assert.equal(f.capacity().blockedByTier.presto, 1);
    assert.equal(JSON.stringify(f.records.get(`publicBookings/${other.result.bookingId}`)), otherBefore);
    assert.equal(f.records.get('seatsAPCS2026/blocked-chair').status, 'blocked');
});
test('LATE PAYMENT: restored demand cannot exceed the configured layout after blocks', async () => {
    const f = await fixture({ released: true });
    const event = f.records.get('events/APCS2026'); event.venues[0].seatConfig[0].seatCount = 1;
    f.seed('publicBookings/full-capacity', { eventId: 'APCS2026', venue: 'V1', date: '2026-11-01', session: '09:00-10:00',
        paymentStatus: 'PAID', tickets: [{ id: 'presto', quantity: 1 }] });
    f.capacity().reservedByTier.presto = 1;
    await refusesWithoutWrites(f, {}, /insufficient/);
});

for (const emailFails of [false, true]) {
    test(`LATE PAYMENT: controller commits recovery and attempts confirmation once; email failure=${emailFails}`, async () => {
        const f = await fixture({ emailFails });
        const first = await f.request();
        assert.equal(first.statusCode, 200);
        assert.equal(first.body.paymentStatus, 'PAID');
        assert.equal(first.body.emailSent, !emailFails);
        assert.equal(f.booking().emailSent, !emailFails);
        assert.equal(f.emails.length, 1);
        assert.equal(f.emails[0].paymentStatus, 'PAID');
        assert.equal((await f.request()).body.alreadyPaid, true);
        assert.equal(f.emails.length, 1, 'Retry never sends another confirmation');
        assert.equal(f.capacity().reservedByTier.presto, 1);
    });
}
test('LATE PAYMENT: the route uses the existing verified-token and whitelist middleware', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    assert.match(routes, /router\.post\('\/public-ticket\/admin\/reconcile-expired-payment', requireTicketingAdmin, PublicTicketController\.reconcileExpiredPayment\)/);
});

test('LATE PAYMENT: three-chair production-shaped recovery keeps all 16 Presto places counted once', async () => {
    const f = await fixture();
    f.records.delete(f.ownerKey());
    const event = f.records.get('events/APCS2026');
    event.venues[0].seatConfig = [{ row: 'A', seatCount: 48, areaType: 'presto' }, { row: 'B', seatCount: 28, areaType: 'allegro' }];
    const seatIds = ['seat-1', 'seat-2', 'seat-3'];
    seatIds.forEach((id, index) => {
        f.seat(id, { number: index + 5, seatLabel: `A${index + 5}` });
        const key = f.repo.physicalSeatKey('APCS2026', f.records.get(`seatsAPCS2026/${id}`));
        f.seed('ticketSeatOwnership/' + f.repo.safeDocumentId(key), { eventId: 'APCS2026', physicalSeatKey: key,
            bookingId: f.id, seatId: id, active: true, status: 'locked' });
    });
    Object.assign(f.booking(), { selectedSeatIds: seatIds, performanceSeatLabels: ['A5', 'A6', 'A7'],
        physicalSeatKeys: seatIds.map(id => f.repo.physicalSeatKey('APCS2026', f.records.get(`seatsAPCS2026/${id}`))),
        tickets: [{ id: 'presto', quantity: 3 }], totalAmount: 2487000 });
    f.booking().capacityReservation.byTier = { presto: 3 };
    f.records.get(f.receiptKey).payload.invoice.amount = 2487000;
    Object.assign(f.input, { seatIds, amount: 2487000 });
    f.seed('publicBookings/existing-paid-demand', { eventId: 'APCS2026', venue: 'V1', date: '2026-11-01', session: '09:00-10:00',
        paymentStatus: 'PAID', tickets: [{ id: 'presto', quantity: 13 }, { id: 'allegro', quantity: 15 }] });
    for (let number = 9; number < 24; number++) f.seat(`block-${number}`, { number, seatLabel: `A${number}`, status: 'blocked' });
    f.capacity().reservedByTier = { presto: 16, allegro: 15 };
    f.capacity().blockedByTier = { presto: 15 };
    await f.recover();
    assert.equal(JSON.stringify(f.capacity().reservedByTier), JSON.stringify({ presto: 16, allegro: 15 }));
    assert.equal(f.capacity().blockedByTier.presto, 15);
    for (const id of seatIds) assert.equal(f.records.get(`seatsAPCS2026/${id}`).bookingId, f.id);
    assert.equal(f.booking().amountPaid, 2487000);
    assert.equal(JSON.stringify(f.booking().performanceSeatLabels), JSON.stringify(['A5', 'A6', 'A7']));
});

test('LATE PAYMENT: later genuine callback replay does not change capacity or send another confirmation', async () => {
    const f = await fixture(); await f.request();
    const service = f.load('src/services/PublicTicketPaymentService.js');
    const receipt = f.records.get(f.receiptKey);
    const outcome = await service.handlePublicBookingPaidCallback(f.id, f.booking(), receipt.payload);
    assert.equal(outcome.statusCode, 200);
    assert.equal(outcome.body.status, 'OK');
    assert.equal(f.emails.length, 1);
    assert.equal(f.capacity().reservedByTier.presto, 1);
    assert.equal(f.booking().paymentReceipt.reason, 'admin_reconciled');
    assert.equal(f.records.get(f.receiptKey).deliveryCount, 2);
});

test('LATE PAYMENT: recovery restores the standard admission allowance without creating a redemption', async () => {
    const f = await fixture();
    const model = require('../src/services/TicketRedemptionModel');
    const event = f.records.get('events/APCS2026');
    const expired = model.allowancesFor({ id: f.id, ...f.booking() }, event, null);
    assert.match(expired[0].blockedReason, /Payment is not confirmed/);
    await f.recover();
    const recovered = model.allowancesFor({ id: f.id, ...f.booking() }, event, null);
    const performance = recovered.find(item => item.channel === 'performance');
    assert.equal(performance.blockedReason, null);
    assert.equal(performance.quantities.presto, 1);
    assert.equal([...f.records.keys()].some(key => key.startsWith('ticketRedemptions/')), false);
});

const uiSource = fs.readFileSync(path.join(__dirname, '../../apcs_web/src/Pages/AdminDashboard/ExpiredPaymentRecovery.js'), 'utf8');
const helpers = uiSource.slice(uiSource.indexOf('export const canRecoverExpiredPayment'), uiSource.indexOf('const ExpiredPaymentRecovery ='))
    .replace(/export /g, '');
function modalFixture({ confirmed = true, failure, acknowledgement = { alreadyPaid: false, emailSent: true }, deferred, refreshFails = false } = {}) {
    const booking = { id: 'booking-1', eventId: 'APCS2026', invoiceId: 'invoice-1', totalAmount: 2487000,
        selectedSeatIds: ['A5', 'A6', 'A7'], paymentReceipt: { receiptId: 'receipt-1' } };
    const state = { booking, confirmed, error: '', saving: false, busy: false, calls: [], notices: [], refreshes: 0 };
    const ctx = { reviewBooking: booking, confirmed, note: ' Verified payment ', disabled: false, inFlight: { current: false },
        setSaving: value => { state.saving = value; }, setError: value => { state.error = value; },
        setReviewBooking: value => { state.booking = value; }, onBusyChange: value => { state.busy = value; },
        onRecovered: async () => { state.refreshes++; if (refreshFails) throw new Error('Refresh failed'); },
        message: Object.fromEntries(['info', 'success', 'warning'].map(level => [level, text => state.notices.push({ level, text })])),
        apis: { publicTicket: { reconcileExpiredPayment: async input => {
            state.calls.push(input); if (deferred) await deferred; if (failure) throw new Error(failure); return acknowledgement;
        } } } };
    const start = uiSource.indexOf('    const handleRecover = async');
    const end = uiSource.indexOf('\n    return (', start);
    vm.runInNewContext(`${helpers}\n${uiSource.slice(start, end)}\nthis.submit = handleRecover;`, ctx);
    return { state, submit: ctx.submit, ctx };
}
test('LATE PAYMENT UI: requires verification, submits original saved details, closes and refreshes on success', async () => {
    const unverified = modalFixture({ confirmed: false }); await unverified.submit(); assert.equal(unverified.state.calls.length, 0);
    const f = modalFixture(); await f.submit();
    assert.equal(f.state.calls.length, 1);
    assert.equal(f.state.calls[0].invoiceId, 'invoice-1');
    assert.equal(f.state.calls[0].amount, 2487000);
    assert.equal(JSON.stringify(f.state.calls[0].seatIds), JSON.stringify(['A5', 'A6', 'A7']));
    assert.equal(f.state.calls[0].note, 'Verified payment');
    assert.equal(f.state.booking, null);
    assert.equal(f.state.refreshes, 1);
    assert.equal(f.state.busy, false);
});
test('LATE PAYMENT UI: double submit makes one request; conflicts keep the review open and restore controls', async () => {
    let finish; const deferred = new Promise(resolve => { finish = resolve; });
    const f = modalFixture({ deferred }); const first = f.submit(); await f.submit();
    assert.equal(f.state.calls.length, 1); assert.equal(f.state.busy, true); finish(); await first;
    const g = modalFixture({ failure: 'Original seat is blocked. Stop for staff review.' });
    await g.submit(); assert.ok(g.state.booking); assert.match(g.state.error, /blocked/);
    assert.equal(g.state.saving, false); assert.equal(g.state.busy, false); assert.equal(g.state.refreshes, 0);
});
for (const acknowledgement of [{ alreadyPaid: true, emailSent: true }, { alreadyPaid: false, emailSent: false }, { alreadyPaid: false, emailSent: null }]) {
    test(`LATE PAYMENT UI: communicates duplicate/failed/uncertain email outcome ${JSON.stringify(acknowledgement)}`, async () => {
        const f = modalFixture({ acknowledgement }); await f.submit();
        assert.notEqual(f.state.notices[0].level, 'success');
        assert.match(f.state.notices[0].text, /Email Status|Resend/);
        assert.equal(f.state.booking, null);
    });
}
test('LATE PAYMENT UI: refresh failure never reports committed payment as failed', async () => {
    const f = modalFixture({ refreshFails: true }); await f.submit();
    assert.equal(f.state.error, ''); assert.match(f.state.notices[1].text, /Payment is confirmed/);
});
test('LATE PAYMENT UI: eligibility hides recovery for normal paid/pending/manual/documentation records', () => {
    const ctx = {}; vm.runInNewContext(`${helpers}\nthis.eligible = canRecoverExpiredPayment;`, ctx);
    const record = { paymentStatus: 'expired', paymentMode: 'paper_id', ticketingVersion: 2, seatingMode: 'numbered',
        bookingType: 'winner', paymentReceipt: { status: 'needs_review', reason: 'booking_canceled_before_payment' } };
    assert.equal(ctx.eligible(record), true);
    for (const override of [{ paymentStatus: 'PAID' }, { paymentStatus: 'pending' }, { paymentMode: 'manual' },
        { ticketingVersion: 1 }, { seatingMode: 'free' }, { bookingType: undefined }, { paymentReceipt: {} }]) {
        assert.equal(ctx.eligible({ ...record, ...override }), false);
    }
});

function apiFixture({ token = 'staff-token', failure, acknowledgement } = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../apcs_web/src/apis/index.js'), 'utf8');
    const auth = source.slice(source.indexOf('const ticketingAdminOptions ='), source.indexOf('const scoringResultEmailRequest ='));
    const method = source.slice(source.indexOf('    reconcileExpiredPayment: async'), source.indexOf('    releaseBooking:'));
    const calls = [];
    const ctx = { auth: { currentUser: token ? { getIdToken: async () => token } : null }, http: { post: async (...args) => {
        calls.push(args); if (failure) throw failure; return { data: acknowledgement };
    } } };
    vm.runInNewContext(`${auth}\nthis.submit = ({${method}}).reconcileExpiredPayment;`, ctx);
    return { calls, submit: ctx.submit };
}
test('LATE PAYMENT API: verified staff token and acknowledgement are required', async () => {
    const acknowledgement = { bookingId: 'booking-1', paymentStatus: 'PAID', alreadyPaid: false, emailSent: true };
    const f = apiFixture({ acknowledgement }); await f.submit({ bookingId: 'booking-1' });
    assert.equal(f.calls[0][0], '/api/v1/apcs/public-ticket/admin/reconcile-expired-payment');
    assert.equal(f.calls[0][2].headers['auth-token'], 'staff-token');
    const signedOut = apiFixture({ token: null }); await assert.rejects(signedOut.submit({ bookingId: 'booking-1' }), /Sign in/);
    assert.equal(signedOut.calls.length, 0);
    for (const response of [undefined, {}, { ...acknowledgement, bookingId: 'other' }, { ...acknowledgement, paymentStatus: 'expired' }]) {
        await assert.rejects(apiFixture({ acknowledgement: response }).submit({ bookingId: 'booking-1' }), /Refresh/);
    }
});
test('LATE PAYMENT API: conflicts retain explanation; lost acknowledgements require a refresh before retry', async () => {
    await assert.rejects(apiFixture({ failure: { response: { data: { message: 'Seat A5 is already booked.' } } } })
        .submit({ bookingId: 'booking-1' }), /Seat A5/);
    await assert.rejects(apiFixture({ failure: new Error('Network error') }).submit({ bookingId: 'booking-1' }), /Refresh.*Email Status/);
});
