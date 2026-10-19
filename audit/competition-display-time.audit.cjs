// Offline checks against the real repository and email functions; no Firebase/SMTP/browser calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getCompetitionDisplayTime } = require('../src/utils/competitionDisplayTime');
const fixtureFile = path.join(__dirname, 'competition-planning.audit.cjs');
const context = { require, __dirname, module: { exports: {} } };
vm.runInNewContext(fs.readFileSync(fixtureFile, 'utf8').split('\ntest(')[0]
  + '\nmodule.exports = fixture;', context, { filename: fixtureFile });
const original = '11:05-13:20';
const key = `V1_2026-11-14_${original}`;
const setup = (status = 'ready') => {
  const f = context.module.exports();
  const state = { status, revision: 7, publishedAt: 'published', readyAt: 'ready' };
  const event = f.records.get('events/E1');
  event.venues[0].sessions = { '2026-11-14': [original] };
  event.competitionScheduleState = { ...state };
  const slot = { slotId: 'S1', venueId: 'V1', date: '2026-11-14', start: '11:05', end: '13:20' };
  f.records.set('competitionSessionPlans/E1', { ...state, draftSlots: [slot] });
  f.records.set('competitionSessionPlans/E1/groups/G1', { ...slot, groupId: 'G1', purpose: 'competition',
    registrantIds: ['R1', 'R2'] });
  f.records.set('sessionAssignments/E1', { assignments: { [key]: [{ registrantId: 'R1', order: 0 }, { registrantId: 'R2', order: 1 }] } });
  for (const collection of ['seatsE1', 'publicBookings', 'ticketCapacity', 'ticketSeatOwnership', 'ticketRedemptions', 'orchestraAssignments']) {
    f.records.set(`${collection}/existing`, { eventId: 'E1', session: original, unchanged: true });
  }
  return f;
};
const save = (f, overrides = {}) => f.repo.saveDisplayTime('E1', {
  groupId: 'G1', expectedRevision: 0, displayTime: '11:10-13:30', ...overrides,
});
const snapshot = f => JSON.stringify([...f.records]);

for (const status of ['published', 'ready']) {
  test(`DISPLAY TIME: ${status} edit changes only separate event copy metadata`, async () => {
    const f = setup(status);
    const before = new Map([...f.records].map(([id, data]) => [id, JSON.stringify(data)]));
    const result = await save(f);
    assert.equal(result.competitionTimeDisplay.times[key], '11:10-13:30');
    assert.equal(result.competitionTimeDisplay.revision, 1);
    for (const [id, data] of f.records) {
      if (id === 'events/E1') {
        const { competitionTimeDisplay, ...unchanged } = data;
        assert.equal(JSON.stringify(unchanged), before.get(id));
      } else assert.equal(JSON.stringify(data), before.get(id), id);
    }
    assert.equal((await f.repo.getPlanningState('E1')).competitionTimeDisplay.times[key], '11:10-13:30');
    assert.equal(getCompetitionDisplayTime(f.records.get('events/E1'), 'V1', '2026-11-14', original), '11:10-13:30');
  });
}

test('DISPLAY TIME: clear restores original and preserves other session copy', async () => {
  const f = setup();
  await save(f);
  f.records.get('events/E1').competitionTimeDisplay.times.other = '09:00-10:00';
  await save(f, { expectedRevision: 1, displayTime: '' });
  assert.equal(f.records.get('events/E1').competitionTimeDisplay.times[key], undefined);
  assert.equal(f.records.get('events/E1').competitionTimeDisplay.times.other, '09:00-10:00');
  assert.equal(getCompetitionDisplayTime(f.records.get('events/E1'), 'V1', '2026-11-14', original), original);
});

test('DISPLAY TIME: normalizes a human-written range and original wording clears the override', async () => {
  const f = setup();
  await save(f, { displayTime: ' 11:10 – 13:30 ' });
  assert.equal(f.records.get('events/E1').competitionTimeDisplay.times[key], '11:10-13:30');
  await save(f, { expectedRevision: 1, displayTime: original });
  assert.equal(f.records.get('events/E1').competitionTimeDisplay.times[key], undefined);
});

test('DISPLAY TIME: a competing or repeated stale save cannot overwrite reviewed copy', async () => {
  const f = setup(); await save(f);
  const before = snapshot(f);
  await assert.rejects(save(f, { displayTime: '11:20-13:30' }), /Display times changed/);
  assert.equal(snapshot(f), before);
});

for (const patch of [
  { displayTime: '24:10-25:10' }, { displayTime: '13:30-11:10' }, { displayTime: '11:10-11:10' },
  { displayTime: '<script>alert(1)</script>' }, { displayTime: ' '.repeat(31) }, { displayTime: null }, { displayTime: [] },
  { expectedRevision: -1 }, { expectedRevision: '0' }, { groupId: 'missing' }, { groupId: 'bad/path' },
  { registrantIds: [] }, { venueId: 'V2' }, { start: '11:10' },
]) {
  test(`DISPLAY TIME: rejects invalid or structural payload ${JSON.stringify(patch)}`, async () => {
    const f = setup(); const before = snapshot(f);
    await assert.rejects(save(f, patch));
    assert.equal(snapshot(f), before);
  });
}

