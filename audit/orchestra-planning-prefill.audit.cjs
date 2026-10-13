// Offline production-code checks: planning suggestions are read-only, paid
// assignments stay authoritative, and redemption still requires staff confirmation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixtureFile = path.join(__dirname, 'public-ticket.audit.cjs');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').split("test('PUBLIC:")[0];
const context = { require, __dirname, module: { exports: {} } };
vm.runInNewContext(fixtureSource + '\nmodule.exports = fixture;', context, { filename: fixtureFile });
const fixture = context.module.exports;
const actor = { email: 'admin@example.invalid' };
const request = { eventId: 'APCS2026', registrantId: 'winner', sessionId: 'orch' };
const plan = { eventId: 'APCS2026', purpose: 'orchestra_attendance', venueId: 'V1',
    date: '2026-11-01', label: 'Early plan', registrantIds: ['winner'], orchestraSessionId: 'orch' };
const seedPlan = (f, overrides = {}, pathEvent = 'APCS2026', id = 'A1') =>
    f.seed(`competitionSessionPlans/${pathEvent}/groups/${id}`, { ...plan, ...overrides });
async function purchase(f, quantity = 2, paid = true) {
    const result = await f.book({ bookingType: 'winner', registrantId: 'winner', tickets: [{ id: 'presto', quantity }] });
    assert.ifError(result.error);
    if (paid) {
        const booking = f.records.get(`publicBookings/${result.result.bookingId}`);
        await f.repo.handlePublicTicketWebhookPaid(result.result.bookingId, {
            invoice: { id: booking.invoiceId, total_amount: booking.totalAmount },
        });
    }
    return result.result.bookingId;
}
const repository = f => f.load('src/repositories/OrchestraAssignmentRepository.js');

test('PLANNING PREFILL: planning before purchase does not create a paid assignment or confirmed attendance', async () => {
    const f = fixture(); seedPlan(f);
    await purchase(f, 2, false);
    const before = JSON.stringify([...f.records]);
    assert.equal((await repository(f).listGroups({ eventId: 'APCS2026' })).groups.length, 0);
    assert.equal(JSON.stringify([...f.records]), before);
    assert.equal(f.records.has(`orchestraAssignments/${repository(f).idFor('APCS2026', 'winner')}`), false);
});

test('PLANNING PREFILL: paid discovery suggests the saved session without writing customer or admission records', async () => {
    const f = fixture(); seedPlan(f); await purchase(f);
    const before = JSON.stringify([...f.records]);
    const { groups } = await repository(f).listGroups({ eventId: 'APCS2026' });
    assert.equal(groups.length, 1);
    assert.equal(groups[0].plannedSession.sessionId, 'orch');
    assert.equal(groups[0].plannedSession.groupLabel, 'Early plan');
    assert.equal(groups[0].quantity, 3);
    assert.equal(groups[0].assignment, null);
    assert.equal(JSON.stringify([...f.records]), before);
});

test('PLANNING PREFILL: missing, deleted, cross-event and mismatched plans retain manual assignment', async () => {
    const cases = [
        null, {}, { orchestraSessionId: null }, { orchestraSessionId: 'deleted' },
        { venueId: 'V2' }, { date: '2026-11-02' }, { purpose: 'competition' },
        { eventId: 'another' }, { registrantIds: ['someone-else'] },
    ];
    for (const overrides of cases) {
        const f = fixture(); await purchase(f);
        if (overrides) seedPlan(f, overrides, Object.keys(overrides).length ? 'APCS2026' : 'another');
        const group = (await repository(f).listGroups({ eventId: 'APCS2026' })).groups[0];
        assert.equal(group.plannedSession, null);
        assert.equal((await repository(f).assignGroup(request, actor)).assignment.sessionId, 'orch');
    }
});

test('PLANNING PREFILL: ambiguous attendance memberships never guess a session', async () => {
    const f = fixture(); await purchase(f); seedPlan(f); seedPlan(f, {}, 'APCS2026', 'A2');
    assert.equal((await repository(f).listGroups({ eventId: 'APCS2026' })).groups[0].plannedSession, null);
    assert.equal((await repository(f).assignGroup(request, actor)).assignment.sessionId, 'orch');
});

test('PLANNING PREFILL: confirmed assignment and later purchases remain separate from changes to the plan', async () => {
    const f = fixture(); seedPlan(f); const firstId = await purchase(f);
    f.records.get('events/APCS2026').orchestraSessions.push({ id: 'orch2', venue: 'V1',
        date: '2026-11-01', time: '20:00-21:00', freeSeatingAssigned: 0 });
    const repo = repository(f);
    const saved = await repo.assignGroup({ ...request, sessionId: 'orch2' }, actor);
    await repo.markNotified(saved.id, saved.assignment.revision, firstId);
    await purchase(f, 1);
    seedPlan(f, { label: 'Changed plan' });
    const before = JSON.stringify([...f.records]);
    const group = (await repo.listGroups({ eventId: 'APCS2026' })).groups[0];
    assert.equal(group.plannedSession.sessionId, 'orch');
    assert.equal(group.assignment.sessionId, 'orch2');
    assert.equal(group.assignment.quantity, 3);
    assert.equal(group.quantity, 4);
    assert.equal(group.assignment.notifiedBookingIds.join(','), firstId);
    assert.equal(JSON.stringify([...f.records]), before);
});

test('PLANNING PREFILL: a suggested session cannot redeem orchestra tickets before staff save the assignment', async () => {
    const f = fixture({ extraRequire: name => name.endsWith('ErrorHandlerMiddleware')
        ? { AppError: class extends Error {} } : null });
    seedPlan(f); const bookingId = await purchase(f);
    const repo = repository(f);
    const group = (await repo.listGroups({ eventId: 'APCS2026' })).groups[0];
    const model = f.load('src/services/TicketRedemptionModel.js');
    const booking = { ...f.records.get(`publicBookings/${bookingId}`), id: bookingId };
    const event = f.records.get('events/APCS2026');
    const suggested = model.allowancesFor(booking, event, group.plannedSession);
    assert.match(suggested.find(item => item.channel === 'orchestra').blockedReason, /Awaiting orchestra assignment/);
    assert.equal(suggested.find(item => item.channel === 'performance').blockedReason, null);
    const assigned = await repo.assignGroup({ ...request, sessionId: group.plannedSession.sessionId }, actor);
    const confirmed = model.allowancesFor(booking, f.records.get('events/APCS2026'), assigned.assignment);
    assert.equal(confirmed.find(item => item.channel === 'orchestra').blockedReason, null);
    assert.equal(confirmed.find(item => item.channel === 'performers').quantities.performers, 1);
});
