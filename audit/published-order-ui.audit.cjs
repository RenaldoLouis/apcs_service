// Exercise actual UI callbacks without launching a browser or touching Firebase.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,
  '../../apcs_web/src/components/molecules/AdminContentComponent/SessionAssignmentManager.js'), 'utf8');
function callback(name, context) {
  const start = source.indexOf(`const ${name} = useCallback(`);
  assert.ok(start >= 0);
  const end = source.indexOf('\n    }, [', start);
  return vm.runInNewContext(`${source.slice(start, end + 6)}); ${name}`, { useCallback: fn => fn, ...context });
}
function fixture(response = { data: { revision: 8, status: 'ready' } }) {
  const saved = { P1: [{ id: 'R1' }, { id: 'R2' }], P2: [{ id: 'R3' }], A1: [{ id: 'R1' }] };
  const changed = { ...saved, P1: [...saved.P1].reverse() };
  const calls = [], errors = [], success = [], saving = [];
  let initial = saved;
  let planning = { status: 'ready', revision: 7, groups: Object.entries(saved).map(([groupId, members]) =>
    ({ groupId, registrantIds: members.map(member => member.id) })) };
  const context = {
    saving: false, planningBusy: false, canReorderPublished: true, isPlanning: true, readOnly: true,
    assignments: changed, initialAssignments: saved, sessions: [],
    performanceSessions: [{ id: 'P1' }, { id: 'P2' }], eventId: 'E1', planningState: planning,
    setSaving: value => saving.push(value),
    setPlanningState: fn => { planning = fn(planning); },
    setInitialAssignments: value => { initial = value; },
    apis: { competitionPlanning: { reorderPublished: async (...args) => { calls.push(args); return response; } } },
    message: { success: value => success.push(value), error: value => errors.push(value) },
    console: { error() {} },
  };
  return { context, calls, errors, success, saving, saved, changed, initial: () => initial, planning: () => planning };
}
test('ORDER UI: saves only changed performance order and synchronizes local revision', async () => {
  const f = fixture();
  await callback('handleSave', f.context)();
  assert.equal(JSON.stringify(f.calls), JSON.stringify([['E1', 7, [{ groupId: 'P1', registrantIds: ['R2', 'R1'] }]]]));
  assert.equal(f.planning().revision, 8);
  assert.equal(f.planning().groups.find(group => group.groupId === 'P1').registrantIds.join(','), 'R2,R1');
  assert.equal(f.planning().groups.find(group => group.groupId === 'A1').registrantIds.join(','), 'R1');
  assert.equal(f.initial(), f.changed);
  assert.equal(f.success.length, 1);
  assert.deepEqual(f.saving, [true, false]);
});
for (const response of [{ error: { data: { message: 'Schedule changed. Refresh.' } } }, undefined,
  { data: { revision: 9, status: 'ready' } }, { data: { revision: 8, status: 'published' } }]) {
  test(`ORDER UI: failed/unconfirmed save retains draft ${JSON.stringify(response)}`, async () => {
    const f = fixture();
    f.context.apis.competitionPlanning.reorderPublished = async () => response;
    await callback('handleSave', f.context)();
    assert.equal(f.initial(), f.saved);
    assert.equal(f.planning().revision, 7);
    assert.equal(f.errors.length, 1);
    assert.equal(f.success.length, 0);
    assert.deepEqual(f.saving, [true, false]);
  });
}
test('ORDER UI: network failure retains draft and clears saving', async () => {
  const f = fixture();
  f.context.apis.competitionPlanning.reorderPublished = async () => { throw new Error('Network failure'); };
  await callback('handleSave', f.context)();
  assert.equal(f.initial(), f.saved);
  assert.deepEqual(f.saving, [true, false]);
  assert.equal(f.errors[0], 'Network failure');
});
test('ORDER UI: no-op and busy saves make no request', async () => {
  for (const patch of [{ saving: true }, { planningBusy: true }, { assignments: null }]) {
    const f = fixture();
    Object.assign(f.context, patch);
    if (patch.assignments === null) f.context.assignments = f.saved;
    await callback('handleSave', f.context)();
    assert.equal(f.calls.length, 0);
    assert.equal(f.errors.length, 0);
  }
});
test('ORDER UI: reorder uses full-list indices, rejects invalid indices and locks during saves', () => {
  const f = fixture();
  let assignments = f.saved;
  const context = { ...f.context, setAssignments: fn => { assignments = fn(assignments); } };
  callback('moveWithinSession', context)('P1', 0, 1);
  assert.equal(assignments.P1.map(item => item.id).join(','), 'R2,R1');
  assert.equal(f.saved.P1.map(item => item.id).join(','), 'R1,R2');
  const before = JSON.stringify(assignments);
  for (const args of [['P1', -1, 0], ['P1', 0, 99], ['P1', 0.5, 1], ['A1', 0, 1]]) {
    callback('moveWithinSession', context)(...args);
    assert.equal(JSON.stringify(assignments), before);
  }
  for (const patch of [{ saving: true }, { planningBusy: true }, { canReorderPublished: false }]) {
    callback('moveWithinSession', { ...context, ...patch })('P1', 0, 1);
    assert.equal(JSON.stringify(assignments), before);
  }
  callback('handleDrop', context)('R1', 'P1', 'P2');
  assert.equal(JSON.stringify(assignments), before, 'Published cross-group drop is blocked');
});
test('ORDER UI: card drop accepts only its own published group; session drop remains locked', () => {
  const card = source.slice(source.indexOf('const DraggableCard ='), source.indexOf('// SessionDropZone Component'));
  const start = card.indexOf('useDrop(') + 'useDrop('.length;
  const end = card.indexOf('\n    });', start) + '\n    }'.length;
  const moves = [];
  const spec = vm.runInNewContext(`(${card.slice(start, end)})`, {
    ITEM_TYPE: 'card', readOnly: true, allowReorder: true, sessionId: 'P1', index: 1,
    ref: { current: { getBoundingClientRect: () => ({ top: 0, bottom: 100 }) } },
    moveWithinSession: (...args) => moves.push(args),
  });
  assert.equal(spec.canDrop({ sourceSessionId: 'P1' }), true);
  assert.equal(spec.canDrop({ sourceSessionId: 'P2' }), false);
  assert.equal(spec.canDrop({ sourceSessionId: null }), false);
  spec.hover({ sourceSessionId: 'P2', index: 0 }, { getClientOffset: () => ({ y: 80 }) });
  assert.equal(moves.length, 0);
  spec.hover({ sourceSessionId: 'P1', index: 0 }, { getClientOffset: () => ({ y: 80 }) });
  assert.equal(JSON.stringify(moves), JSON.stringify([['P1', 0, 1]]));
  assert.match(source.slice(source.indexOf('const SessionDropZone =')), /canDrop: \(\) => !readOnly/);
});
