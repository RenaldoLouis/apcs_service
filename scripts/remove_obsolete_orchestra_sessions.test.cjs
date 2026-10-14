const assert = require('node:assert/strict');
const { test } = require('node:test');
const { TARGETS, prepareChanges, referencesTarget } = require('./remove_obsolete_orchestra_sessions');
const fixture = () => ({ event: { competitionScheduleState: { status: 'draft', revision: 169 },
  orchestraSessions: [...TARGETS.map(target => ({ ...target, complimentaryQuota: 15, freeSeatingAssigned: 0 })),
    { id: 'preserve', venue: 'other', date: '2026-11-16', time: '18:00-20:00' }],
  venues: [{ id: 'keep', seatConfig: ['keep'] }], pricing: { keep: 1 } },
plan: { status: 'draft', revision: 169, draftSlots: [{ slotId: 'real', start: '10:20', end: '12:15' }] } });

test('two-definition cleanup retains every other field and session, plus private drafts', () => {
  const { event, plan } = fixture(), before = structuredClone({ event, plan });
  const next = prepareChanges(event, plan, []);
  assert.deepStrictEqual(next.event.orchestraSessions, [before.event.orchestraSessions[2]]);
  assert.deepStrictEqual({ ...next.event, orchestraSessions: event.orchestraSessions, competitionScheduleState: event.competitionScheduleState }, event);
  assert.deepStrictEqual({ ...next.plan, revision: plan.revision }, plan);
  assert.deepStrictEqual({ event, plan }, before);
});
test('cleanup refuses attendance, unexpected identity, revisions and retained dependencies', () => {
  for (const change of [data => { data.event.orchestraSessions[0].freeSeatingAssigned = 1; },
    data => { data.event.orchestraSessions[1].complimentaryClaimed = 1; },
    data => { data.event.orchestraSessions[0].time = '16:00-18:00'; },
    data => { data.plan.revision += 1; }, data => { data.dependencies = ['reference']; }]) {
    const data = fixture(); change(data);
    assert.throws(() => prepareChanges(data.event, data.plan, data.dependencies || []));
  }
});
test('detects planned/paid/redemption IDs and dated session references', () => {
  assert.ok(referencesTarget({ orchestraSessionId: TARGETS[0].id }));
  assert.ok(referencesTarget({ session: { ...TARGETS[1] } }));
  assert.ok(!referencesTarget({ venue: TARGETS[0].venue, date: TARGETS[0].date, time: '10:20-12:15' }));
  assert.ok(referencesTarget({}, encodeURIComponent(`${TARGETS[0].venue}|${TARGETS[0].date}|${TARGETS[0].time}`)));
});