for (const [name, change] of [
  ['draft', f => { f.records.get('events/E1').competitionScheduleState.status = 'draft'; }],
  ['reset', f => { f.records.get('events/E1').competitionScheduleState.resetInProgress = true; }],
  ['plan mismatch', f => { f.records.get('competitionSessionPlans/E1').revision++; }],
  ['attendance', f => { f.records.get('competitionSessionPlans/E1/groups/G1').purpose = 'orchestra_attendance'; }],
  ['slot mismatch', f => { f.records.get('competitionSessionPlans/E1').draftSlots[0].start = '11:10'; }],
  ['assignment mismatch', f => { f.records.get('sessionAssignments/E1').assignments[key].reverse(); }],
  ['missing timetable', f => { f.records.get('events/E1').venues[0].sessions = {}; }],
  ['special session', f => { f.records.get('events/E1').orchestraSessions.push({ venue: 'V1', date: '2026-11-14', time: original }); }],
  ['ambiguous group', f => { f.records.set('competitionSessionPlans/E1/groups/G2', { ...f.records.get('competitionSessionPlans/E1/groups/G1') }); }],
]) {
  test(`DISPLAY TIME: refuses ${name} without partial writes`, async () => {
    const f = setup(); change(f); const before = snapshot(f);
    await assert.rejects(save(f));
    assert.equal(snapshot(f), before);
  });
}

test('DISPLAY TIME: paid/resend, manual instructions and holding emails read current copy from the booking event', async () => {
  const f = setup(); await save(f);
  f.records.set('events/OTHER', { competitionTimeDisplay: { times: { [key]: '01:00-02:00' } } });
  const source = fs.readFileSync(path.join(__dirname, '../src/services/EmailService.js'), 'utf8');
  const templates = [], mails = [], reads = [];
  const db = { collection(collection) {
    assert.equal(collection, 'events');
    return { doc(id) { reads.push(id); return { get: async () => ({ data: () => f.records.get(`events/${id}`) }) }; } };
  } };
  const email = { require: name => name.endsWith('/competitionDisplayTime')
    ? require('../src/utils/competitionDisplayTime') : { db }, Intl, Date,
    escapeTicketHtml: require('../src/services/OrchestraEmailDetails').escapeHtml,
    attendanceHtml: () => 'unchanged allowance',
    getTemplate: (name, data) => { templates.push({ name, data }); return name === 'PAYMENT_INFO_OPTIONS'
      ? { subject: 'payment', html: JSON.stringify(data) } : JSON.stringify(data); },
    transporter: { sendMail: async mail => { mails.push(mail); } }, logger: { info() {} } };
  vm.runInNewContext(source.slice(source.indexOf('async function getTicketDisplayDetails('),
    source.indexOf('async function sendJuryDeadlineReminderEmail(')), email);
  const booking = { id: 'B1', eventId: 'E1', venue: 'V1', venueName: 'Booking-time Hall', date: '2026-11-14',
    session: original, bookingType: 'public_competition', userEmail: 'buyer@example.invalid',
    tickets: [{ name: 'Presto', quantity: 2 }], totalAmount: 200, performanceSeatLabels: ['A1', 'A2'] };
  const before = JSON.stringify(booking);
  await email.sendPublicBookingConfirmationEmail(booking);
  assert.equal(templates.at(-1).data.session, '11:10-13:30');
  assert.equal(templates.at(-1).data.venueName, 'Booking-time Hall');
  assert.equal(templates.at(-1).data.performanceSeatLabels, 'A1, A2');
  await email.sendManualTicketPaymentInstructions(booking);
  assert.match(templates.at(-1).data.competitionCategory, /11:10-13:30/);
  await email.sendPublicSeatHoldEmail({ ...booking, to: booking.userEmail, lockExpiresAt: Date.now() + 1000 });
  assert.equal(templates.at(-1).data.session, '11:10-13:30');
  await save(f, { expectedRevision: 1, displayTime: '11:20-13:40' });
  await email.sendPublicBookingConfirmationEmail(booking);
  assert.equal(templates.at(-1).data.session, '11:20-13:40');
  await email.sendPublicBookingConfirmationEmail({ ...booking, bookingType: 'public_orchestra' });
  assert.equal(templates.at(-1).data.session, original);
  await email.sendPublicBookingConfirmationEmail({ ...booking, eventId: 'missing' });
  assert.equal(templates.at(-1).data.session, original);
  assert.ok(reads.every(id => id === 'E1' || id === 'missing'));
  assert.equal(mails.length, 6);
  assert.equal(JSON.stringify(booking), before);
});

test('DISPLAY TIME: route is authenticated and both rule sources protect copy metadata', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
  assert.match(routes, /'\/competition-planning\/:eventId\/display-time', requireTicketingAdmin, CompetitionPlanningController.saveDisplayTime/);
  for (const filename of ['../../apcs_web/firestore.rules', '../../docs/FIRESTORE_PRODUCTION_MERGED_2026-10-13.rules']) {
    const rules = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    const start = rules.indexOf('match /events/');
    const event = rules.slice(start, rules.indexOf('match /', start + 1));
    assert.match(event, /!\('competitionTimeDisplay' in request.resource.data\)/);
    assert.match(event, /hasAny\(\['competitionScheduleState', 'competitionTimeDisplay'\]\)/);
  }
});
