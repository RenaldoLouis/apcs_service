// Offline tests of production import code. No credentials, network or live writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const xlsx = require('xlsx');
const { classifyAttendance, parseSheetRows, buildPlan, createAttendanceImporter } = require('../src/services/RegistrantAttendanceImport');
const { parseArguments } = require('../scripts/import_registrant_attendance');
const grid = (...rows) => [['No', ' Full Name ', ' Attendance '], ...rows.map((row, index) => [index + 1, ...row])];
const registration = (name, extra = {}) => ({ eventId: 'APCS2026', performers: [{ fullName: name }], ...extra });

function fixture(entries, options = {}) {
    const records = new Map(entries);
    let reads = 0;
    let transactions = 0;
    let beforeTransaction;
    const clone = value => JSON.parse(JSON.stringify(value));
    const document = id => ({ id, ref: { id }, exists: records.has(id), data: () => clone(records.get(id)) });
    const db = {
        collection(name) {
            assert.equal(name, 'Registrants2025');
            return {
                doc: id => ({ id }),
                orderBy(field) {
                    assert.equal(field, '__name__');
                    let cursor;
                    let pageSize;
                    const query = {
                        limit(size) { pageSize = size; return query; },
                        startAfter(doc) { cursor = doc.id; return query; },
                        async get() {
                            reads += 1;
                            return { docs: [...records.keys()].sort().filter(id => !cursor || id > cursor).slice(0, pageSize).map(document) };
                        },
                    };
                    return query;
                },
            };
        },
        async runTransaction(callback) {
            transactions += 1;
            if (beforeTransaction) beforeTransaction(transactions);
            if (options.failOnTransaction === transactions) throw new Error('Simulated unavailable Firestore');
            const writes = [];
            const transaction = {
                async get(ref) { assert.equal(writes.length, 0, 'all reads precede writes'); return document(ref.id); },
                update(ref, data) { assert.deepEqual(Object.keys(data), ['willAttend']); writes.push([ref.id, data]); },
            };
            const result = await callback(transaction);
            for (const [id, data] of writes) records.set(id, { ...records.get(id), ...data });
            return result;
        },
    };
    const importer = createAttendanceImporter(db, { secret: 'test-secret', ...options });
    return { records, importer, db, get reads() { return reads; }, get transactions() { return transactions; },
        beforeTransaction(fn) { beforeTransaction = fn; } };
}
const snapshots = preview => Object.fromEntries(preview.candidates.map(candidate => [candidate.id, candidate.snapshotToken]));

test('response patterns: affirmative notes, multiline responses, typo and attendance without performing', () => {
    const yes = ['Hadir', 'hadir', 'Hadir -- confirm by email, checked by Mic', 'Hadir - Confirm by Email and WA',
        'Hadir \nHadir - confirm by email', 'Hadir by whatsapp - confirm by Michaela', 'Hadri -- confrim by email check by Michaela',
        'Hadir, play Canon in D', 'Hadir tapi tidak mau main', 'Yes, 15 november', 'Yes, 14 november 2026', 'YES'];
    yes.forEach(response => assert.equal(classifyAttendance(response), true, response));
    const no = ['Tidak hadir', 'Tidak hadir, piala silver 1 + 1 diamond', 'Tidak Hadir', 'Reconfirm tidak hadir',
        'Tidak hadir by WA\nconfirm by wharsapp and email, belum bayar', 'tidak hair', 'NO', 'No', 'NO - VANESSA UDA SAY NO',
        '', '   ', 'YES/NO', 'pending - chat by Mic', 'tanggal 10 baru follow up', 'Tidak balas', 'Pengiriman piala, payment done',
        'yes, reconfirm tidak hadir', 'Hadrian', 'Yesterday'];
    no.forEach(response => assert.equal(classifyAttendance(response), false, response));
});

test('headers, blank rows and default-false responses survive CSV, XLSX and XLS parsing', () => {
    for (const bookType of ['csv', 'xlsx', 'xls']) {
        const workbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet([...grid(['A', 'Yes, 14 November'], ['B', '']), []]), 'First');
        xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(grid(['Wrong sheet', 'YES'])), 'Second');
        const buffer = xlsx.write(workbook, { type: 'buffer', bookType });
        const read = xlsx.read(buffer, { type: 'buffer', raw: false });
        const rows = xlsx.utils.sheet_to_json(read.Sheets[read.SheetNames[0]], { header: 1, defval: '', raw: false });
        assert.deepEqual(parseSheetRows(rows).map(row => row.willAttend), [true, false]);
    }
    assert.throws(() => parseSheetRows([['Full Name'], ['A']]), /Attendance column/);
    assert.throws(() => parseSheetRows([['Full Name', 'Attendance', 'attendance'], ['A', 'YES', 'NO']]), /exactly one/);
    assert.throws(() => parseSheetRows(grid(['', 'YES'])), /row 2/);
    assert.throws(() => parseSheetRows(grid(['A & ', 'YES'])), /incomplete ensemble/);
    assert.throws(() => parseSheetRows([['Full Name', 'Attendance'], ...Array(5001).fill(['A', 'YES'])]), /5,000/);
});

