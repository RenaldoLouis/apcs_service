const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const records = new Map();
  records.set('events/E1', {
    venues: [{ id: 'V1', sessions: { '2026-11-01': ['19:00-20:00'] }, seatConfig: [{ areaType: 'presto', row: 'A', seatCount: 2 }] }],
    orchestraSessions: [{ id: 'O1', venue: 'V1', date: '2026-11-01', time: '19:00-20:00' }],
    ticketTiers: [{ id: 'presto', venuePrices: { V1: 100 } }],
  });
  records.set('systemSettings/global', { ticketEligibility: { enabled: false } });
  records.set('Registrants2025/R1', { eventId: 'E1' });
  const snapshot = key => ({
    id: key.split('/').pop(), ref: { key }, exists: records.has(key), data: () => records.get(key),
  });
  const query = (name, filters = [], limitCount = Infinity) => ({
    query: true,
    where: (field, operator, value) => query(name, [...filters, [field, value]], limitCount),
    limit: count => query(name, filters, count),
    get: async () => {
      const docs = [...records.keys()].filter(key => key.startsWith(name + '/') && key.slice(name.length + 1).indexOf('/') < 0)
        .filter(key => filters.every(([field, value]) => records.get(key)?.[field] === value))
        .slice(0, limitCount).map(snapshot);
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  });
  const collection = name => ({
    ...query(name),
    doc: id => {
      const key = name + '/' + id;
      return { key, collection: sub => collection(key + '/' + sub), get: async () => snapshot(key) };
    },
  });
  const db = {
    collection,
    runTransaction: async callback => {
      const writes = [];
      const tx = {
        get: async ref => {
          if (writes.length) throw new Error('Read after write in Firestore transaction.');
          return ref.query ? ref.get() : snapshot(ref.key);
        },
        set: (ref, data, options) => writes.push(['set', ref.key, data, options]),
        update: (ref, data) => writes.push(['update', ref.key, data]),
        delete: ref => writes.push(['delete', ref.key]),
      };
      const result = await callback(tx);
      for (const [type, key, data, options] of writes) {
        if (type === 'delete') { records.delete(key); continue; }
        const value = type === 'set' && !options?.merge ? {} : { ...records.get(key) };
        for (const [field, next] of Object.entries(data)) {
          if (field.includes('.')) {
            const [parent, child] = field.split('.');
            value[parent] = { ...(value[parent] || {}), [child]: next };
          } else value[field] = next;
        }
        records.set(key, value);
      }
      return result;
    },
  };
  const filename = path.join(__dirname, '../src/repositories/CompetitionPlanningRepository.js');
  let uuidCounter = 0;
  const context = {
    module: { exports: {} },
    require: name => name === 'crypto' ? { randomUUID: () => `id-${++uuidCounter}` }
      : name.endsWith('firebase-init') ? { db, admin: { firestore: { FieldValue: { serverTimestamp: () => 'now' } } } }
        : (() => { throw new Error('Unexpected dependency ' + name); })(),
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { repo: context.module.exports, records };
}

test('PLANNING: draft can be timed later and publishes one assignment only after validation', async () => {
  const f = fixture();
  const group = await f.repo.saveGroup('E1', {
    venueId: 'V1', date: '2026-11-01', ordinal: 1, label: 'Group 1', registrantIds: ['R1'],
  });
  assert.equal(group.start, null);
  assert.equal((await f.repo.previewPublication('E1')).canPublish, false);
  const slot = await f.repo.saveSlot('E1', 1, {
    venueId: 'V1', date: '2026-11-01', start: null, end: null,
  });
  const slotId = slot.draftSlots[0].slotId;
  await f.repo.saveGroup('E1', {
    groupId: group.groupId, venueId: 'V1', date: '2026-11-01', ordinal: 1,
    label: 'Group 1', slotId, registrantIds: ['R1'],
  });
  assert.equal((await f.repo.previewPublication('E1')).canPublish, false);
  await f.repo.saveSlot('E1', 3, {
    slotId, venueId: 'V1', date: '2026-11-01', start: '09:00', end: '10:30',
  });
  const preview = await f.repo.previewPublication('E1');
  assert.equal(preview.canPublish, true);
  await assert.rejects(f.repo.publish('E1', preview.revision - 1, { uid: 'admin' }), /Schedule changed/);
  assert.equal(f.records.has('sessionAssignments/E1'), false);
  const result = await f.repo.publish('E1', preview.revision, { uid: 'admin' });
  assert.equal(result.publishedSlots, 1);
  assert.equal(f.records.get('events/E1').venues[0].sessions['2026-11-01'].join(','), '09:00-10:30,19:00-20:00');
  assert.equal(f.records.get('sessionAssignments/E1').assignments['V1_2026-11-01_09:00-10:30'][0].registrantId, 'R1');
  await assert.rejects(f.repo.saveGroup('E1', {
    groupId: group.groupId, venueId: 'V1', date: '2026-11-01', ordinal: 1,
    label: 'Changed', start: '09:00', end: '11:00', registrantIds: ['R1'],
  }), /cannot be edited/);
  const notReady = await f.repo.markReady('E1', { uid: 'admin' });
  assert.equal(notReady.ready, false);
  for (let number = 1; number <= 2; number++) {
    f.records.set('seatsE1/A' + number, { venueId: 'V1', sessionId: '2026-11-01_09:00-10:30', areaType: 'presto', row: 'A', number });
  }
  assert.equal((await f.repo.markReady('E1', { uid: 'admin' })).ready, true);
  assert.equal(f.records.get('events/E1').competitionScheduleState.status, 'ready');
});

test('PLANNING: existing ticket activity cannot activate a draft', async () => {
  const f = fixture();
  f.records.set('publicBookings/B1', { eventId: 'E1', paymentStatus: 'PAID' });
  await assert.rejects(f.repo.saveGroup('E1', {
    venueId: 'V1', date: '2026-11-01', ordinal: 1, label: 'Group 1', registrantIds: ['R1'],
  }), /reconciliation/);
  assert.equal(f.records.get('events/E1').competitionScheduleState, undefined);
});

test('PLANNING: archived APCS test bookings do not block a fresh draft', async () => {
  const f = fixture();
  f.records.set('publicBookings/B1', { eventId: 'E1', paymentStatus: 'archived_test' });
  const group = await f.repo.saveGroup('E1', {
    venueId: 'V1', date: '2026-11-01', ordinal: 1, label: 'Group 1', registrantIds: ['R1'],
  });
  assert.equal(group.start, null);
  assert.equal(f.records.get('events/E1').competitionScheduleState.status, 'draft');
});

test('PLANNING BOARD: a cross-group move saves atomically and rejects a stale revision', async () => {
  const f = fixture();
  f.records.set('Registrants2025/R2', { eventId: 'E1' });
  const first = await f.repo.saveDraft('E1', 0, [
    { groupId: 'G1', venueId: 'V1', date: '2026-11-01', label: 'Group 1', registrantIds: ['R1'] },
    { groupId: 'G2', venueId: 'V1', date: '2026-11-01', label: 'Group 2', registrantIds: ['R2'] },
  ]);
  assert.equal(first.revision, 1);
  const moved = await f.repo.saveDraft('E1', 1, [
    { groupId: 'G1', venueId: 'V1', date: '2026-11-01', label: 'Group 1', registrantIds: ['R2'] },
    { groupId: 'G2', venueId: 'V1', date: '2026-11-01', label: 'Group 2', registrantIds: ['R1'] },
  ]);
  assert.equal(moved.revision, 2);
  assert.equal(f.records.get('competitionSessionPlans/E1/groups/G1').registrantIds.join(','), 'R2');
  assert.equal(f.records.get('competitionSessionPlans/E1/groups/G2').registrantIds.join(','), 'R1');
  await assert.rejects(f.repo.saveDraft('E1', 1, []), /Draft changed/);
  assert.equal(f.records.get('competitionSessionPlans/E1/groups/G1').registrantIds.join(','), 'R2');
  assert.equal(f.records.get('competitionSessionPlans/E1/groups/G2').registrantIds.join(','), 'R1');
});

test('PLANNING BOARD: a clean event can start with an empty draft', async () => {
  const f = fixture();
  const started = await f.repo.saveDraft('E1', 0, []);
  assert.equal(started.revision, 1);
  assert.equal(started.groups.length, 0);
  assert.equal(f.records.get('events/E1').competitionScheduleState.status, 'draft');
  assert.equal((await f.repo.previewPublication('E1')).canPublish, false);
});

test('PLANNING BOARD: selected draft session controls group time and cannot serve two groups', async () => {
  const f = fixture();
  await f.repo.saveDraft('E1', 0, []);
  const saved = await f.repo.saveSlot('E1', 1, {
    venueId: 'V1', date: '2026-11-01', start: '09:00', end: '10:00',
  });
  const slotId = saved.draftSlots[0].slotId;
  const group = { groupId: 'G1', venueId: 'V1', date: '2026-11-01',
    label: 'Group 1', slotId, start: '15:00', end: '16:00', registrantIds: ['R1'] };
  await f.repo.saveDraft('E1', 2, [group]);
  assert.equal(f.records.get('competitionSessionPlans/E1/groups/G1').start, '09:00');
  await assert.rejects(f.repo.saveDraft('E1', 3, [group, {
    ...group, groupId: 'G2', label: 'Group 2', registrantIds: [],
  }]), /unused session/);
  await assert.rejects(f.repo.deleteSlot('E1', slotId, 3), /Unlink/);
  await f.repo.saveSlot('E1', 3, {
    slotId, venueId: 'V1', date: '2026-11-01', start: '09:00', end: '10:30',
  });
  assert.equal(f.records.get('competitionSessionPlans/E1/groups/G1').end, '10:30');
  assert.equal((await f.repo.previewPublication('E1')).canPublish, true);
});

test('PLANNING BOARD: duplicate performers and active ticket data reject the whole board', async () => {
  const f = fixture();
  f.records.set('publicBookings/B1', { eventId: 'E1', paymentStatus: 'PAID' });
  const group = { groupId: 'G1', venueId: 'V1', date: '2026-11-01', label: 'Group 1', registrantIds: ['R1'] };
  await assert.rejects(f.repo.saveDraft('E1', 0, [group]), /reconciliation/);
  assert.equal(f.records.has('competitionSessionPlans/E1/groups/G1'), false);
  f.records.delete('publicBookings/B1');
  await assert.rejects(f.repo.saveDraft('E1', 0, [group, { ...group, groupId: 'G2' }]), /already in another group/);
  assert.equal(f.records.has('competitionSessionPlans/E1/groups/G1'), false);
});

test('PLANNING: an orchestra overlap blocks the atomic publish projection', async () => {
  const f = fixture();
  const group = await f.repo.saveGroup('E1', {
    venueId: 'V1', date: '2026-11-01', ordinal: 1, label: 'Group 1',
    registrantIds: ['R1'],
  });
  const saved = await f.repo.saveSlot('E1', 1, {
    venueId: 'V1', date: '2026-11-01', start: '19:30', end: '20:30',
  });
  await f.repo.saveGroup('E1', {
    groupId: group.groupId, venueId: 'V1', date: '2026-11-01', ordinal: 1,
    label: 'Group 1', slotId: saved.draftSlots[0].slotId, registrantIds: ['R1'],
  });
  const preview = await f.repo.previewPublication('E1');
  assert.equal(preview.canPublish, false);
  assert.match(preview.errors.join(' '), /overlaps/);
  await assert.rejects(f.repo.publish('E1', preview.revision, { uid: 'admin' }), /Publication blocked/);
  assert.equal(f.records.has('sessionAssignments/E1'), false);
  assert.equal(f.records.get('events/E1').competitionScheduleState.status, 'draft');
});

test('PLANNING RESET: both Paper callback routes ignore archived test bookings', async () => {
  let registrationReads = 0;
  const db = {
    collection: name => ({
      doc: () => ({
        get: async () => {
          if (name === 'Registrants2025') registrationReads++;
          return { exists: name === 'publicBookings', data: () => ({ paymentStatus: 'archived_test' }) };
        },
      }),
    }),
  };
  const loadController = (filename, stubs) => {
    const source = fs.readFileSync(path.join(__dirname, '../src/controllers', filename), 'utf8');
    const context = {
      module: { exports: {} }, console: { log() {} },
      require: name => name.endsWith('firebase-init') ? { db, admin: {} }
        : name.endsWith('/Logger') || name.endsWith('/Logger.js') ? { logger: { info() {}, error() {} } }
          : stubs[name] || {},
    };
    vm.runInNewContext(source, context, { filename });
    return context.module.exports;
  };
  const paper = loadController('PaperController.js', {});
  const publicTicket = loadController('PublicTicketController.js', {});
  const response = () => ({
    status(code) { this.code = code; return this; },
    json(data) { this.data = data; return this; },
  });
  const request = { body: { invoice: { status: 'paid', number: 'old-test' } } };
  const paperResponse = response();
  await paper.handlePaperWebhook(request, paperResponse, error => { throw error; });
  assert.equal(paperResponse.code, 200);
  assert.equal(paperResponse.data.status, 'IGNORED_TEST_RESET');
  const publicResponse = response();
  await publicTicket.handlePublicTicketWebhook(request, publicResponse, error => { throw error; });
  assert.equal(publicResponse.code, 200);
  assert.equal(publicResponse.data.status, 'IGNORED_TEST_RESET');
  assert.equal(registrationReads, 0);
});
