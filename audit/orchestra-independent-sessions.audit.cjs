// Execute production repositories against isolated in-memory dependencies.
// No production database, payment provider, email or browser calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixtureFile = path.join(__dirname, 'public-ticket.audit.cjs');
const source = fs.readFileSync(fixtureFile, 'utf8').split('\nconst paidInvoice =')[0];
const context = { require, __dirname, module: { exports: {} } };
vm.runInNewContext(source + '\nmodule.exports = fixture;', context, { filename: fixtureFile });
const setup = () => context.module.exports({ extraRequire: (name, load) => {
    if (name.endsWith('/TicketRedemptionModel')) return load('src/services/TicketRedemptionModel.js');
    if (name.endsWith('/ErrorHandlerMiddleware')) return load('src/middlewares/ErrorHandlerMiddleware.js');
} });
const actor = { uid: 'staff', email: 'staff@example.invalid' };
const session = { venue: 'V1', date: '2026-11-15', time: '15:30-17:30', complimentaryQuota: 0 };
const save = (f, data = session) => f.load('src/repositories/OrchestraAssignmentRepository.js').saveSession({ eventId: 'APCS2026', session: data });
const state = f => JSON.stringify([...f.records]);
async function paid(f, input) {
    const response = await f.book(input);
    assert.ifError(response.error);
    const booking = f.records.get(`publicBookings/${response.result.bookingId}`);
    await f.repo.handlePublicTicketWebhookPaid(response.result.bookingId, { invoice: { id: booking.invoiceId, total_amount: booking.totalAmount } });
    return response.result.bookingId;
}
async function redeem(f, bookingId, channel, quantities, requestId) {
    const repo = f.load('src/repositories/TicketRedemptionRepository.js');
    const allowance = (await repo.detail({ eventId: 'APCS2026', bookingId })).allowances.find(item => item.channel === channel);
    return repo.claim({ eventId: 'APCS2026', bookingId, channel, quantities, requestId,
        expectedRevision: allowance.revision, sessionKey: allowance.sessionKey }, actor);
}

test('INDEPENDENT ORCHESTRA: new date/time persists without altering competition/planning or generating seats', async () => {
    const f = setup();
    f.seed('competitionSessionPlans/APCS2026', { status: 'draft', revision: 4, draftSlots: [] });
    const eventBefore = JSON.parse(JSON.stringify(f.records.get('events/APCS2026')));
    const planBefore = state(f);
    const saved = await save(f);
    assert.equal(saved.time, session.time); assert.equal(saved.date, session.date); assert.equal(saved.seatingMode, 'free');
    const eventAfter = JSON.parse(JSON.stringify(f.records.get('events/APCS2026')));
    assert.deepEqual({ ...eventAfter, orchestraSessions: eventBefore.orchestraSessions }, eventBefore);
    assert.equal(JSON.stringify(f.records.get('competitionSessionPlans/APCS2026')), JSON.stringify(JSON.parse(planBefore).find(([key]) => key === 'competitionSessionPlans/APCS2026')[1]));
    assert.equal([...f.records.keys()].filter(key => key.startsWith('seats')).length, 0);
});

test('INDEPENDENT ORCHESTRA: invalid calendar dates, time ranges, venue and quota reject atomically', async () => {
    for (const invalid of [{ date: '2026-02-30' }, { date: 'bad' }, { time: '24:00-25:00' },
        { time: '17:30-15:30' }, { time: '15:30-15:30' }, { time: '23:00-01:00' },
        { venue: 'missing' }, { complimentaryQuota: -1 }, { complimentaryQuota: 1.5 }]) {
        const f = setup(), before = state(f);
        await assert.rejects(save(f, { ...session, ...invalid }));
        assert.equal(state(f), before);
    }
});

test('INDEPENDENT ORCHESTRA: duplicate and partial overlaps with orchestra/Masterclass are rejected', async () => {
    for (const other of [{ time: session.time }, { time: '15:00-16:00' }, { time: '16:30-18:00' }]) {
        const f = setup(); f.records.get('events/APCS2026').orchestraSessions.push({ ...session, ...other, id: 'other' });
        const before = state(f); await assert.rejects(save(f), /already exists|overlaps/); assert.equal(state(f), before);
    }
    const f = setup(); f.records.get('events/APCS2026').masterclassSessions = [{ ...session, id: 'legacy', time: '16:30-18:00' }];
    await assert.rejects(save(f), /Masterclass/);
});

test('INDEPENDENT ORCHESTRA: rejects timed drafts and published competition conflicts, allowing adjacent times', async () => {
    for (const kind of ['draft', 'published', 'assignment']) {
        const f = setup();
        if (kind === 'draft') f.seed('competitionSessionPlans/APCS2026', { status: 'draft', draftSlots: [
            { venueId: 'V1', date: session.date, start: '16:00', end: '18:00' }] });
        if (kind === 'published') f.records.get('events/APCS2026').venues[0].sessions[session.date] = ['16:00-18:00'];
        if (kind === 'assignment') f.records.get('sessionAssignments/APCS2026').assignments[`V1_${session.date}_16:00-18:00`] = [{ registrantId: 'winner' }];
        const before = state(f); await assert.rejects(save(f), /competition/); assert.equal(state(f), before);
    }
    const f = setup(); f.records.get('events/APCS2026').venues[0].sessions[session.date] = ['13:30-15:30', '17:30-19:30'];
    assert.equal((await save(f)).time, session.time);
});

