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
    test(`buyer-selected chair with ${addOn} is rejected even in a direct API request`, async () => {
        const f = fixture(); f.booking().addOnIds = [addOn]; f.booking().seatAssignments = [];
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

function upgradeFixture(options) {
    const f = fixture(options);
    f.seat('old', { areaType: 'lento', row: 'B', status: 'booked', bookingId: 'paid', seatLabel: 'B1' });
    f.booking().tickets = [{ id: 'lento', name: 'Lento', quantity: 2, priceEach: 75000 }];
    f.booking().totalAmount = 150000;
    f.booking().performanceSeatLabels = ['B1'];
    f.booking().physicalSeatKeys = [f.repo.physicalSeatKey('APCS2026', f.records.get('seatsAPCS2026/old'))];
    f.seed(f.ownerKey('old'), { bookingId: 'paid', status: 'booked', active: true });
    const capacityId = f.repo.capacityDocumentId('APCS2026', 'V1', '2026-11-01', '09:00-10:00');
    f.seed('ticketCapacity/' + capacityId, { reservedByTier: { lento: 2, presto: 0 }, blockedByTier: {} });
    f.booking().capacityReservation = { capacityId, byTier: { lento: 2 } };
    f.upgrade = (patch = {}, staff = actor) => f.adminSeats.upgradePaidBookingSeat({ bookingId: 'paid',
        fromSeatId: 'old', toSeatId: 'new', expectedSeatIds: ['old'], expectedDifference: 75000, expectedRevision: 0, expectedBalance: 0, ...patch }, staff);
    f.capacity = () => f.records.get('ticketCapacity/' + capacityId);
    f.capacityId = capacityId;
    f.resolve = (patch = {}) => f.adminSeats.resolveSeatUpgradePayment({ bookingId: 'paid', expectedRevision: 1,
        expectedBalance: 75000, ...patch }, actor);
    return f;
}
async function upgradeRejects(f, pattern, patch = {}) {
    const before = plain([...f.records]);
    await assert.rejects(f.upgrade(patch), pattern);
    assert.deepEqual(plain([...f.records]), before);
}
test('UPGRADE: moves one ticket and capacity, records original price and outstanding balance, preserves original payment and other entitlements', async () => {
    const f = upgradeFixture(), original = plain(f.booking());
    const result = await f.upgrade();
    assert.equal(result.difference, 75000);
    assert.equal(f.booking().seatUpgradeBalance, 75000);
    assert.equal(f.booking().seatUpgrades[0].status, 'pending');
    assert.deepEqual(plain(f.booking().tickets), [
        { id: 'lento', name: 'Lento', quantity: 1, priceEach: 75000 },
        { id: 'presto', name: 'Presto', quantity: 1, priceEach: 150000 },
    ]);
    assert.deepEqual(plain(f.capacity().reservedByTier), { lento: 1, presto: 1 });
    assert.deepEqual(plain(f.booking().capacityReservation.byTier), { lento: 1, presto: 1 });
    for (const key of ['totalAmount', 'paymentStatus', 'orchestraAttendanceTickets', 'emailSent']) assert.deepEqual(f.booking()[key], original[key]);
    assert.equal(f.records.get('seatsAPCS2026/old').status, 'available');
    assert.equal(f.records.get('seatsAPCS2026/new').bookingId, 'paid');
    assert.equal(f.booking().seatPriceSnapshots.new, 150000);
    assert.equal(f.invoices.length, 0);
});
test('UPGRADE: same-tier chair change has no extra payment even after event prices change', async () => {
    const f = upgradeFixture();
    f.seat('new', { row: 'B', areaType: 'lento', number: 2, seatLabel: 'B2' });
    f.records.get('events/APCS2026').ticketTiers[1].venuePrices.V1 = 90000;
    await f.upgrade({ expectedDifference: 0 });
    assert.equal(f.booking().seatUpgradeBalance, 0);
    assert.equal(f.booking().seatUpgrades[0].status, 'not_required');
    assert.equal(f.booking().seatPriceSnapshots.new, 75000);
    assert.deepEqual(plain(f.capacity().reservedByTier), { lento: 2, presto: 0 });
});
test('UPGRADE: outside payment resolution records staff and leaves original payment/provider state unchanged', async () => {
    const f = upgradeFixture(); await f.upgrade(); await f.resolve();
    assert.equal(f.booking().seatUpgradeBalance, 0);
    assert.equal(f.booking().seatUpgradeRevision, 2);
    assert.equal(f.booking().seatUpgrades[0].paidByEmail, actor.email);
    assert.equal(f.booking().seatUpgrades[0].paymentMethod, 'outside_system');
    assert.equal(f.booking().totalAmount, 150000);
    assert.equal(f.booking().paymentStatus, 'PAID');
    const before = plain([...f.records]);
    await assert.rejects(f.resolve(), /changed/);
    assert.deepEqual(plain([...f.records]), before);
});
test('UPGRADE: stale quotes/revisions and inconsistent balances never write', async () => {
    let f = upgradeFixture(); await upgradeRejects(f, /price changed/, { expectedDifference: 1 });
    f = upgradeFixture(); await upgradeRejects(f, /upgrade changed/, { expectedRevision: 1 });
    f = upgradeFixture(); f.booking().seatUpgradeBalance = 100;
    await upgradeRejects(f, /balance needs reconciliation/);
});
test('UPGRADE: an empty chair cannot bypass tickets awaiting seats or operational blocks', async () => {
    let f = upgradeFixture(); f.capacity().reservedByTier.presto = 10;
    await upgradeRejects(f, /remaining capacity/);
    f = upgradeFixture(); f.capacity().reservedByTier.presto = 9;
    f.seat('block', { number: 3, seatLabel: 'A3', status: 'blocked' });
    f.capacity().blockedByTier = { presto: 1 };
    await upgradeRejects(f, /remaining capacity/);
});
test('UPGRADE: redeemed source tier cannot be reduced below existing handovers', async () => {
    const f = upgradeFixture();
    const id = encodeURIComponent(JSON.stringify(['APCS2026', 'performance', 'paid']));
    f.seed('ticketRedemptions/' + id, { revision: 1, redeemed: { lento: 2 } });
    await upgradeRejects(f, /already redeemed/);
});
test('UPGRADE: malformed/missing capacity or original prices reject without releasing seats', async () => {
    let f = upgradeFixture(); f.booking().tickets[0].priceEach = undefined;
    await upgradeRejects(f, /original ticket price/);
    f = upgradeFixture(); f.records.delete('ticketCapacity/' + f.capacityId);
    await upgradeRejects(f, /capacity reservation/);
    f = upgradeFixture(); f.booking().capacityReservation.byTier.lento = 3;
    await upgradeRejects(f, /capacity reservation/);
});
test('MIXED: one paid seat-selection chair stays protected while the staff-assigned chair can change', async () => {
    const f = upgradeFixture();
    f.seat('buyer', { row: 'B', areaType: 'lento', number: 3, seatLabel: 'B3', status: 'booked', bookingId: 'paid' });
    f.booking().selectedSeatIds = ['buyer', 'old']; f.booking().addOnIds = ['seat_selection_performer'];
    const options = await f.adminSeats.getSeatChangeOptions({ bookingId: 'paid' }, actor);
    assert.deepEqual(plain(options.seats.map(item => item.id)), ['old']);
    await upgradeRejects(f, /buyer-selected/, { fromSeatId: 'buyer', expectedSeatIds: ['buyer', 'old'] });
    await f.upgrade({ expectedSeatIds: ['buyer', 'old'] });
    assert.deepEqual(plain(f.booking().selectedSeatIds), ['buyer', 'new']);
    assert.equal(f.records.get('seatsAPCS2026/buyer').bookingId, 'paid');
    await f.resolve();
    const next = await f.adminSeats.getSeatChangeOptions({ bookingId: 'paid' }, actor);
    assert.deepEqual(plain(next.seats.map(item => item.id)), ['new']);
    assert.equal(next.seats[0].price, 150000);
});
test('MIXED: original buyer seats remain protected when historical staff provenance is absent', async () => {
    const f = upgradeFixture(); f.booking().addOnIds = ['seat_selection_performer']; f.booking().seatAssignments = [];
    await upgradeRejects(f, /buyer-selected/);
});
test('UPGRADE: current tier price changes invalidate the reviewed quote', async () => {
    const f = upgradeFixture(); f.records.get('events/APCS2026').ticketTiers[0].venuePrices.V1 = 170000;
    await upgradeRejects(f, /price changed/);
});
test('UPGRADE: all new routes require ticketing admin middleware', () => {
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    for (const endpoint of ['seat-change-options', 'upgrade-seat', 'resolve-seat-upgrade']) {
        assert.ok(route.includes(`router.post('/public-ticket/admin/${endpoint}', requireTicketingAdmin,`));
    }
});

test('UPGRADE: several seat upgrades accumulate and one outside payment confirmation resolves the reviewed total', async () => {
    const f = upgradeFixture();
    f.seat('second', { areaType: 'lento', row: 'B', number: 2, seatLabel: 'B2', status: 'booked', bookingId: 'paid' });
    f.seat('target2', { number: 4, seatLabel: 'A4' });
    f.booking().selectedSeatIds = ['old', 'second'];
    f.booking().seatAssignments[0].seatIds.push('second');
    await f.upgrade({ expectedSeatIds: ['old', 'second'] });
    const options = await f.adminSeats.getSeatChangeOptions({ bookingId: 'paid' }, actor);
    assert.equal(options.balance, 75000);
    assert.equal(options.seats.find(item => item.id === 'second').price, 75000);
    await f.upgrade({ fromSeatId: 'second', toSeatId: 'target2', expectedSeatIds: ['new', 'second'], expectedRevision: 1, expectedBalance: 75000 });
    assert.equal(f.booking().seatUpgradeBalance, 150000);
    assert.equal(f.booking().tickets.length, 1);
    assert.equal(f.booking().tickets[0].quantity, 2);
    await assert.rejects(f.resolve(), /changed/);
    await f.resolve({ expectedRevision: 2, expectedBalance: 150000 });
    assert.equal(f.booking().seatUpgradeBalance, 0);
    assert.ok(f.booking().seatUpgrades.every(item => item.status === 'paid'));
});
test('UPGRADE: serialized competing upgrades to different chairs cannot oversell the last tier slot', async () => {
    const f = upgradeFixture();
    f.capacity().reservedByTier = { lento: 4, presto: 9 };
    f.seat('other-old', { areaType: 'lento', row: 'B', number: 4, seatLabel: 'B4', status: 'booked', bookingId: 'other' });
    f.seat('other-target', { number: 4, seatLabel: 'A4' });
    f.seed('publicBookings/other', { ...plain(f.booking()), selectedSeatIds: ['other-old'], seatAssignments: [], physicalSeatKeys: [] });
    f.seed(f.ownerKey('other-old'), { bookingId: 'other', status: 'booked', active: true });
    const run = f.db.runTransaction.bind(f.db); let queue = Promise.resolve();
    f.db.runTransaction = callback => { const next = queue.then(() => run(callback)); queue = next.catch(() => {}); return next; };
    const results = await Promise.allSettled([f.upgrade(), f.upgrade({ bookingId: 'other', fromSeatId: 'other-old',
        toSeatId: 'other-target', expectedSeatIds: ['other-old'] })]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(f.capacity().reservedByTier.presto, 10);
    assert.equal(f.records.get('seatsAPCS2026/other-old').bookingId, 'other');
});
test('UPGRADE: missing seats can still be assigned afterwards and retain their original source-tier price', async () => {
    const f = upgradeFixture(); await f.upgrade();
    f.seat('later', { areaType: 'lento', row: 'B', number: 2, seatLabel: 'B2' });
    await f.adminSeats.assignPaidBookingSeats({ bookingId: 'paid', seatIds: ['later'] }, actor);
    const options = await f.adminSeats.getSeatChangeOptions({ bookingId: 'paid' }, actor);
    assert.equal(options.seats.find(item => item.id === 'later').price, 75000);
    assert.equal(options.seats.find(item => item.id === 'new').price, 150000);
});
test('UPGRADE: duplicate original paid callbacks preserve upgraded tickets, outstanding balance and reserved tiers', async () => {
    const f = upgradeFixture(); f.booking().invoiceId = 'invoice-paid';
    await f.upgrade(); const before = plain([...f.records]);
    const result = await f.repo.handlePublicTicketWebhookPaid('paid', { invoice: { id: 'invoice-paid', total_amount: 150000 } });
    assert.equal(result.alreadyPaid, true);
    assert.deepEqual(plain([...f.records]), before);
});
test('UPGRADE: stale original seat snapshots, lower tiers and foreign-owned destinations reject without writes', async () => {
    let f = upgradeFixture(); await upgradeRejects(f, /Select original chairs/, { expectedSeatIds: ['changed'] });
    f = upgradeFixture(); f.records.get('seatsAPCS2026/new').status = 'booked'; f.records.get('seatsAPCS2026/new').bookingId = 'other';
    await upgradeRejects(f, /no longer available/);
    f = upgradeFixture();
    f.records.get('seatsAPCS2026/old').areaType = 'presto'; f.records.get('seatsAPCS2026/old').row = 'A';
    f.records.get('seatsAPCS2026/new').areaType = 'lento'; f.records.get('seatsAPCS2026/new').row = 'B';
    f.booking().tickets = [{ id: 'presto', quantity: 2, priceEach: 150000 }];
    await upgradeRejects(f, /Downgrades/);
});

test('INTERNAL ONLY: options, chair upgrade and outside-payment resolution never send email or contact Paper.id', async () => {
    const f = upgradeFixture({
        getInvoice: () => { throw new Error('Paper.id lookup is forbidden for seat upgrades'); },
        onCancel: () => { throw new Error('Paper.id cancellation is forbidden for seat upgrades'); },
    });
    f.booking().invoiceId = 'existing-original-invoice';
    f.booking().paymentUrl = 'https://example.invalid/original-payment';
    const original = plain(f.booking());
    let emailCalls = 0;
    const email = new Proxy({}, { get: () => () => { emailCalls++; throw new Error('Email is forbidden for seat upgrades'); } });
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/controllers/PublicTicketController.js'), 'utf8'), {
        module, require: name => name.endsWith('/TicketSeatAdminRepository') ? f.adminSeats : name.endsWith('/EmailService') ? email : {},
    });
    const call = async (method, body) => {
        let result, status, failure;
        const res = { status: value => { status = value; return res; }, json: value => { result = value; } };
        await module.exports[method]({ body, ticketingAdmin: actor }, res, error => { failure = error; });
        if (failure) throw failure;
        assert.equal(status, 200);
        return result;
    };
    const options = await call('getSeatChangeOptions', { bookingId: 'paid' });
    await call('upgradePaidBookingSeat', { bookingId: 'paid', fromSeatId: 'old', toSeatId: 'new', expectedSeatIds: options.expectedSeatIds,
        expectedRevision: options.revision, expectedBalance: options.balance, expectedDifference: 75000 });
    await call('resolveSeatUpgradePayment', { bookingId: 'paid', expectedRevision: 1, expectedBalance: 75000 });
    assert.equal(emailCalls, 0);
    assert.equal(f.invoices.length, 0);
    for (const field of ['invoiceId', 'paymentUrl', 'paymentStatus', 'totalAmount', 'emailSent']) assert.equal(f.booking()[field], original[field]);
});

test('REGRESSION: upgraded bookings retain orchestra assignments and expose the new performance tiers to redemption', async () => {
    const f = upgradeFixture();
    Object.assign(f.booking(), { ticketingVersion: 2, bookingType: 'winner', registrantId: 'winner', performerCount: 1 });
    await f.upgrade();
    const orchestra = f.load('src/repositories/OrchestraAssignmentRepository.js');
    await orchestra.assignGroup({ eventId: 'APCS2026', registrantId: 'winner', sessionId: 'orch' }, actor);
    const assignment = f.records.get('orchestraAssignments/' + encodeURIComponent('APCS2026|winner'));
    assert.equal(assignment.quantity, 3);
    const redemption = f.load('src/repositories/TicketRedemptionRepository.js');
    const before = await redemption.detail({ eventId: 'APCS2026', bookingId: 'paid' });
    assert.deepEqual(plain(before.allowances.find(item => item.channel === 'performance').quantities), { lento: 1, presto: 1 });
    assert.deepEqual(plain(before.allowances.find(item => item.channel === 'orchestra').quantities), { orchestra: 2 });
    assert.deepEqual(plain(before.allowances.find(item => item.channel === 'performers').quantities), { performers: 1 });
    await f.resolve();
    const after = await redemption.detail({ eventId: 'APCS2026', bookingId: 'paid' });
    assert.deepEqual(plain(after.allowances), plain(before.allowances));
    assert.deepEqual(plain(f.records.get('orchestraAssignments/' + encodeURIComponent('APCS2026|winner'))), plain(assignment));
});
test('REGRESSION: checkout honors upgraded capacity and can sell the released source chair', async () => {
    const f = upgradeFixture(); f.capacity().reservedByTier.presto = 9;
    await f.upgrade();
    const full = await f.book({ tickets: [{ id: 'presto', name: 'Presto', quantity: 1 }] });
    assert.match(full.error.message, /capacity remains/);
    assert.equal(f.invoices.length, 0);
    const released = await f.book({ bookingType: 'winner', registrantId: 'winner', tickets: [{ id: 'lento', name: 'Lento', quantity: 1 }],
        selectedSeatIds: ['old'], addOnIds: ['seat_selection_performer'] });
    assert.ifError(released.error);
    assert.equal(f.records.get('seatsAPCS2026/old').lockedByBookingId, released.result.bookingId);
    assert.equal(f.records.get('seatsAPCS2026/new').bookingId, 'paid');
    assert.equal(f.capacity().reservedByTier.presto, 10);
    assert.equal(f.capacity().reservedByTier.lento, 2);
});

test('EDIT REGRESSION: mixed-booking same-tier edits preserve buyer chairs, upgrade balance, ticket prices and capacity', async () => {
    const f = upgradeFixture();
    f.seat('buyer', { row: 'B', areaType: 'lento', number: 3, seatLabel: 'B3', status: 'booked', bookingId: 'paid' });
    f.booking().selectedSeatIds = ['buyer', 'old'];
    f.booking().addOnIds = ['seat_selection_performer'];
    await f.upgrade({ expectedSeatIds: ['buyer', 'old'] });
    f.seat('edited', { number: 4, seatLabel: 'A4' });
    const original = plain(f.booking()), capacity = plain(f.capacity()), buyer = plain(f.records.get('seatsAPCS2026/buyer'));
    await f.change({ seatIds: ['buyer', 'edited'], expectedSeatIds: ['buyer', 'new'] });
    assert.deepEqual(plain(f.records.get('seatsAPCS2026/buyer')), buyer);
    assert.equal(f.booking().seatPriceSnapshots.edited, 150000);
    assert.equal(f.booking().seatPriceSnapshots.new, undefined);
    for (const field of ['seatUpgradeBalance', 'seatUpgradeRevision', 'seatUpgrades', 'tickets', 'capacityReservation', 'totalAmount']) {
        assert.deepEqual(plain(f.booking()[field]), original[field]);
    }
    assert.deepEqual(plain(f.capacity()), capacity);
    const before = plain([...f.records]);
    await assert.rejects(f.change({ seatIds: ['old', 'edited'], expectedSeatIds: ['buyer', 'edited'] }), /buyer-selected/);
    assert.deepEqual(plain([...f.records]), before);
});

function batchUpgradeFixture() {
    const f = upgradeFixture();
    f.records.delete(f.ownerKey('old')); f.records.delete('seatsAPCS2026/old');
    const event = f.records.get('events/APCS2026');
    event.venues[0].seatConfig[1].areaType = 'allegro';
    event.ticketTiers[0].venuePrices.V1 = 650000;
    event.ticketTiers[1] = { id: 'allegro', name: 'Allegro', venuePrices: { V1: 529000 } };
    const changes = Array.from({ length: 5 }, (_, index) => ({ fromSeatId: `original-${index}`, toSeatId: `replacement-${index}` }));
    changes.forEach((change, index) => {
        f.seat(change.fromSeatId, { row: 'B', areaType: 'allegro', number: index + 1, seatLabel: `B${index + 1}`, status: 'booked', bookingId: 'paid' });
        f.seat(change.toSeatId, { number: index + 2, seatLabel: `A${index + 2}` });
        f.seed(f.ownerKey(change.fromSeatId), { bookingId: 'paid', status: 'booked', active: true });
    });
    Object.assign(f.booking(), { tickets: [{ id: 'allegro', name: 'Allegro', quantity: 5, priceEach: 529000 }],
        selectedSeatIds: changes.map(change => change.fromSeatId), performanceSeatLabels: ['B1', 'B2', 'B3', 'B4', 'B5'],
        totalAmount: 2645000, orchestraAttendanceTickets: 5, physicalSeatKeys: [], seatAssignments: [{ seatIds: changes.map(change => change.fromSeatId) }],
        capacityReservation: { capacityId: f.capacityId, byTier: { allegro: 5 } } });
    f.capacity().reservedByTier = { allegro: 5, presto: 0 };
    f.changes = changes;
    f.batch = (patch = {}) => f.adminSeats.upgradePaidBookingSeat({ bookingId: 'paid', changes,
        expectedSeatIds: changes.map(change => change.fromSeatId), expectedDifference: 605000, expectedRevision: 0, expectedBalance: 0, ...patch }, actor);
    return f;
}
test('BATCH: all five seats upgrade atomically with one combined balance and one revision', async () => {
    const f = batchUpgradeFixture(); await f.batch();
    assert.deepEqual(plain(f.booking().selectedSeatIds), f.changes.map(change => change.toSeatId));
    assert.deepEqual(plain(f.capacity().reservedByTier), { allegro: 0, presto: 5 });
    assert.equal(f.booking().tickets.length, 1); assert.equal(f.booking().tickets[0].quantity, 5);
    assert.equal(f.booking().seatUpgradeBalance, 605000); assert.equal(f.booking().seatUpgradeRevision, 1);
    assert.equal(f.booking().seatUpgrades.length, 5);
    for (const change of f.changes) {
        assert.equal(f.records.get('seatsAPCS2026/' + change.fromSeatId).status, 'available');
        assert.equal(f.records.get('seatsAPCS2026/' + change.toSeatId).bookingId, 'paid');
        assert.equal(f.booking().seatPriceSnapshots[change.toSeatId], 650000);
    }
    assert.equal(f.booking().totalAmount, 2645000); assert.equal(f.booking().orchestraAttendanceTickets, 5);
    assert.equal(f.invoices.length, 0);
    await f.resolve({ expectedBalance: 605000 });
    assert.equal(f.booking().seatUpgradeBalance, 0);
    assert.ok(f.booking().seatUpgrades.every(item => item.status === 'paid'));
});
test('BATCH: one unavailable replacement or insufficient total capacity rolls back every seat', async () => {
    for (const cause of ['booked', 'capacity']) {
        const f = batchUpgradeFixture();
        if (cause === 'booked') Object.assign(f.records.get('seatsAPCS2026/replacement-4'), { status: 'booked', bookingId: 'other' });
        else f.capacity().reservedByTier.presto = 6;
        const before = plain([...f.records]);
        await assert.rejects(f.batch(), cause === 'booked' ? /no longer available/ : /remaining capacity/);
        assert.deepEqual(plain([...f.records]), before);
    }
});
test('BATCH: duplicate sources/targets and an incorrect total are rejected without writes', async () => {
    for (const cause of ['source', 'target', 'price']) {
        const f = batchUpgradeFixture(), changes = plain(f.changes);
        if (cause === 'source') changes[4].fromSeatId = changes[0].fromSeatId;
        if (cause === 'target') changes[4].toSeatId = changes[0].toSeatId;
        const before = plain([...f.records]);
        await assert.rejects(f.batch({ changes, ...(cause === 'price' ? { expectedDifference: 121000 } : {}) }), /Select original chairs|price changed/);
        assert.deepEqual(plain([...f.records]), before);
    }
});
test('BATCH: buyer-selected chairs stay protected while all five staff chairs can upgrade', async () => {
    const f = batchUpgradeFixture();
    f.seat('buyer', { row: 'B', areaType: 'allegro', number: 6, seatLabel: 'B6', status: 'booked', bookingId: 'paid' });
    f.booking().selectedSeatIds.push('buyer'); f.booking().addOnIds = ['seat_selection_performer'];
    f.booking().tickets[0].quantity = 6; f.booking().capacityReservation.byTier.allegro = 6;
    f.capacity().reservedByTier.allegro = 6;
    const expectedSeatIds = [...f.booking().selectedSeatIds];
    const before = plain([...f.records]);
    await assert.rejects(f.batch({ expectedSeatIds, changes: f.changes.map((change, index) => index === 4 ? { ...change, fromSeatId: 'buyer' } : change) }), /buyer-selected/);
    assert.deepEqual(plain([...f.records]), before);
    await f.batch({ expectedSeatIds });
    assert.equal(f.records.get('seatsAPCS2026/buyer').bookingId, 'paid');
    assert.ok(f.booking().selectedSeatIds.includes('buyer'));
    assert.deepEqual(plain(f.capacity().reservedByTier), { allegro: 1, presto: 5 });
});
