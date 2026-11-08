// Offline production-source transactions; no Firebase credentials, provider calls or emails.
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
const actor = { uid: 'staff', email: 'staff@example.invalid' };
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(options) {
    const f = context.module.exports({ ...options, extraRequire: (name, load) => {
        if (name.endsWith('/PublicTicketRepository')) return load('src/repositories/PublicTicketRepository.js');
        if (name.endsWith('/TicketRedemptionModel')) return load('src/services/TicketRedemptionModel.js');
    } });
    const repo = f.load('src/repositories/TicketSeatAdminRepository.js');
    f.seat('old', { status: 'booked', bookingId: 'paid', assignedTo: { userName: 'Buyer' } });
    f.seat('new', { number: 2, seatLabel: 'A2' });
    const booking = { eventId: 'APCS2026', venue: 'V1', date: '2026-11-01', session: '09:00-10:00',
        paymentStatus: 'PAID', bookingType: 'public_competition', seatingMode: 'numbered',
        tickets: [{ id: 'presto', quantity: 2 }], selectedSeatIds: ['old'], performanceSeatLabels: ['A1'],
        physicalSeatKeys: [f.repo.physicalSeatKey('APCS2026', f.records.get('seatsAPCS2026/old'))],
        buyerName: 'Buyer', userEmail: 'buyer@example.invalid', addOnIds: [], totalAmount: 300000,
        capacityReservation: { capacityId: 'capacity', byTier: { presto: 2 } },
        orchestraAttendanceTickets: 2, emailSent: true, seatAssignments: [{ seatIds: ['old'] }] };
    f.seed('publicBookings/paid', booking);
    f.seed('ticketCapacity/capacity', { reservedByTier: { presto: 2 } });
    f.seed('ticketRedemptions/performance', { revision: 1, redeemed: { presto: 1 } });
    const ownerKey = id => 'ticketSeatOwnership/' + f.repo.safeDocumentId(
        f.repo.physicalSeatKey('APCS2026', f.records.get(`seatsAPCS2026/${id}`)));
    f.seed(ownerKey('old'), { bookingId: 'paid', status: 'booked', active: true });
    return { ...f, adminSeats: repo, ownerKey, booking: () => f.records.get('publicBookings/paid'),
        change: (overrides = {}, staff = actor) => repo.reassignPaidBookingSeats({
            bookingId: 'paid', seatIds: ['new'], expectedSeatIds: ['old'], ...overrides,
        }, staff) };
}
async function rejectsWithoutWrites(f, pattern, overrides, staff) {
    const before = plain([...f.records]);
    await assert.rejects(f.change(overrides, staff), pattern);
    assert.deepEqual(plain([...f.records]), before, 'Rejection must not release or book any chair');
}

test('staff change releases old chairs and aliases, books replacements, and preserves all other booking state', async () => {
    const f = fixture();
    f.seat('old-alias', { status: 'booked', bookingId: 'paid' });
    f.seat('new-alias', { number: 2, seatLabel: 'A2' });
    f.booking().physicalSeatKeys.push('historical-orchestra-key');
    const original = plain(f.booking());
    const result = await f.change();
    assert.equal(result.changed, true);
    assert.deepEqual(plain(result.seatIds), ['new']);
    for (const id of ['old', 'old-alias']) {
        const seat = f.records.get('seatsAPCS2026/' + id);
        assert.equal(seat.status, 'available');
        assert.equal(seat.bookingId, undefined);
        assert.equal(seat.assignedTo, undefined);
    }
    for (const id of ['new', 'new-alias']) {
        const seat = f.records.get('seatsAPCS2026/' + id);
        assert.equal(seat.status, 'booked');
        assert.equal(seat.bookingId, 'paid');
        assert.equal(seat.assignedTo.userEmail, original.userEmail);
    }
    assert.equal(f.records.get(f.ownerKey('old')).active, false);
    assert.equal(f.records.get(f.ownerKey('old')).bookingId, undefined);
    assert.equal(f.records.get(f.ownerKey('new')).bookingId, 'paid');
    assert.deepEqual(plain(f.booking().selectedSeatIds), ['new']);
    assert.deepEqual(plain(f.booking().performanceSeatLabels), ['A2']);
    assert.equal(f.booking().physicalSeatKeys[1], 'historical-orchestra-key');
    assert.equal(f.booking().seatChanges[0].changedByEmail, actor.email);
    assert.deepEqual(plain(f.booking().seatChanges[0].previousSeatLabels), ['A1']);
    for (const [key, value] of Object.entries(original)) {
        if (['selectedSeatIds', 'performanceSeatLabels', 'physicalSeatKeys'].includes(key)) continue;
        assert.deepEqual(plain(f.booking()[key]), value, key + ' is unchanged');
    }
    assert.equal(f.records.get('ticketCapacity/capacity').reservedByTier.presto, 2);
    assert.equal(f.records.get('ticketRedemptions/performance').revision, 1);
    assert.equal(f.invoices.length, 0);
});

