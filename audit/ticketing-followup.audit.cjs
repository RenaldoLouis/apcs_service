// Follow-up review, 8 September 2026. These assertions describe required safety
// behavior. Failures are open findings, not expected-success application tests.
// Offline only: production functions run with the existing in-memory fixture.
// No browser, credentials, gateway calls, or live Firestore access.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fixtureFile = path.join(__dirname, 'public-ticket.audit.cjs');
const source = fs.readFileSync(fixtureFile, 'utf8');
const boundary = source.indexOf("test('CONTROL:");
assert.ok(boundary > 0, 'Existing fixture boundary must remain recognizable');
let fixtureSource = source.slice(0, boundary);
// Expose the fixture DB for executing the actual frontend assignment handler.
assert.ok(fixtureSource.includes('return { records, seed, timestamp'));
fixtureSource = fixtureSource.replace('return { records, seed, timestamp', 'return { db, records, seed, timestamp');
// Permit controlled asynchronous provider acknowledgements. This changes only
// the mock provider hook, not production cancellation/transaction behavior.
assert.ok(fixtureSource.includes('if (options.onCancel) options.onCancel(id);'));
fixtureSource = fixtureSource.replace('if (options.onCancel) options.onCancel(id);', 'if (options.onCancel) await options.onCancel(id);');
const context = { require, __dirname, module: { exports: {} } };
vm.runInNewContext(fixtureSource + '\nmodule.exports = fixture;', context, { filename: fixtureFile });
const fixture = context.module.exports;
const getBooking = (f, result) => f.records.get(`publicBookings/${result.bookingId}`);
const winnerOrder = { registrantId: 'winner', orchestraSessionId: 'orch' };

function addOrchestraSeats(f, count) {
    for (let number = 1; number <= count; number++) {
        f.seat(`orch-${number}`, { sessionId: '2026-11-01_19:00-20:00', number, seatLabel: `A${number}` });
    }
}

function enableOrchestraSelection(f) {
    f.records.get('events/APCS2026').addOns.push({ id: 'seat_selection', name: 'Choose complimentary seats', price: 10000 });
}

test('FOLLOWUP: a repeat winner can select the one remaining per-ticket complimentary seat', async () => {
    const f = fixture();
    enableOrchestraSelection(f);
    addOrchestraSeats(f, 1);
    const first = await f.book(winnerOrder);
    assert.ifError(first.error);
    await f.repo.handlePublicTicketWebhookPaid(first.result.bookingId, {
        invoice: { id: `invoice-${first.result.bookingId}`, total_amount: 150000 },
    });
    const second = await f.book({ ...winnerOrder, addOnIds: ['seat_selection'], orchestraSelectedSeatIds: ['orch-1'] });
    assert.ifError(second.error);
    assert.equal(getBooking(f, second.result).complimentaryTickets, 1);
});

test('FOLLOWUP: a winner paid purchase succeeds with a quota-capped complimentary allowance', async () => {
    const f = fixture();
    f.records.get('events/APCS2026').orchestraSessions[0].complimentaryQuota = 1;
    const booking = await f.book(winnerOrder);
    assert.ifError(booking.error);
    assert.equal(getBooking(f, booking.result).complimentaryTickets, 1);
});

test('FOLLOWUP: complimentary seat IDs cannot exceed entitlement or bypass the selection add-on', async () => {
    const f = fixture();
    addOrchestraSeats(f, 3);
    const booking = await f.book({ ...winnerOrder, orchestraSelectedSeatIds: ['orch-1', 'orch-2', 'orch-3'] });
    assert.ok(booking.error, 'One paid ticket plus one personal bonus must not lock three free seats without the add-on');
});

test('FOLLOWUP: a reused checkout key cannot silently return an invoice for a different cart', async () => {
    const f = fixture();
    const first = await f.book({ idempotencyKey: 'same-attempt' });
    assert.ifError(first.error);
    const changed = await f.book({ idempotencyKey: 'same-attempt', tickets: [{ id: 'presto', name: 'Presto', quantity: 2 }] });
    assert.ok(changed.error, 'Changed cart must be rejected as an idempotency conflict, not receive the one-ticket invoice');
});

test('FOLLOWUP: a retry key for a canceled order cannot return its old invoice as checkout success', async () => {
    const f = fixture();
    const first = await f.book({ idempotencyKey: 'expired-attempt' });
    assert.ifError(first.error);
    f.advance(31 * 60 * 1000);
    await f.timers[0]();
    assert.equal(getBooking(f, first.result).paymentStatus, 'expired');
    const retry = await f.book({ idempotencyKey: 'expired-attempt' });
    // A structured terminal response or explicit conflict can both tell the UI
    // to recover safely; an ordinary response with the canceled URL cannot.
    assert.ok(retry.error || (retry.result?.paymentStatus === 'expired' && !retry.result?.paymentUrl),
        'Canceled booking was returned as successful checkout with a payment URL');
});

test('FOLLOWUP: the physical ownership guard includes existing booked aliases without a ledger', async () => {
    const f = fixture();
    f.seat('old-chair', { status: 'booked', bookingId: 'existing-paid-booking' });
    f.seat('new-alias', { seatLabel: 'A-1' });
    const second = await f.book({ selectedSeatIds: ['new-alias'], addOnIds: ['seat_selection_performer'] });
    assert.ok(second.error, 'A booked legacy alias must block selling the same chair through a new document ID');
});

