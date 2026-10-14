// Offline production-source checks. No real Firestore, invoices, email or browser.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixtureFile = path.join(__dirname, 'public-ticket.audit.cjs');
const source = fs.readFileSync(fixtureFile, 'utf8').split("test('PUBLIC:")[0]
    .replace('return { records, seed, timestamp', 'return { db, records, seed, timestamp');
const context = { require, __dirname, module: { exports: {} } };
vm.runInNewContext(source + '\nmodule.exports = fixture;', context, { filename: fixtureFile });
const actor = { uid: 'staff-1', email: 'staff@example.invalid' };
const scope = { eventId: 'APCS2026', venueId: 'V1', sessionId: '2026-11-01_09:00-10:00' };
const request = { ...scope, seatId: 'seat-1', action: 'block', reason: 'Photographer camera position', expectedRevision: 0 };
function fixture(options = {}) {
    const f = context.module.exports({ ...options, extraRequire: (name, load) =>
        name.endsWith('/PublicTicketRepository') ? load('src/repositories/PublicTicketRepository.js') : undefined });
    f.seat();
    f.adminSeats = f.load('src/repositories/TicketSeatAdminRepository.js');
    f.block = overrides => f.adminSeats.setSeatBlock({ ...request, ...overrides }, actor);
    f.chair = id => f.records.get(`seatsAPCS2026/${id || 'seat-1'}`);
    f.capacityKey = 'ticketCapacity/' + f.repo.capacityDocumentId('APCS2026', 'V1', '2026-11-01', '09:00-10:00');
    f.capacity = () => f.records.get(f.capacityKey);
    return f;
}

test('BLOCK: protects the chair and its legacy alias, keeps other sessions unchanged, and audits removal', async () => {
    const f = fixture();
    f.seat('legacy-alias');
    f.seat('other-session', { sessionId: '2026-11-01_10:00-11:00' });
    const result = await f.block();
    assert.equal(result.status, 'blocked');
    assert.equal(f.chair().seatBlock.reason, request.reason);
    assert.equal(f.chair().seatBlock.blockedByUid, actor.uid);
    assert.equal(f.chair('legacy-alias').status, 'blocked');
    assert.equal(f.chair('other-session').status, 'available');
    assert.equal(f.capacity().blockedByTier.presto, 1, 'Aliases count as one physical chair');
    await f.block({ action: 'unblock', expectedRevision: result.revision });
    assert.equal(f.chair().status, 'available');
    assert.equal(f.chair('legacy-alias').status, 'available');
    assert.equal(f.capacity().blockedByTier.presto, 0);
    assert.equal(f.chair().seatBlock, undefined);
    assert.equal(f.chair().lastSeatBlock.reason, request.reason);
    assert.equal(f.chair().lastSeatBlock.unblockedByEmail, actor.email);
});

for (const status of ['locked', 'booked', 'reserved']) {
    test(`BLOCK: a ${status} chair or alias cannot be overwritten`, async () => {
        const f = fixture();
        f.seat('held-alias', { status, bookingId: 'customer' });
        await assert.rejects(f.block(), /booked, held/);
        assert.equal(f.chair().status, 'available');
        assert.equal(f.chair('held-alias').status, status);
        assert.equal(f.capacity(), undefined, 'Rejected transaction writes nothing');
    });
}

test('BLOCK: canonical active ownership and stale booking pointers protect otherwise available chairs', async () => {
    const f = fixture();
    const key = f.repo.physicalSeatKey('APCS2026', f.chair());
    f.seed('ticketSeatOwnership/' + f.repo.safeDocumentId(key), { bookingId: 'customer', active: true });
    await assert.rejects(f.block(), /ownership changed/);
    assert.equal(f.chair().status, 'available');
    const g = fixture();
    g.chair().lockedByBookingId = 'customer';
    await assert.rejects(g.block(), /booked, held/);
});

test('BLOCK: selected-seat checkout is refused and no invoice is created', async () => {
    const f = fixture();
    await f.block();
    const result = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    assert.match(result.error.message, /no longer available/);
    assert.equal(f.invoices.length, 0);
    assert.equal(f.chair().status, 'blocked');
});