for (const addOn of ['seat_selection_performer', 'seat_selection']) {
    test(`seat-selection add-on ${addOn} is rejected even in a direct API request`, async () => {
        const f = fixture(); f.booking().addOnIds = [addOn];
        await rejectsWithoutWrites(f, /seat-selection add-on/);
    });
}
for (const patch of [{ paymentStatus: 'pending' }, { paymentStatus: 'expired' }, { paymentStatus: 'failed' },
    { seatingMode: 'free' }, { isOrchestra: true }, { isMasterclass: true }, { bookingType: 'public_orchestra' }]) {
    test('ineligible booking rejects: ' + JSON.stringify(patch), async () => {
        const f = fixture(); Object.assign(f.booking(), patch);
        await rejectsWithoutWrites(f, /Only paid numbered competition/);
    });
}

test('original seat snapshot prevents a stale dialog overwriting another assignment', async () => {
    const f = fixture();
    await rejectsWithoutWrites(f, /assigned seats changed/, { expectedSeatIds: ['outdated'] });
});
for (const status of ['booked', 'locked', 'reserved', 'blocked']) {
    test(`${status} replacement chairs cannot be taken`, async () => {
        const f = fixture(); f.records.get('seatsAPCS2026/new').status = status;
        await rejectsWithoutWrites(f, /no longer available/);
    });
}
test('active canonical ownership and stale alias ownership reject available replacements', async () => {
    const f = fixture(); f.seed(f.ownerKey('new'), { bookingId: 'other', active: true });
    await rejectsWithoutWrites(f, /conflicting ownership/);
    const g = fixture(); g.seat('alias', { number: 2, seatLabel: 'A2', bookingId: 'other' });
    await rejectsWithoutWrites(g, /conflicting seat record/);
});
test('old chair ownership conflicts fail before releasing it', async () => {
    const f = fixture(); f.seed(f.ownerKey('old'), { bookingId: 'other', status: 'booked', active: true });
    await rejectsWithoutWrites(f, /conflicting ownership/);
    const g = fixture(); g.seat('alias', { status: 'blocked' });
    await rejectsWithoutWrites(g, /conflicting seat record/);
});
test('missing original canonical owner is reconstructed safely from owned booked chairs', async () => {
    const f = fixture(); f.records.delete(f.ownerKey('old'));
    await f.change();
    assert.equal(f.records.get(f.ownerKey('old')).active, false);
});
for (const patch of [{ venueId: 'other' }, { eventId: 'other' }, { sessionId: 'other' }, { number: 99 }]) {
    test('replacement respects the current session and venue layout: ' + JSON.stringify(patch), async () => {
        const f = fixture(); Object.assign(f.records.get('seatsAPCS2026/new'), patch);
        await rejectsWithoutWrites(f, /session and venue layout/);
    });
}
test('seat count and assigned tier distribution cannot change, even if both tiers were purchased', async () => {
    const f = fixture(); f.seat('extra', { number: 3 });
    await rejectsWithoutWrites(f, /same number of assigned seats/, { seatIds: ['new', 'extra'] });
    const g = fixture(); g.booking().tickets.push({ id: 'lento', quantity: 1 });
    g.seat('new', { row: 'B', areaType: 'lento' });
    await rejectsWithoutWrites(g, /each purchased tier/);
});
test('same physical chair under different document IDs and duplicate IDs cannot be selected', async () => {
    const f = fixture(); f.seat('new');
    await rejectsWithoutWrites(f, /physical seat only once/);
    const g = fixture();
    await rejectsWithoutWrites(g, /original seat selection/, { seatIds: ['new', 'new'] });
});
test('retaining some chairs replaces only the changed ones', async () => {
    const f = fixture(); f.seat('kept', { number: 3, seatLabel: 'A3', status: 'booked', bookingId: 'paid' });
    f.booking().selectedSeatIds.push('kept');
    f.booking().performanceSeatLabels.push('A3');
    const before = plain(f.records.get('seatsAPCS2026/kept'));
    await f.change({ seatIds: ['kept', 'new'], expectedSeatIds: ['old', 'kept'] });
    assert.deepEqual(plain(f.records.get('seatsAPCS2026/kept')), before);
    assert.deepEqual(plain(f.booking().performanceSeatLabels), ['A3', 'A2']);
});
test('unchanged selection is a no-op without an extra history entry', async () => {
    const f = fixture(); const before = plain([...f.records]);
    assert.equal((await f.change({ seatIds: ['old'] })).changed, false);
    assert.deepEqual(plain([...f.records]), before);
});
test('transaction failure rolls back both chair movement and booking changes', async () => {
    const f = fixture(); const before = plain([...f.records]);
    const run = f.db.runTransaction;
    f.db.runTransaction = callback => run(async transaction => { await callback(transaction); throw new Error('Commit failed'); });
    await assert.rejects(f.change(), /Commit failed/);
    assert.deepEqual(plain([...f.records]), before);
});
test('competing requests to one replacement chair let only one booking win', async () => {
    const f = fixture();
    f.seat('other-old', { number: 3, seatLabel: 'A3', status: 'booked', bookingId: 'other' });
    f.seed('publicBookings/other', { ...f.booking(), selectedSeatIds: ['other-old'] });
    let queue = Promise.resolve(); const run = f.db.runTransaction;
    f.db.runTransaction = callback => { const next = queue.then(() => run(callback)); queue = next.catch(() => {}); return next; };
    const results = await Promise.allSettled([f.change(), f.change({ bookingId: 'other', expectedSeatIds: ['other-old'] })]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(f.records.get('seatsAPCS2026/new').bookingId, 'paid');
    assert.equal(f.records.get('seatsAPCS2026/other-old').status, 'booked');
});
test('route requires staff authorization and controller forwards errors', () => {
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    assert.match(route, /router.post\('\/public-ticket\/admin\/reassign-seats', requireTicketingAdmin, PublicTicketController.reassignPaidBookingSeats\)/);
});
test('controller returns the saved selection and forwards repository conflicts without attempting email', async () => {
    const input = { bookingId: 'paid', seatIds: ['new'], expectedSeatIds: ['old'] };
    const module = { exports: {} };
    let received, calls = 0, failure;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/controllers/PublicTicketController.js'), 'utf8'), {
        module, require: name => name.endsWith('/TicketSeatAdminRepository') ? {
            reassignPaidBookingSeats: async (data, staff) => {
                calls++; received = { data, staff };
                if (failure) throw failure;
                return { ...data, changed: true };
            },
        } : {},
    });
    let status, result, forwarded;
    const res = { status: value => { status = value; return res; }, json: value => { result = value; } };
    const req = { body: input, ticketingAdmin: actor };
    await module.exports.reassignPaidBookingSeats(req, res, error => { forwarded = error; });
    assert.equal(status, 200);
    assert.deepEqual(plain(received), { data: input, staff: actor });
    assert.equal(result.changed, true);
    failure = new Error('conflict');
    await module.exports.reassignPaidBookingSeats(req, res, error => { forwarded = error; });
    assert.equal(forwarded, failure);
    assert.equal(calls, 2);
});
test('authentication, malformed selections and removed seats fail without writes', async () => {
    await rejectsWithoutWrites(fixture(), /Admin authentication/, {}, {});
    await rejectsWithoutWrites(fixture(), /original seat selection/, { expectedSeatIds: [] });
    await rejectsWithoutWrites(fixture(), /original seat selection/, { seatIds: ['bad/id'] });
    const f = fixture(); f.records.delete('seatsAPCS2026/old');
    await rejectsWithoutWrites(f, /no longer exists/);
});
test('transaction revalidation catches a paid-state change just before the transaction starts', async () => {
    const f = fixture({ beforeTransaction: ({ records }) => { records.get('publicBookings/paid').paymentStatus = 'expired'; } });
    await assert.rejects(f.change(), /Only paid numbered competition/);
    assert.equal(f.records.get('seatsAPCS2026/old').status, 'booked');
    assert.equal(f.records.get('seatsAPCS2026/new').status, 'available');
});

