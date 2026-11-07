// Offline: exercises production import, counter helpers and redemption with an in-memory database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { memoryDb } = require('./helpers/group-email-memory-db.cjs');
const { AppError } = require('../src/middlewares/ErrorHandlerMiddleware');
const importModel = require('../src/services/OrchestraImportModel');
const redemption = require('../src/services/TicketRedemptionModel');
const actor = { uid: 'staff', email: 'staff@example.invalid' };
const plain = value => JSON.parse(JSON.stringify(value));
function load(file, dependencies) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
        module, process: { env: {} }, require(name) {
            if (name in dependencies) return dependencies[name];
            throw new Error(`Unexpected dependency: ${name}`);
        },
    });
    return module.exports;
}
function fixture() {
    const event = { venues: [{ id: 'hall', label: 'Concert Hall' }],
        ticketTiers: [{ id: 'allegro', name: 'Allegro' }, { id: 'presto', name: 'Presto' }],
        orchestraSessions: [{ id: 's1', venue: 'hall', date: '2026-11-15', time: '10:00-12:00' },
            { id: 's2', venue: 'hall', date: '2026-11-15', time: '14:00-16:00' }] };
    const f = memoryDb(new Map([['events/APCS2026', event], ['seatsAPCS2026/unchanged', { status: 'booked' }]]));
    const firebase = { db: f.db, admin: { firestore: { FieldValue: { serverTimestamp: () => 12345 } } } };
    const helpers = load('repositories/PublicTicketRepository.js', {
        '../configs/firebase-init': firebase, '../utils/Logger': { logger: {} }, jsonwebtoken: {},
        './PaperRepository': {}, './PublicTicketFailureRepository': {}, '../middlewares/ErrorHandlerMiddleware': { AppError },
    });
    const repo = load('repositories/OrchestraImportRepository.js', {
        '../configs/firebase-init': firebase, '../middlewares/ErrorHandlerMiddleware': { AppError },
        '../services/OrchestraImportModel': importModel, './PublicTicketRepository': helpers,
    });
    const row = { buyerName: 'Example Buyer', userEmail: 'buyer@example.invalid', userPhone: '081234567890',
        quantity: 1, category: 'allegro', totalPaid: 125000, notes: 'Woodblock', sessionId: 's2',
        expectedSession: { venue: 'hall', date: '2026-11-15', time: '14:00-16:00' } };
    const input = { eventId: 'APCS2026', rows: [row] };
    const capacityId = helpers.capacityDocumentId('APCS2026', 'hall', row.expectedSession.date, row.expectedSession.time);
    return { ...f, event, input, row, capacityId, save: (data = input, staff = actor) => repo.importPaidOrchestraBookings(data, staff) };
}

test('import creates a paid free-seating booking with actual price, notes, staff audit and existing orchestra redemption', async () => {
    const f = fixture();
    const result = await f.save();
    assert.equal(result.imported, 1);
    const booking = f.records.get(`publicBookings/${result.bookingIds[0]}`);
    assert.equal(booking.paymentStatus, 'PAID');
    assert.equal(booking.bookingType, 'public_orchestra');
    assert.equal(booking.seatingMode, 'free');
    assert.equal(booking.totalAmount, 125000);
    assert.equal(booking.tickets[0].priceEach, 125000);
    assert.equal(booking.adminNote, 'Woodblock');
    assert.equal(booking.userPhone, '081234567890');
    assert.equal(booking.importAudit.actorUid, actor.uid);
    assert.equal(booking.emailSent, false);
    assert.equal(booking.orchestraAttendanceTickets, 0);
    const allowances = redemption.allowancesFor({ ...booking, id: result.bookingIds[0] }, f.event, null);
    assert.equal(allowances.length, 1);
    assert.equal(allowances[0].channel, 'orchestra');
    assert.equal(allowances[0].blockedReason, null);
    assert.deepEqual(plain(allowances[0].quantities), { allegro: 1 });
    assert.equal(f.records.get(`ticketCapacity/${f.capacityId}`).reservedByTier.allegro, 1);
    assert.deepEqual(f.records.get('seatsAPCS2026/unchanged'), { status: 'booked' });
    assert.equal([...f.records.keys()].some(key => key.startsWith('ticketRedemptions/')), false);
});

test('repeated upload and concurrent requests create one booking and increment capacity once', async () => {
    const f = fixture();
    const results = await Promise.all([f.save(), f.save()]);
    assert.deepEqual(results.map(result => result.imported).sort(), [0, 1]);
    assert.equal((await f.save()).skipped, 1);
    assert.equal(f.records.get(`ticketCapacity/${f.capacityId}`).reservedByTier.allegro, 1);
});

test('price or note corrections cannot silently create extra tickets or overwrite earlier imports', async () => {
    for (const change of [{ totalPaid: 90000 }, { notes: 'Changed' }]) {
        const f = fixture(); await f.save();
        const before = plain([...f.records]);
        await assert.rejects(f.save({ ...f.input, rows: [{ ...f.row, ...change }] }), /already exists with different/);
        assert.deepEqual(plain([...f.records]), before);
    }
});

