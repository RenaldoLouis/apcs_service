const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createOrchestraSessionImporter } = require('../src/services/OrchestraSessionImport');

const fixtureFile = path.join(__dirname, 'public-ticket.audit.cjs');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').split("test('PUBLIC:")[0];
const context = { require, __dirname, module: { exports: {} } };
vm.runInNewContext(fixtureSource + '\nmodule.exports = fixture;', context, { filename: fixtureFile });
const fixture = context.module.exports;
const eventId = 'APCS2026';
const actor = { email: 'admin@example.invalid' };
const assignmentPath = id => `orchestraAssignments/${encodeURIComponent(`${eventId}|${id}`)}`;
const input = (...rows) => ({ eventId, sheetRows: [['Name', 'session'], ...rows] });

function setup(options) {
    const f = fixture(options);
    const event = f.records.get(`events/${eventId}`);
    event.orchestraSessions.push({ id: 'early', venue: 'V1', date: '2026-11-01', time: '15:30-17:30', complimentaryQuota: 2 });
    const repository = f.load('src/repositories/OrchestraAssignmentRepository.js');
    return { ...f, repository, event, importer: createOrchestraSessionImporter(repository) };
}

function seedGroup(f, id, names, overrides = {}) {
    f.seed(`Registrants2025/${id}`, { eventId, performers: names.map(fullName => ({ fullName })) });
    f.seed(`publicBookings/${id}-booking`, {
        eventId, registrantId: id, registrantName: names.join(', '), paymentStatus: 'PAID', ticketingVersion: 2,
        bookingType: 'winner', performerCount: names.length, orchestraAttendanceTickets: 2,
        tickets: [{ id: 'presto', quantity: 2 }], ...overrides,
    });
}

test('ORCHESTRA IMPORT: previews paid names and ensemble members, consolidates repeats and identifies conflicts', async () => {
    const f = setup();
    seedGroup(f, 'duet', ['Éva Example', 'Other Member']);
    seedGroup(f, 'conflict', ['First Member', 'Second Member']);
    seedGroup(f, 'same-1', ['Common Name']);
    seedGroup(f, 'same-2', ['Common Name']);
    seedGroup(f, 'pending', ['Unpaid Name'], { paymentStatus: 'pending' });
    seedGroup(f, 'different-event', ['Other Event'], { eventId: 'APCS2025' });
    seedGroup(f, 'direct', ['Direct Buyer'], { bookingType: 'public_orchestra', orchestraAttendanceTickets: 0 });
    seedGroup(f, 'ambiguous-session', ['Unknown Session']);
    f.event.orchestraSessions.push({ ...f.event.orchestraSessions[0], id: 'same-time', date: '2026-11-02' });
    const before = JSON.stringify([...f.records]);
    const preview = await f.importer.preview(input(
        ['  E\u0301VA  EXAMPLE (annotation (nested)) ', '15:30'], ['Other Member', '15:30'],
        ['First Member', '15:30'], ['Second Member', '19:00'], ['Common Name', '15:30'],
        ['Unpaid Name', '15:30'], ['Other Event', '15:30'], ['Direct Buyer', '15:30'], ['Unknown Session', '19:00'],
    ));
    assert.deepEqual(preview.rows.map(row => row.status), [
        'Ready', 'Included with earlier row', 'Conflicting times', 'Conflicting times', 'Multiple paid matches',
        'No paid match', 'No paid match', 'No paid match', 'Multiple sessions at this time',
    ]);
    assert.equal(preview.rows[0].registrantId, 'duet');
    assert.equal(preview.rows[0].session.id, 'early');
    assert.deepEqual(preview.summary, { sourceRows: 9, ready: 1, alreadyAssigned: 0, skipped: 7 });
    assert.equal(JSON.stringify([...f.records]), before);
});