test('FLOW: Assign Missing Seats still appends correctly after an edit and the booking remains editable', async () => {
    const f = fixture();
    await f.change();
    await f.adminSeats.assignPaidBookingSeats({ bookingId: 'paid', seatIds: ['old'] }, actor);
    assert.deepEqual(plain(f.booking().selectedSeatIds), ['new', 'old']);
    assert.deepEqual(plain(f.booking().performanceSeatLabels), ['A2', 'A1']);
    assert.equal(f.booking().seatAssignments.length, 2);
    assert.equal(f.booking().seatChanges.length, 1);
    assert.equal(f.records.get('ticketCapacity/capacity').reservedByTier.presto, 2);
    f.seat('next', { number: 3, seatLabel: 'A3' });
    await f.change({ expectedSeatIds: ['new', 'old'], seatIds: ['next', 'old'] });
    assert.deepEqual(plain(f.booking().performanceSeatLabels), ['A3', 'A1']);
    assert.equal(f.booking().seatChanges.length, 2);
});

test('FLOW: checkout can claim a released chair but cannot claim its booked replacement', async () => {
    const f = fixture(); await f.change();
    const rejected = await f.book({ selectedSeatIds: ['new'], addOnIds: ['seat_selection_performer'] });
    assert.match(rejected.error.message, /no longer available/);
    const created = await f.book({ selectedSeatIds: ['old'], addOnIds: ['seat_selection_performer'] });
    assert.ifError(created.error);
    assert.equal(f.records.get('seatsAPCS2026/old').lockedByBookingId, created.result.bookingId);
    assert.equal(f.records.get(f.ownerKey('old')).bookingId, created.result.bookingId);
    assert.equal(f.records.get('seatsAPCS2026/new').bookingId, 'paid');
    assert.deepEqual(plain(f.booking().selectedSeatIds), ['new']);
});