test('agreeing duplicate rosters deduplicate; contradictory duplicates require a choice or exclusion', () => {
    const groups = parseSheetRows(grid(['A & B', 'Hadir'], ['b & a', 'YES'], ['C', 'YES'], ['c', 'NO']));
    assert.equal(groups.length, 2);
    assert.equal(groups[0].willAttend, true);
    assert.equal(groups[1].willAttend, null);
    const candidates = [{ id: 'c', nameKey: 'c' }];
    assert.equal(buildPlan(groups, candidates).summary.conflicted, 1);
    assert.equal(buildPlan(groups, candidates, { 'row-4': { willAttend: false } }).updates[0].desired, false);
    assert.equal(buildPlan(groups, candidates, { 'row-4': { excluded: true } }).summary.conflicted, 0);
    assert.throws(() => buildPlan(groups, candidates, { unknown: {} }), /unknown preview row/);
});

test('all exact solos across both years match; a member never auto-matches an ensemble; complete rosters are unordered', async () => {
    const f = fixture([
        ['solo26', registration(' Alice  Smith ')], ['solo25', registration('alice smith', { eventId: 'APCS2025' })],
        ['legacy', registration('', { eventId: '', performers: [{ firstName: 'Alice', lastName: 'Smith' }] })],
        ['ensemble', registration('', { performers: [{ fullName: 'Bob' }, { fullName: 'Alice Smith' }] })],
        ['other', registration('Alice Smith', { eventId: 'APCS2024' })],
        ['contact', registration('Someone else', { name: 'Alice Smith' })],
        ['punctuation', registration('Ong Yu Xuan, Alyssa')],
    ]);
    const preview = await f.importer.preview({ sheetRows: grid(['ALICE SMITH', 'YES'], ['Alice Smith & bob', 'Hadir'], ['Ong Yu Xuan, Alyssa', 'YES']) });
    assert.deepEqual(preview.rows[0].matches.map(match => match.id).sort(), ['legacy', 'solo25', 'solo26']);
    assert.deepEqual(preview.rows[1].matches.map(match => match.id), ['ensemble']);
    assert.deepEqual(preview.rows[2].matches.map(match => match.id), ['punctuation']);
    assert.equal(preview.summary.registrations, 5);
});

test('candidate scanning paginates by ID and includes null/missing event IDs and missing createdAt', async () => {
    const f = fixture(Array.from({ length: 405 }, (_, index) => [String(index).padStart(4, '0'), {
        ...(index === 1 ? { eventId: null } : index === 2 ? { eventId: '   ' } : {}), performers: [{ fullName: `Name ${index}` }] }]));
    const preview = await f.importer.preview({ sheetRows: grid(['Name 404', 'YES']) });
    assert.equal(f.reads, 3);
    assert.equal(preview.candidates.length, 405);
    assert.equal(preview.rows[0].matches[0].eventId, 'APCS2025');
    assert.equal(preview.candidates.find(candidate => candidate.id === '0001').eventId, 'APCS2025');
    assert.equal(preview.candidates.find(candidate => candidate.id === '0002').eventId, 'APCS2025');
});

test('manual match selection and exclusions are explicit; contradictory targets are blocked', async () => {
    const f = fixture([['a', registration('Alice')], ['b', registration('Bob')]]);
    const sheetRows = grid(['Alicee', 'YES'], ['Bob', 'NO']);
    const resolutions = { 'row-2': { registrantIds: ['a'] }, 'row-3': { excluded: true } };
    const preview = await f.importer.preview({ sheetRows, resolutions });
    assert.equal(preview.rows[0].matchType, 'manual');
    const result = await f.importer.apply({ sheetRows, resolutions, snapshots: snapshots(preview) });
    assert.equal(result.summary.updated, 1);
    assert.equal(f.records.get('a').willAttend, true);
    assert.equal(f.records.get('b').willAttend, undefined);
    await assert.rejects(f.importer.preview({ sheetRows, resolutions: { 'row-2': { registrantIds: ['missing'] } } }), /valid APCS/);
    const conflicting = await f.importer.preview({ sheetRows, resolutions: { 'row-2': { registrantIds: ['b'] } } });
    assert.equal(conflicting.summary.conflicted, 2);
    assert.equal(conflicting.summary.registrations, 0);
    const excludedMissing = await f.importer.preview({ sheetRows, resolutions: { 'row-2': { registrantIds: ['deleted'], excluded: true } } });
    assert.equal(excludedMissing.rows[0].status, 'excluded');
});

