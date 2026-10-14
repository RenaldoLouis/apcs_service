const assert = require('node:assert/strict');
const test = require('node:test');
const { TARGET, SESSION_KEY, prepareChanges, matchesTarget } = require('./remove_obsolete_behring_session');

function fixture() {
  return {
    event: { name: 'Preserve event', competitionScheduleState: { status: 'draft', revision: 168, extra: 'keep' },
      venues: [{ id: TARGET.venueId, label: TARGET.venueLabel, imageUrl: 'keep', seatConfig: [{ row: 'A' }],
        sessions: { [TARGET.date]: [TARGET.time, '11:05-13:20'], '2026-11-15': ['11:35-14:20'] } },
      { id: 'other', sessions: { [TARGET.date]: [TARGET.time] }, metadata: 'keep' }],
      orchestraSessions: [{ id: 'orchestra', venue: 'other', date: '2026-11-15', time: '15:30-17:30' }],
      sessionsSeatsGenerated: { other: true }, pricing: { presto: 123 }, extra: { untouched: true } },
    plan: { status: 'draft', revision: 168, updatedAt: 'keep',
      draftSlots: [{ slotId: 'real', venueId: TARGET.venueId, date: TARGET.date, start: '08:00', end: '09:00' }], extra: 'keep' },
    assignment: { assignments: { other: [{ registrantId: 'keep' }] } },
  };
}

test('removes only the exact timetable entry and advances synchronized revisions', () => {
  const { event, plan, assignment } = fixture();
  const original = structuredClone({ event, plan, assignment });
  const next = prepareChanges(event, plan, assignment, []);
  const expected = structuredClone(original);
  expected.event.venues[0].sessions[TARGET.date] = ['11:05-13:20'];
  expected.event.competitionScheduleState.revision = 169;
  expected.plan.revision = 169;
  assert.deepStrictEqual(next, { event: expected.event, plan: expected.plan });
  assert.deepStrictEqual({ event, plan, assignment }, original);
});

test('retains the empty date key when removing its final obsolete time', () => {
  const { event, plan } = fixture();
  event.venues[0].sessions[TARGET.date] = [TARGET.time];
  assert.deepStrictEqual(prepareChanges(event, plan, null, []).event.venues[0].sessions[TARGET.date], []);
});

test('refuses published schedules, revision disagreement, and missing/duplicated target', () => {
  for (const change of [
    ({ event }) => { event.competitionScheduleState.status = 'published'; },
    ({ plan }) => { plan.revision += 1; },
    ({ event }) => { event.venues[0].sessions[TARGET.date] = []; },
    ({ event }) => { event.venues[0].sessions[TARGET.date].push(TARGET.time); },
  ]) {
    const data = fixture(); change(data);
    assert.throws(() => prepareChanges(data.event, data.plan, data.assignment, []));
  }
});

test('refuses generated inventory, published performers, special sessions, and retained references', () => {
  for (const change of [
    data => { data.event.sessionsSeatsGenerated[SESSION_KEY] = true; },
    data => { data.assignment.assignments[SESSION_KEY] = [{ registrantId: 'active' }]; },
    data => { data.event.orchestraSessions.push({ venue: TARGET.venueId, date: TARGET.date, time: TARGET.time }); },
    data => { data.dependencies = [{ retained: true }]; },
  ]) {
    const data = fixture(); change(data);
    assert.throws(() => prepareChanges(data.event, data.plan, data.assignment, data.dependencies || []));
  }
});

test('detects nested/encoded target references and ignores other venue/date/time', () => {
  const target = { venue: TARGET.venueId, date: TARGET.date, session: TARGET.time };
  assert.ok(matchesTarget({ nested: target, note: '100% preserved' }));
  assert.ok(matchesTarget({}, encodeURIComponent(SESSION_KEY)));
  assert.ok(!matchesTarget({ ...target, venue: 'other' }));
  assert.ok(!matchesTarget({ ...target, date: '2026-11-15' }));
  assert.ok(!matchesTarget({ ...target, session: '11:05-13:20' }));
  assert.ok(!matchesTarget({}, 'legacy%invalid'));
});