test('FLOW: duplicate paid callback cannot restore the original chairs or mutate the edited booking', async () => {
    const f = fixture(); f.booking().invoiceId = 'invoice-paid';
    await f.change();
    const before = plain([...f.records]);
    const paid = await f.repo.handlePublicTicketWebhookPaid('paid', { invoice: { id: 'invoice-paid', total_amount: 300000 } });
    assert.equal(paid.alreadyPaid, true);
    assert.deepEqual(plain(paid.selectedSeatIds), ['new']);
    assert.deepEqual(plain([...f.records]), before);
});

test('FLOW: redemption keeps the same entitlement and handed-over counts while displaying the new chairs', async () => {
    const f = fixture();
    const model = f.load('src/services/TicketRedemptionModel.js');
    const redemption = f.load('src/repositories/TicketRedemptionRepository.js');
    const input = { eventId: 'APCS2026', bookingId: 'paid' };
    const initial = await redemption.detail(input);
    f.seed('ticketRedemptions/' + model.redemptionId(input.eventId, input.bookingId, 'performance'), {
        revision: 1, redeemed: { presto: 1 }, sessionKey: initial.allowances[0].sessionKey,
    });
    const before = await redemption.detail(input);
    await f.change();
    const after = await redemption.detail(input);
    assert.deepEqual(plain(after.allowances), plain(before.allowances));
    assert.equal(after.allowances[0].remaining.presto, 1);
    assert.deepEqual(plain(after.booking.performanceSeatLabels), ['A2']);
    assert.deepEqual(plain(before.booking.performanceSeatLabels), ['A1']);
});