test('only the attendance field changes; untouched records and all unrelated data are preserved', async () => {
    const original = registration('A', { paymentStatus: 'PAID', finalAward: 'Diamond', adminNote: 'keep', nested: { data: [1, 2] } });
    const f = fixture([['a', original], ['b', registration('B', { willAttend: true })], ['untouched', registration('C', { willAttend: false })]]);
    const sheetRows = grid(['A', 'YES'], ['B', 'NO'], ['Missing', 'NO']);
    const preview = await f.importer.preview({ sheetRows });
    const result = await f.importer.apply({ sheetRows, snapshots: snapshots(preview) });
    assert.equal(result.summary.updated, 2);
    assert.equal(result.summary.skipped, 1);
    assert.deepEqual(f.records.get('a'), { ...original, willAttend: true });
    assert.equal(f.records.get('untouched').willAttend, false);
});

test('lost-response retries and a fresh repeated import return unchanged without duplicate writes', async () => {
    const f = fixture([['a', registration('A')]]);
    const sheetRows = grid(['A', 'YES']);
    const preview = await f.importer.preview({ sheetRows });
    const request = { sheetRows, snapshots: snapshots(preview) };
    assert.equal((await f.importer.apply(request)).summary.updated, 1);
    assert.equal((await f.importer.apply(request)).summary.unchanged, 1);
    const refreshed = await f.importer.preview({ sheetRows });
    assert.equal((await f.importer.apply({ sheetRows, snapshots: snapshots(refreshed) })).summary.unchanged, 1);
});

test('a stale boolean, rename, changed event, forged token or new exact match cannot be overwritten', async () => {
    for (const change of ['boolean', 'name', 'event', 'forged', 'new']) {
        const f = fixture([['a', registration('A')]]);
        const sheetRows = grid(['A', 'YES']);
        const preview = await f.importer.preview({ sheetRows });
        const tokens = snapshots(preview);
        const resolutions = { 'row-2': { registrantIds: ['a'] } };
        if (change === 'boolean') f.records.get('a').willAttend = false;
        if (change === 'name') f.records.get('a').performers[0].fullName = 'Changed';
        if (change === 'event') f.records.get('a').eventId = 'APCS2025';
        if (change === 'forged') tokens.a = 'forged.token';
        if (change === 'new') f.records.set('b', registration('A'));
        const result = await f.importer.apply({ sheetRows, snapshots: tokens, ...(change === 'new' ? {} : { resolutions }) });
        assert.equal(result.summary.updated, 0, change);
        assert.ok(result.summary.conflictedRegistrations > 0, change);
    }
});

test('expired previews and tokens from another backend instance require another preview', async () => {
    let time = 0;
    const f = fixture([['a', registration('A')]], { now: () => time });
    const sheetRows = grid(['A', 'YES']);
    const preview = await f.importer.preview({ sheetRows });
    time = 3600001;
    const result = await f.importer.apply({ sheetRows, snapshots: snapshots(preview) });
    assert.equal(result.summary.conflictedRegistrations, 1);
    const otherImporter = createAttendanceImporter(f.db, { secret: 'different' });
    assert.equal((await otherImporter.apply({ sheetRows, snapshots: snapshots(preview) })).summary.updated, 0);
});

test('workers with a shared signing secret accept the same preview', async () => {
    const f = fixture([['a', registration('A')]]);
    const sheetRows = grid(['A', 'YES']);
    const preview = await f.importer.preview({ sheetRows });
    const worker = createAttendanceImporter(f.db, { secret: 'test-secret' });
    assert.equal((await worker.apply({ sheetRows, snapshots: snapshots(preview) })).summary.updated, 1);
});

test('invalid worksheet/resolution requests fail before database reads or writes', async () => {
    const f = fixture([['a', registration('A')]]);
    await assert.rejects(f.importer.preview({ sheetRows: [['Wrong'], ['A']] }), /Full Name column/);
    assert.equal(f.reads, 0);
    await assert.rejects(f.importer.apply({ sheetRows: grid(['A', 'YES']) }), /snapshots are required/);
    assert.equal(f.reads, 0);
    await assert.rejects(f.importer.preview({ sheetRows: grid(['A', 'YES']), resolutions: { 'row-2': { willAttend: 'yes' } } }), /Invalid resolution/);
    assert.equal(f.transactions, 0);
});