test('BLOCK: tickets without selected seats respect the reduced tier ceiling; unblock restores it', async () => {
    const f = fixture();
    const blocked = await f.block();
    const tooMany = await f.book({ tickets: [{ id: 'presto', quantity: 10 }] });
    assert.match(tooMany.error.message, /capacity remains/);
    assert.equal(f.invoices.length, 0);
    const nine = await f.book({ tickets: [{ id: 'presto', quantity: 9 }] });
    assert.ifError(nine.error);
    assert.equal(f.capacity().blockedByTier.presto, 1, 'Checkout preserves blocked capacity');
    assert.equal(f.capacity().reservedByTier.presto, 9);
    await f.block({ action: 'unblock', expectedRevision: blocked.revision });
    assert.ifError((await f.book()).error);
    assert.equal(f.capacity().reservedByTier.presto, 10);
});

test('BLOCK: fully promised tier capacity protects a chair even before seat assignment', async () => {
    const f = fixture();
    assert.ifError((await f.book({ tickets: [{ id: 'presto', quantity: 10 }] })).error);
    await assert.rejects(f.block(), /needed for existing paid or held/);
    assert.equal(f.chair().status, 'available');
    assert.equal(f.capacity().blockedByTier, undefined);
});

test('BLOCK: missing capacity counters bootstrap paid, pending and unresolved failed bookings only', async () => {
    const f = fixture();
    for (const [id, paymentStatus, quantity, cleanupStatus] of [
        ['paid', 'PAID', 2], ['pending', 'pending', 3], ['uncertain', 'failed', 4, 'held'],
        ['released', 'failed', 40, 'complete'], ['archived', 'archived_test', 50], ['expired', 'expired', 20],
    ]) f.seed('publicBookings/' + id, {
        eventId: 'APCS2026', venue: 'V1', date: '2026-11-01', session: '09:00-10:00',
        paymentStatus, tickets: [{ id: 'presto', quantity }], checkoutFailure: { cleanupStatus },
    });
    await f.block();
    assert.equal(f.capacity().reservedByTier.presto, 9);
    assert.equal(f.capacity().blockedByTier.presto, 1);
    f.seat('seat-2', { number: 2, seatLabel: 'A2' });
    await assert.rejects(f.block({ seatId: 'seat-2' }), /needed for existing paid or held/);
});

test('BLOCK: staff cannot assign a blocked chair to a paid booking', async () => {
    const f = fixture();
    await f.block();
    const purchase = await f.book();
    assert.ifError(purchase.error);
    f.records.get('publicBookings/' + purchase.result.bookingId).paymentStatus = 'PAID';
    await assert.rejects(f.adminSeats.assignPaidBookingSeats({
        bookingId: purchase.result.bookingId, seatIds: ['seat-1'],
    }, actor), /no longer available/);
    assert.equal(f.chair().status, 'blocked');
});