test('missing counter bootstraps paid and pending demand; existing counter preserves blocked fields', async () => {
    for (const existingCounter of [false, true]) {
        const f = fixture();
        if (existingCounter) f.records.set(`ticketCapacity/${f.capacityId}`, { reservedByTier: { allegro: 5 }, blockedByTier: { presto: 1 } });
        else for (const [id, status, quantity] of [['paid', 'PAID', 2], ['held', 'pending', 3], ['expired', 'expired', 7]]) {
            f.records.set(`publicBookings/${id}`, { eventId: 'APCS2026', venue: 'hall', date: f.row.expectedSession.date,
                session: f.row.expectedSession.time, paymentStatus: status, tickets: [{ id: 'allegro', quantity }] });
        }
        await f.save();
        const counter = f.records.get(`ticketCapacity/${f.capacityId}`);
        assert.equal(counter.reservedByTier.allegro, 6);
        assert.equal(counter.capacityPolicy, 'staff_managed');
        if (existingCounter) assert.deepEqual(counter.blockedByTier, { presto: 1 });
    }
});

test('mixed categories and sessions update their own counters atomically', async () => {
    const f = fixture();
    const extra = { ...f.row, sessionId: 's1', category: 'presto', quantity: 3,
        expectedSession: { ...f.row.expectedSession, time: '10:00-12:00' } };
    const result = await f.save({ ...f.input, rows: [f.row, extra] });
    assert.equal(result.imported, 2);
    const counters = [...f.records].filter(([key]) => key.startsWith('ticketCapacity/')).map(([, value]) => value);
    assert.deepEqual(counters.map(value => plain(value.reservedByTier)), [{ allegro: 1 }, { presto: 3 }]);
});

test('changed timetable, missing session/venue/category, corrupt capacity and unauthorized staff reject without writes', async () => {
    for (const kind of ['timetable', 'session', 'venue', 'category', 'counter', 'actor']) {
        const f = fixture();
        if (kind === 'timetable') f.event.orchestraSessions[1].time = '15:00-17:00';
        if (kind === 'session') f.event.orchestraSessions = [];
        if (kind === 'venue') f.event.venues = [];
        if (kind === 'category') f.event.ticketTiers = [];
        if (kind === 'counter') f.records.set(`ticketCapacity/${f.capacityId}`, { reservedByTier: { allegro: -1 } });
        const before = plain([...f.records]);
        await assert.rejects(f.save(f.input, kind === 'actor' ? null : actor));
        assert.deepEqual(plain([...f.records]), before);
    }
});

test('invalid later row and duplicates reject the whole batch', async () => {
    for (const extra of [{ quantity: 0 }, { totalPaid: -1 }, { userEmail: 'bad' }, { category: 'lento' }, {}]) {
        const f = fixture();
        const before = plain([...f.records]);
        await assert.rejects(f.save({ ...f.input, rows: [f.row, { ...f.row, ...extra }] }));
        assert.deepEqual(plain([...f.records]), before);
    }
});

test('server normalization enforces limits, primitive types, required snapshot and safe currency values', () => {
    const f = fixture();
    for (const change of [{ quantity: '1' }, { quantity: 1.5 }, { quantity: 1001 }, { totalPaid: '' },
        { totalPaid: Number.MAX_SAFE_INTEGER + 1 }, { notes: 'x'.repeat(2001) }, { expectedSession: null },
        { userPhone: 8111530688 }, { userEmail: 'a@example.com,b@example.com' }, { sessionId: 'bad/id' }]) {
        assert.throws(() => importModel.normalizeImport({ ...f.input, rows: [{ ...f.row, ...change }] }));
    }
    assert.throws(() => importModel.normalizeImport({ ...f.input, rows: [] }));
    assert.throws(() => importModel.normalizeImport({ ...f.input, rows: Array(101).fill(f.row) }));
});

test('a session change during a transaction retry is rejected', async () => {
    const f = fixture();
    const original = f.db.runTransaction;
    f.db.runTransaction = async operation => {
        await operation({ get: ref => ref.get(), set() {}, update() {} });
        f.event.orchestraSessions[1].date = '2026-11-16';
        return original(operation);
    };
    await assert.rejects(f.save(), /timetable changed/);
    assert.equal([...f.records.keys()].some(key => key.startsWith('publicBookings/')), false);
});

test('import route requires the existing ticketing-admin middleware', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    assert.match(routes, /router\.post\('\/public-ticket\/admin\/import-orchestra', requireTicketingAdmin,/);
});

test('mixed repeat and new rows only reserve new tickets, and commit failure writes nothing', async () => {
    const f = fixture();
    await f.save();
    const extra = { ...f.row, userEmail: 'second@example.invalid', quantity: 2 };
    const input = { ...f.input, rows: [f.row, extra] };
    const before = plain([...f.records]);
    f.db.commitHook = () => { throw new Error('Commit failed'); };
    await assert.rejects(f.save(input), /Commit failed/);
    assert.deepEqual(plain([...f.records]), before);
    f.db.commitHook = null;
    const result = await f.save(input);
    assert.equal(result.imported, 1); assert.equal(result.skipped, 1);
    assert.equal(f.records.get(`ticketCapacity/${f.capacityId}`).reservedByTier.allegro, 3);
});

test('normalization recognizes an equivalent email/name/phone representation on reimport', async () => {
    const f = fixture(); await f.save();
    const result = await f.save({ ...f.input, rows: [{ ...f.row, buyerName: ' EXAMPLE  BUYER ',
        userEmail: 'BUYER@EXAMPLE.INVALID', userPhone: '+62 812 3456 7890' }] });
    assert.equal(result.imported, 0); assert.equal(result.skipped, 1);
});

test('malformed or overflowing counters reject the whole import', async () => {
    for (const reservedByTier of [[], { allegro: Number.MAX_SAFE_INTEGER }, { allegro: '3' }]) {
        const f = fixture();
        f.records.set(`ticketCapacity/${f.capacityId}`, { reservedByTier });
        const before = plain([...f.records]);
        await assert.rejects(f.save(), /counter/);
        assert.deepEqual(plain([...f.records]), before);
    }
});