test('concurrent identity changes abort a chunk before any write; unrelated edits survive', async () => {
    const f = fixture([['a', registration('A')], ['b', registration('B')]]);
    const sheetRows = grid(['A', 'YES'], ['B', 'YES']);
    const preview = await f.importer.preview({ sheetRows });
    f.beforeTransaction(() => { f.records.get('b').performers[0].fullName = 'Changed'; });
    const result = await f.importer.apply({ sheetRows, snapshots: snapshots(preview) });
    assert.equal(result.summary.updated, 0);
    assert.equal(result.summary.conflictedRegistrations, 2);
    assert.equal(f.records.get('a').willAttend, undefined);
    const nextPreview = await f.importer.preview({ sheetRows: grid(['A', 'YES']) });
    f.beforeTransaction(() => { f.records.get('a').adminNote = 'concurrent unrelated edit'; });
    await f.importer.apply({ sheetRows: grid(['A', 'YES']), snapshots: snapshots(nextPreview) });
    assert.equal(f.records.get('a').adminNote, 'concurrent unrelated edit');
});

test('chunk failure preserves completed writes, reports unattempted records and supports safe retry', async () => {
    const f = fixture([['a', registration('A')], ['b', registration('B')], ['c', registration('C')]], { chunkSize: 1, failOnTransaction: 2 });
    const sheetRows = grid(['A', 'YES'], ['B', 'YES'], ['C', 'YES']);
    const preview = await f.importer.preview({ sheetRows });
    const result = await f.importer.apply({ sheetRows, snapshots: snapshots(preview) });
    assert.equal(result.summary.updated, 1);
    assert.equal(result.summary.failed, 2);
    assert.equal(f.records.get('a').willAttend, true);
    assert.equal(f.records.get('b').willAttend, undefined);
    assert.equal(f.records.get('c').willAttend, undefined);
    const refreshed = await f.importer.preview({ sheetRows });
    const retried = await f.importer.apply({ sheetRows, snapshots: snapshots(refreshed) });
    assert.equal(retried.summary.updated, 2);
    assert.equal(retried.summary.unchanged, 1);
});

test('CLI defaults to preview and requires an explicit target and recognized options', () => {
    assert.deepEqual(parseArguments(['--file', 'input.csv', '--target', 'emulator']), { file: 'input.csv', target: 'emulator' });
    assert.equal(parseArguments(['--file', 'input.xlsx', '--target', 'production', '--apply', '--resolutions', 'choices.json']).apply, true);
    assert.throws(() => parseArguments(['--file', 'input.csv']), /Usage/);
    assert.throws(() => parseArguments(['--file', 'input.csv', '--target', 'unknown']), /Usage/);
    assert.throws(() => parseArguments(['--target']), /value is required/);
    assert.throws(() => parseArguments(['--file', 'input.csv', '--target', 'emulator', '--force']), /Unknown/);
});

test('real admin middleware rejects missing/expired tokens and non-whitelisted accounts', async () => {
    const filename = path.join(__dirname, '../src/middlewares/TicketingAdminMiddleware.js');
    for (const scenario of ['missing', 'expired', 'unauthorized', 'allowed']) {
        const context = { module: { exports: {} }, require: () => ({
            admin: { auth: () => ({ verifyIdToken: async () => { if (scenario === 'expired') throw new Error('expired'); return { email: 'Admin@Example.invalid', uid: 'admin' }; } }) },
            db: { collection: () => ({ doc: email => { assert.equal(email, 'admin@example.invalid'); return { get: async () => ({ exists: scenario === 'allowed' }) }; } }) },
        }) };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
        const req = { headers: scenario === 'missing' ? {} : { authorization: 'Bearer test-token' } };
        let status;
        let nextCalled = false;
        const res = { status(code) { status = code; return res; }, json() {} };
        await context.module.exports.requireTicketingAdmin(req, res, () => { nextCalled = true; });
        assert.equal(nextCalled, scenario === 'allowed');
        if (scenario !== 'allowed') assert.equal(status, scenario === 'unauthorized' ? 403 : 401);
    }
    const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    for (const operation of ['preview', 'apply']) assert.ok(routeSource.includes(`router.post('/registrant-attendance/${operation}', requireTicketingAdmin, RegistrantAttendanceController.${operation})`));
});