test('BLOCK: legacy confirmation cannot reserve a blocked chair', async () => {
    const f = fixture();
    await f.block();
    f.seed('seatBook2025/legacy-booking', { seatsSelected: false });
    const legacyContext = { module: { exports: {} }, process: { env: {} }, console: { error() {} }, require: name => {
        if (name.endsWith('firebase-init')) return { db: f.db };
        if (name.endsWith('/Logger')) return { logger: { error() {} } };
        return {};
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/repositories/TicketRepository.js'), 'utf8'), legacyContext);
    await assert.rejects(legacyContext.module.exports.confirmSeatSelection({
        eventId: scope.eventId, bookingId: 'legacy-booking', selectedSeatIds: ['seat-1'],
    }), /no longer available/);
    assert.equal(f.chair().status, 'blocked');
});

test('BLOCK: cancellation releases ticket demand without removing operational blocks', async () => {
    const f = fixture();
    await f.block();
    assert.ifError((await f.book({ tickets: [{ id: 'presto', quantity: 9 }] })).error);
    f.advance(31 * 60 * 1000);
    await f.timers[0]();
    assert.equal(f.capacity().reservedByTier.presto, 0);
    assert.equal(f.capacity().blockedByTier.presto, 1);
    assert.equal(f.chair().status, 'blocked');
});

test('BLOCK: regeneration preserves block metadata, status and ownership', async () => {
    const f = fixture();
    await f.block();
    const before = f.chair();
    const result = await f.adminSeats.generateSeatLayout({ ...scope, sessionIds: [scope.sessionId] });
    assert.ok(result.preserved >= 1);
    assert.equal(f.chair().status, 'blocked');
    assert.equal(f.chair().seatBlock.reason, before.seatBlock.reason);
    assert.equal(f.chair().seatBlockRevision, before.seatBlockRevision);
});

test('BLOCK: stale actions cannot remove a newer block or double-count capacity', async () => {
    const f = fixture();
    const first = await f.block();
    await assert.rejects(f.block(), /block changed/);
    const removed = await f.block({ action: 'unblock', expectedRevision: first.revision });
    const second = await f.block({ expectedRevision: removed.revision, reason: 'Equipment' });
    await assert.rejects(f.block({ action: 'unblock', expectedRevision: first.revision }), /block changed/);
    assert.equal(f.chair().seatBlock.reason, 'Equipment');
    assert.equal(f.chair().seatBlockRevision, second.revision);
    assert.equal(f.capacity().blockedByTier.presto, 1);
});

test('BLOCK: regenerating available chairs retains audit and revision, rejecting old unblock dialogs', async () => {
    const f = fixture();
    const generatedId = 'V1-presto-A1_APCS2026_' + scope.sessionId;
    f.records.delete('seatsAPCS2026/seat-1');
    f.seat(generatedId);
    const first = await f.block({ seatId: generatedId });
    const removed = await f.block({ seatId: generatedId, action: 'unblock', expectedRevision: first.revision });
    await f.adminSeats.generateSeatLayout({ ...scope, sessionIds: [scope.sessionId] });
    assert.equal(f.chair(generatedId).seatBlockRevision, removed.revision);
    assert.equal(f.chair(generatedId).lastSeatBlock.reason, request.reason);
    await f.block({ seatId: generatedId, expectedRevision: removed.revision, reason: 'Equipment' });
    await assert.rejects(f.block({ seatId: generatedId, action: 'unblock', expectedRevision: first.revision }), /block changed/);
});

test('BLOCK: route is whitelist protected and controller forwards only validated actor and seat inputs', async () => {
    const routes = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    assert.match(routes, /router\.post\('\/public-ticket\/admin\/seats\/block', requireTicketingAdmin, PublicTicketController\.setSeatBlock\)/);
    const f = fixture();
    const controllerContext = { module: { exports: {} }, require: name => {
        if (name === '../repositories/TicketSeatAdminRepository') return f.adminSeats;
        return {};
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/controllers/PublicTicketController.js'), 'utf8'), controllerContext);
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await controllerContext.module.exports.setSeatBlock({ body: { ...request, actor: { uid: 'spoof' } }, ticketingAdmin: actor },
        res, error => { throw error; });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'blocked');
    assert.equal(f.chair().seatBlock.blockedByUid, actor.uid);
});

test('BLOCK: a checkout that wins before the block transaction is preserved', async () => {
    const f = fixture({ beforeTransaction: ({ seed }) => seed('seatsAPCS2026/seat-1', {
        eventId: 'APCS2026', venueId: 'V1', sessionId: scope.sessionId,
        row: 'A', number: 1, areaType: 'presto', status: 'locked', lockedByBookingId: 'checkout',
    }) });
    await assert.rejects(f.block(), /booked, held/);
    assert.equal(f.chair().lockedByBookingId, 'checkout');
});

test('BLOCK: invalid input, wrong-session seats and free-seating sessions cannot be blocked', async () => {
    const f = fixture();
    for (const override of [{ reason: '   ' }, { reason: 'x'.repeat(501) }, { action: 'delete' },
        { expectedRevision: -1 }, { eventId: '../event' }, { sessionId: '2026-11-01_19:00-20:00' }]) {
        await assert.rejects(f.block(override));
    }
    await assert.rejects(f.adminSeats.setSeatBlock(request), /authentication/);
    assert.equal(f.chair().status, 'available');
});

test('BLOCK: inconsistent ownership or counters prevent unsafe unblocking', async () => {
    const f = fixture();
    const result = await f.block();
    f.capacity().blockedByTier.presto = 0;
    await assert.rejects(f.block({ action: 'unblock', expectedRevision: result.revision }), /reconciliation/);
    assert.equal(f.chair().status, 'blocked');
    f.capacity().blockedByTier.presto = 1;
    f.chair().bookingId = 'late-customer';
    await assert.rejects(f.block({ action: 'unblock', expectedRevision: result.revision }), /booked, held/);
});

test('BLOCK: public seat listing includes unavailable status without exposing staff notes or identity', async () => {
    const f = fixture();
    const result = await f.block();
    let seats;
    await f.repo.getPublicTicketSeats({ venueId: 'V1', sessionId: scope.sessionId }, (error, data) => {
        assert.ifError(error); seats = data;
    });
    assert.equal(seats[0].status, 'blocked');
    assert.equal(seats[0].seatBlock, undefined);
    await f.block({ action: 'unblock', expectedRevision: result.revision });
    await f.repo.getPublicTicketSeats({ venueId: 'V1', sessionId: scope.sessionId }, (error, data) => {
        assert.ifError(error); seats = data;
    });
    assert.equal(seats[0].lastSeatBlock, undefined);
});