test('FOLLOWUP: actual staff assignment and public checkout cannot fulfill the same physical chair', async () => {
    const f = fixture();
    f.seat('staff-chair');
    f.seat('public-alias', { seatLabel: 'A-1' });
    const first = await f.book({});
    assert.ifError(first.error);
    await f.repo.handlePublicTicketWebhookPaid(first.result.bookingId, {
        invoice: { id: `invoice-${first.result.bookingId}`, total_amount: 150000 },
    });

    const filename = path.join(__dirname, '../../apcs_web/src/Pages/AdminDashboard/PublicCustomersList.js');
    const pageSource = fs.readFileSync(filename, 'utf8');
    const start = pageSource.indexOf('    const handleAssignSeatsSubmit = ');
    const end = pageSource.indexOf('    const handleMarkPaid = ', start);
    assert.ok(start >= 0 && end > start, 'Actual assignment handler boundary must be recognizable');
    const errors = [];
    const pageContext = {
        db: f.db, selectedBooking: { id: first.result.bookingId }, quantityToAssign: 1,
        selectedNewSeats: [{ id: 'staff-chair', seatLabel: 'A1' }],
        isPaidBooking: booking => String(booking.paymentStatus).toUpperCase() === 'PAID',
        isMasterclassTicket: ticket => ['masterclass', 'master_class'].includes(String(ticket.id).toLowerCase()),
        doc: (db, collection, id) => db.collection(collection).doc(id),
        collection: (db, name) => db.collection(name),
        where: (field, operator, value) => ({ field, operator, value }),
        query: (source, ...constraints) => constraints.reduce((current, constraint) =>
            current.where(constraint.field, constraint.operator, constraint.value), source),
        runTransaction: (db, callback) => db.runTransaction(transaction => callback({
            ...transaction,
            get: async ref => { const snap = await transaction.get(ref); return { ...snap, exists: () => snap.exists }; },
        })),
        setLoading() {}, setIsAssignModalOpen() {}, fetchCustomers() {},
        message: { success() {}, error: error => errors.push(error) }, console: { error() {} },
    };
    vm.runInNewContext(pageSource.slice(start, end) + '\nglobalThis.assign = handleAssignSeatsSubmit;', pageContext, { filename });
    await pageContext.assign();
    assert.deepEqual(errors, []);
    assert.equal(f.records.get('seatsAPCS2026/staff-chair').status, 'booked');
    const second = await f.book({ selectedSeatIds: ['public-alias'], addOnIds: ['seat_selection_performer'] });
    if (!second.error) {
        await f.repo.handlePublicTicketWebhookPaid(second.result.bookingId, {
            invoice: { id: `invoice-${second.result.bookingId}`, total_amount: 160000 },
        });
        assert.equal(getBooking(f, second.result).paymentStatus, 'PAID');
    }
    assert.ok(second.error, 'Staff assignment followed by public alias checkout produced two paid owners of A1');
});

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('FOLLOWUP: overlapping failure cleanup cannot decrement another active booking capacity', async () => {
    const firstReached = deferred();
    const firstAck = deferred();
    let cancellations = 0;
    const f = fixture({ onCancel: async () => {
        const cancellationNumber = ++cancellations;
        if (cancellationNumber === 1) { firstReached.resolve(); await firstAck.promise; }
    } });
    const first = await f.book(winnerOrder);
    assert.ifError(first.error);
    const helper = f.load('src/repositories/PublicTicketFailureRepository.js');
    const cleanupA = helper.failPublicTicketBooking(first.result.bookingId, { reason: 'Controlled checkout recovery' });
    await firstReached.promise;
    const cleanupB = helper.failPublicTicketBooking(first.result.bookingId, { reason: 'Duplicate recovery task' });
    firstAck.resolve();
    await cleanupA;
    const later = await f.book(winnerOrder);
    assert.ifError(later.error);
    const capacityId = getBooking(f, later.result).capacityReservation.capacityId;
    assert.equal(f.records.get(`ticketCapacity/${capacityId}`).reservedByTier.presto, 1);
    await cleanupB;
    assert.equal(cancellations, 1, 'A duplicate cleanup must not submit another provider cancellation while one is pending.');
    assert.deepEqual({
        paidCapacity: f.records.get(`ticketCapacity/${capacityId}`).reservedByTier.presto,
        complimentaryClaimed: f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed,
    }, { paidCapacity: 1, complimentaryClaimed: 2 },
    'Second cleanup released paid capacity and complimentary quota belonging to a different pending booking');
});

test('FOLLOWUP: paid fulfillment rejects a different provider invoice ID', async () => {
    const f = fixture();
    const booking = await f.book({});
    assert.ifError(booking.error);
    await assert.rejects(f.repo.handlePublicTicketWebhookPaid(booking.result.bookingId, {
        invoice: { id: 'not-the-stored-invoice', number: booking.result.bookingId, status: 'paid', total_amount: 150000 },
    }), /invoice|payment/i);
});