test('ORCHESTRA IMPORT: applies confirmed assignments without email and preserves existing data', async () => {
    const f = setup();
    seedGroup(f, 'new-1', ['New One']);
    seedGroup(f, 'new-2', ['New Two', 'Third Member'], { paymentStatus: 'paid' });
    seedGroup(f, 'existing', ['Existing Name']);
    await f.repository.assignGroup({ eventId, registrantId: 'existing', sessionId: 'orch' }, actor);
    await f.repository.markNotified(encodeURIComponent(`${eventId}|existing`), 1, 'existing-booking');
    const eventBefore = f.records.get(`events/${eventId}`);
    const source = input(['Existing Name', '15:30'], ['New One', '15:30'], ['Third Member', '15:30']);
    const preview = await f.importer.preview(source);
    assert.equal(preview.summary.ready, 2);
    assert.equal(preview.rows[0].status, 'Already assigned');
    assert.equal(preview.rows[0].currentSession.time, '19:00-20:00');
    const before = new Map([...f.records].map(([key, value]) => [key, JSON.stringify(value)]));
    const controllerContext = { module: { exports: {} }, require: name => {
        if (name.endsWith('/OrchestraAssignmentRepository')) return f.repository;
        if (name.endsWith('/OrchestraSessionImport')) return { createOrchestraSessionImporter };
        if (name.endsWith('/firebase-init')) return {};
        if (name.endsWith('/EmailService')) return { sendOrchestraAssignmentEmail: () => assert.fail('Import must not send emails') };
        throw new Error(`Unexpected dependency: ${name}`);
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/controllers/OrchestraAssignmentController.js'), 'utf8'), controllerContext);
    let result;
    await controllerContext.module.exports.applyImport({ body: { ...source, previewKey: preview.previewKey }, ticketingAdmin: actor },
        { json: value => { result = value; } }, error => { throw error; });
    assert.equal(result.saved, 2);
    assert.equal(f.records.get(assignmentPath('new-1')).quantity, 3);
    assert.equal(f.records.get(assignmentPath('new-2')).quantity, 4);
    assert.equal(f.records.get(assignmentPath('new-1')).assignedBy, actor.email);
    assert.equal(f.records.get(assignmentPath('new-1')).notifiedBookingIds.length, 0);
    for (const [key, value] of before) {
        if (key !== `events/${eventId}`) assert.equal(JSON.stringify(f.records.get(key)), value, key);
    }
    const eventAfter = f.records.get(`events/${eventId}`);
    assert.equal(JSON.stringify(eventAfter), JSON.stringify({ ...eventBefore, orchestraSessions: [
        eventBefore.orchestraSessions[0], { ...eventBefore.orchestraSessions[1], freeSeatingAssigned: 7 },
    ] }));
    await assert.rejects(f.importer.apply({ ...source, previewKey: preview.previewKey }, actor), /out of date/);
    assert.equal((await f.importer.preview(source)).summary.ready, 0);
});

test('ORCHESTRA IMPORT: a concurrent assignment aborts the whole batch before any writes', async () => {
    let concurrentAssignment;
    const f = setup({ beforeTransaction: ({ seed }) => seed(assignmentPath('racing'), concurrentAssignment) });
    seedGroup(f, 'racing', ['Racing Registrant']);
    seedGroup(f, 'new', ['New Registrant']);
    const source = input(['Racing Registrant', '15:30'], ['New Registrant', '15:30']);
    const preview = await f.importer.preview(source);
    assert.equal(preview.summary.ready, 2);
    concurrentAssignment = { eventId, registrantId: 'racing', sessionId: 'orch', revision: 1, quantity: 3 };
    const before = JSON.stringify(f.records.get(`events/${eventId}`));
    await assert.rejects(f.importer.apply({ ...source, previewKey: preview.previewKey }, actor), /already exists/);
    assert.equal(JSON.stringify(f.records.get(assignmentPath('racing'))), JSON.stringify(concurrentAssignment));
    assert.equal(f.records.has(assignmentPath('new')), false);
    assert.equal(JSON.stringify(f.records.get(`events/${eventId}`)), before);
});

test('ORCHESTRA IMPORT: a changed timetable after preview requires a new preview', async () => {
    const f = setup();
    seedGroup(f, 'new', ['New Registrant']);
    const source = input(['New Registrant', '15:30']);
    const preview = await f.importer.preview(source);
    f.event.orchestraSessions[1].time = '15:30-18:00';
    await assert.rejects(f.importer.apply({ ...source, previewKey: preview.previewKey }, actor), /out of date/);
    assert.equal(f.records.has(assignmentPath('new')), false);
});

test('ORCHESTRA IMPORT: rejects wrong headers and marks invalid time rows', async () => {
    const f = setup();
    seedGroup(f, 'new', ['New Registrant']);
    await assert.rejects(f.importer.preview({ eventId, sheetRows: [['Name', 'Other'], ['New Registrant', '15:30']] }), /session column/);
    const preview = await f.importer.preview(input(['New Registrant', '3:30 PM']));
    assert.equal(preview.rows[0].status, 'Invalid name or time');
    assert.equal(preview.summary.ready, 0);
});