test('INDEPENDENT ORCHESTRA: other venues/days and untimed drafts do not block a new session', async () => {
    const f = setup(); f.seed('competitionSessionPlans/APCS2026', { draftSlots: [
        { venueId: 'other', date: session.date, start: '15:30', end: '17:30' },
        { venueId: 'V1', date: '2026-11-14', start: '15:30', end: '17:30' },
        { venueId: 'V1', date: session.date, start: null, end: null }] });
    assert.ok((await save(f)).id);
});

test('INDEPENDENT ORCHESTRA: public checkout/payment/redemption uses the newly created session and keeps numbered capacity', async () => {
    const f = setup(), saved = await save(f);
    const bookingId = await paid(f, { bookingType: 'public_orchestra', isOrchestra: true,
        date: saved.date, session: saved.time, tickets: [{ id: 'presto', quantity: 25 }] });
    const booking = f.records.get(`publicBookings/${bookingId}`);
    assert.equal(booking.seatingMode, 'free'); assert.equal(booking.selectedSeatIds.length, 0);
    const redemption = await redeem(f, bookingId, 'orchestra', { presto: 25 }, 'direct-redemption');
    assert.equal(redemption.redeemed.presto, 25);
    await assert.rejects(f.load('src/repositories/OrchestraAssignmentRepository.js').saveSession({ eventId: 'APCS2026', deleteSessionId: saved.id }), /cannot be deleted/);
    assert.ifError((await f.book({ tickets: [{ id: 'presto', quantity: 10 }] })).error);
    assert.match((await f.book({ tickets: [{ id: 'presto', quantity: 1 }] })).error.message, /capacity/);
});

test('INDEPENDENT ORCHESTRA: paid winner assignment, prefill, ticket and shared performer redemption retain their rules', async () => {
    const f = setup(), saved = await save(f);
    const bookingId = await paid(f, { bookingType: 'winner', registrantId: 'winner', tickets: [{ id: 'presto', quantity: 2 }] });
    f.seed('competitionSessionPlans/APCS2026/groups/planned', { eventId: 'APCS2026', purpose: 'orchestra_attendance',
        venueId: saved.venue, date: saved.date, registrantIds: ['winner'], orchestraSessionId: saved.id });
    const repo = f.load('src/repositories/OrchestraAssignmentRepository.js');
    const group = (await repo.listGroups({ eventId: 'APCS2026' })).groups[0];
    assert.equal(group.plannedSession.sessionId, saved.id);
    const pending = (await f.load('src/repositories/TicketRedemptionRepository.js').detail({ eventId: 'APCS2026', bookingId })).allowances;
    assert.match(pending.find(item => item.channel === 'orchestra').blockedReason, /Awaiting orchestra assignment/);
    const assigned = await repo.assignGroup({ eventId: 'APCS2026', registrantId: 'winner', sessionId: saved.id }, actor);
    assert.equal(assigned.assignment.quantity, 3);
    assert.equal((await repo.assignGroup({ eventId: 'APCS2026', registrantId: 'winner', sessionId: saved.id }, actor)).assignment.revision, assigned.assignment.revision);
    assert.equal((await redeem(f, bookingId, 'orchestra', { orchestra: 2 }, 'winner-tickets')).redeemed.orchestra, 2);
    assert.equal((await redeem(f, bookingId, 'performers', { performers: 1 }, 'shared-performer')).redeemed.performers, 1);
    assert.equal((await redeem(f, bookingId, 'performance', { presto: 2 }, 'competition-tickets')).redeemed.presto, 2);
    const changedQuota = await save(f, { ...saved, complimentaryQuota: 9999 });
    assert.equal(changedQuota.freeSeatingAssigned, 3);
    await assert.rejects(save(f, { ...saved, time: '18:00-19:00' }), /cannot.*moved/);
});

test('INDEPENDENT ORCHESTRA: pending bookings, stale counters, legacy inventory and planned links protect deletion/moves', async () => {
    for (const kind of ['pending', 'assignment', 'inventory', 'planned']) {
        const f = setup(), saved = await save(f);
        if (kind === 'pending') assert.ifError((await f.book({ bookingType: 'public_orchestra', date: saved.date, session: saved.time })).error);
        if (kind === 'assignment') f.seed('orchestraAssignments/stale-counter', { eventId: 'APCS2026', sessionId: saved.id, quantity: 1 });
        if (kind === 'inventory') f.seed('seatsAPCS2026/legacy', { venueId: saved.venue, sessionId: `${saved.date}_${saved.time}`, status: 'available' });
        if (kind === 'planned') f.seed('competitionSessionPlans/APCS2026/groups/group', { orchestraSessionId: saved.id });
        const before = state(f);
        await assert.rejects(f.load('src/repositories/OrchestraAssignmentRepository.js').saveSession({ eventId: 'APCS2026', deleteSessionId: saved.id }));
        assert.equal(state(f), before);
    }
    const f = setup(), saved = await save(f), eventBefore = f.records.get('events/APCS2026');
    const other = JSON.stringify(eventBefore.orchestraSessions.filter(item => item.id !== saved.id));
    await f.load('src/repositories/OrchestraAssignmentRepository.js').saveSession({ eventId: 'APCS2026', deleteSessionId: saved.id });
    assert.equal(JSON.stringify(f.records.get('events/APCS2026').orchestraSessions), other);
});
