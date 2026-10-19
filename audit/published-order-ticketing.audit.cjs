// Cross-flow verification against real repositories sharing one isolated database.
// No provider, SMTP, production/emulator database or browser calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixtureFile = path.join(__dirname, 'public-ticket.audit.cjs');
// Adapt the existing offline fixture for planning's nested collection references
// and Firestore dotted updates; production modules themselves are unmodified.
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').split('\nconst paidInvoice =')[0]
  .replace('path: key, id:', "path: key, collection: sub => collection(`${key}/${sub}`), id:")
  .replace('for (const field of Object.keys(data)) if', `for (const field of Object.keys(data)) {
    if (!field.includes('.')) continue;
    const [parent, child] = field.split('.');
    data[parent] = { ...data[parent], [child]: data[field] };
    delete data[field];
  }
  for (const field of Object.keys(data)) if`);
const context = { require, __dirname, module: { exports: {} } };
vm.runInNewContext(fixtureSource + '\nmodule.exports = fixture;', context, { filename: fixtureFile });
const actor = { uid: 'staff', email: 'staff@example.invalid' };
const setup = () => {
  const f = context.module.exports({ extraRequire: (name, load) => {
    if (name === 'crypto') return require('node:crypto');
    if (name.endsWith('/TicketRedemptionModel')) return load('src/services/TicketRedemptionModel.js');
  } });
  const state = { status: 'ready', revision: 7, publishedAt: 'published', readyAt: 'ready' };
  f.records.get('events/APCS2026').competitionScheduleState = state;
  const slot = { slotId: 'S1', venueId: 'V1', date: '2026-11-01', start: '09:00', end: '10:00' };
  f.seed('competitionSessionPlans/APCS2026', { ...state, draftSlots: [slot] });
  f.seed('competitionSessionPlans/APCS2026/groups/P1', { ...slot, groupId: 'P1',
    purpose: 'competition', registrantIds: ['winner', 'second'] });
  f.seed('Registrants2025/second', { eventId: 'APCS2026', finalAward: 'Gold', performers: [{ fullName: 'Second Performer' }] });
  f.seed('sessionAssignments/APCS2026', { eventId: 'APCS2026', attendanceOnlyRegistrantIds: [], assignments: {
    'V1_2026-11-01_09:00-10:00': ['winner', 'second'].map((registrantId, order) =>
      ({ registrantId, order, sourceEventId: 'APCS2026' })),
  } });
  f.seat();
  return f;
};
const eligible = (f, buyerType) => new Promise((resolve, reject) =>
  f.repo.getEligibleWinners({ buyerType }, (error, result) => error ? reject(error) : resolve(JSON.stringify(result))));
async function reorder(f, revision, ids) {
  const before = new Map([...f.records].map(([key, value]) => [key, JSON.stringify(value)]));
  const result = await f.load('src/repositories/CompetitionPlanningRepository.js')
    .reorderPublished('APCS2026', revision, [{ groupId: 'P1', registrantIds: ids }]);
  assert.equal(result.revision, revision + 1);
  assert.equal(f.records.get('events/APCS2026').competitionScheduleState.revision, revision + 1);
  const writable = new Set(['events/APCS2026', 'competitionSessionPlans/APCS2026',
    'competitionSessionPlans/APCS2026/groups/P1', 'sessionAssignments/APCS2026']);
  for (const [key, value] of before) if (!writable.has(key)) {
    assert.equal(JSON.stringify(f.records.get(key)), value, `${key} unchanged by reorder`);
  }
  assert.equal(f.records.size, before.size, 'No new payment, inventory or admission records');
}
async function redeem(f, bookingId, channel, quantities, requestId) {
  const repo = f.load('src/repositories/TicketRedemptionRepository.js');
  const allowance = (await repo.detail({ eventId: 'APCS2026', bookingId })).allowances.find(item => item.channel === channel);
  return repo.claim({ eventId: 'APCS2026', bookingId, channel, quantities, requestId,
    expectedRevision: allowance.revision, sessionKey: allowance.sessionKey }, actor);
}
for (const manualPayment of [false, true]) {
  for (const bookingType of ['winner', 'public_competition']) {
    test(`ORDER CROSS-FLOW: ${bookingType}/${manualPayment ? 'manual' : 'Paper.id'} keeps discovery, pending checkout, payment, seats and redemption`, async () => {
      const f = setup();
      const beforeDiscovery = await eligible(f, bookingType === 'winner' ? 'winner' : 'public');
      const input = { bookingType, registrantId: 'winner', manualPayment,
        idempotencyKey: 'reorder-checkout', tickets: [{ id: 'presto', name: 'Presto', quantity: 1 }],
        selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] };
      const pending = await f.book(input);
      assert.ifError(pending.error);
      const bookingId = pending.result.bookingId;
      const pendingBooking = f.records.get(`publicBookings/${bookingId}`);
      assert.equal(pendingBooking.paymentStatus, 'pending');
      await reorder(f, 7, ['second', 'winner']);
      assert.equal(await eligible(f, bookingType === 'winner' ? 'winner' : 'public'), beforeDiscovery);
      const replay = await f.book(input);
      assert.ifError(replay.error);
      assert.equal(replay.result.bookingId, bookingId, 'Same attempt does not create a second invoice/booking');
      assert.equal(f.invoices.length, manualPayment ? 0 : 1);
      if (manualPayment) await f.repo.markManualBookingPaid(bookingId, actor);
      else await f.repo.handlePublicTicketWebhookPaid(bookingId,
        { invoice: { id: pendingBooking.invoiceId, total_amount: pendingBooking.totalAmount } });
      const paid = f.records.get(`publicBookings/${bookingId}`);
      assert.equal(paid.paymentStatus, 'PAID');
      assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'booked');
      const orchestra = f.load('src/repositories/OrchestraAssignmentRepository.js');
      const assignment = await orchestra.assignGroup({ eventId: 'APCS2026', registrantId: 'winner', sessionId: 'orch' }, actor);
      assert.equal(assignment.assignment.quantity, bookingType === 'winner' ? 2 : 1);
      const performance = await redeem(f, bookingId, 'performance', { presto: 1 }, 'performance');
      assert.equal(performance.redeemed.presto, 1);
      const tickets = await redeem(f, bookingId, 'orchestra', { orchestra: 1 }, 'orchestra');
      assert.equal(tickets.redeemed.orchestra, 1);
      if (bookingType === 'winner') {
        assert.equal((await redeem(f, bookingId, 'performers', { performers: 1 }, 'performer')).redeemed.performers, 1);
      }
      await reorder(f, 8, ['winner', 'second']);
      await assert.rejects(redeem(f, bookingId, 'performance', { presto: 1 }, 'excess-performance'));
      // New buyers can still buy the same performance after a ready-group reorder.
      assert.ifError((await f.book({ bookingType, registrantId: 'winner', manualPayment,
        tickets: [{ id: 'presto', quantity: 1 }] })).error);
    });
  }
}
