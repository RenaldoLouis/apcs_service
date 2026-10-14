const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function fixture() {
    let event = { competitionScheduleState: { status: 'ready', revision: 7 }, venues: [
        { id: 'V1', label: 'Behring', imageUrl: 'https://example.com/old.svg', sessions: { date: ['09:00'] }, seatConfig: [{ row: 'A', seatCount: 10 }], extra: true },
        { id: 'V2', label: 'Other' },
    ] };
    const db = { collection: () => ({ doc: () => ({}) }), runTransaction: async callback => callback({
        get: async () => ({ exists: true, data: () => event }),
        update: (_, data) => { event = { ...event, ...data }; },
    }) };
    const context = { module: { exports: {} }, URL, require: () => ({ db }) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/repositories/VenueRepository.js'), 'utf8'), context);
    return { repo: context.module.exports, event: () => event };
}
const payload = { label: 'Behring Theatre', imageUrl: 'https://example.com/Behring-01.svg', expected: { label: 'Behring', imageUrl: 'https://example.com/old.svg' } };
test('image edit succeeds for a ready planning event and preserves schedules, layout and other venues', async () => {
    const f = fixture();
    const before = JSON.stringify(f.event());
    await f.repo.updateMetadata('E1', 'V1', { ...payload, sessions: {}, seatConfig: [] });
    const expected = JSON.parse(before);
    expected.venues[0].label = payload.label;
    expected.venues[0].imageUrl = payload.imageUrl;
    assert.equal(JSON.stringify(f.event()), JSON.stringify(expected));
});
test('stale metadata cannot overwrite another administrator', async () => {
    const f = fixture();
    const before = JSON.stringify(f.event());
    await assert.rejects(f.repo.updateMetadata('E1', 'V1', { ...payload, expected: { label: 'Stale', imageUrl: '' } }), /Venue changed/);
    assert.equal(JSON.stringify(f.event()), before);
});
test('unknown venue and invalid image URLs are rejected', async () => {
    const f = fixture();
    await assert.rejects(f.repo.updateMetadata('E1', 'missing', payload), /no longer exists/);
    await assert.rejects(f.repo.updateMetadata('E1', 'V1', { ...payload, imageUrl: 'javascript:alert(1)' }), /HTTPS/);
});
test('metadata route requires ticketing administrator authentication', () => {
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    assert.match(route, /router.post\('\/venue-settings\/:eventId\/:venueId\/metadata', requireTicketingAdmin, VenueController.updateMetadata\)/);
});

// Execute both repositories against the shared ticketing fixture; queries inspect real fixture records.
function layoutFixture() {
    const filename = path.join(__dirname, 'public-ticket.audit.cjs');
    const source = fs.readFileSync(filename, 'utf8').split("test('PUBLIC:")[0]
        .replace('return { records, seed, timestamp', 'return { db, records, seed, timestamp');
    const context = { require, __dirname, module: { exports: {} } };
    vm.runInNewContext(source + '\nmodule.exports = fixture;', context, { filename });
    const f = context.module.exports({ extraRequire: (name, load) => name === './PublicTicketRepository'
        ? load('src/repositories/PublicTicketRepository.js') : undefined });
    const load = f.load;
    f.load = relative => {
        if (!relative.endsWith('/VenueRepository.js')) return load(relative);
        const venueContext = { module: { exports: {} }, URL, require: () => ({ db: f.db }) };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', relative), 'utf8'), venueContext);
        return venueContext.module.exports;
    };
    return f;
}
function layoutPayload(f) {
    const venue = f.records.get('events/APCS2026').venues[0];
    return { label: 'Updated Hall', imageUrl: 'https://example.com/hall.svg',
        seatConfig: [{ row: 'A', seatCount: 12, areaType: 'Presto' }],
        expected: { label: venue.label, imageUrl: venue.imageUrl || '', seatConfig: venue.seatConfig } };
}
for (const status of ['draft', 'published', 'ready']) {
    test(`layout can change in ${status} when this venue has no numbered seats`, async () => {
        const f = layoutFixture();
        f.records.get('events/APCS2026').competitionScheduleState = { status, revision: 9 };
        // Another venue's inventory must not lock this venue.
        f.seat('other-venue', { venueId: 'V2' });
        const before = JSON.parse(JSON.stringify(f.records.get('events/APCS2026')));
        const payload = layoutPayload(f);
        await f.load('src/repositories/VenueRepository.js').updateLayout('APCS2026', 'V1', { ...payload, sessions: {} });
        const after = f.records.get('events/APCS2026');
        assert.equal(JSON.stringify(after.venues[0].seatConfig), JSON.stringify(payload.seatConfig));
        assert.equal(JSON.stringify(after.venues[0].sessions), JSON.stringify(before.venues[0].sessions));
        assert.equal(JSON.stringify(after.competitionScheduleState), JSON.stringify(before.competitionScheduleState));
    });
}
for (const status of ['available', 'locked', 'booked', 'reserved']) {
    test(`existing ${status} seats block the layout save without partial metadata updates`, async () => {
        const f = layoutFixture(); f.seat('existing', { status });
        const before = JSON.stringify(f.records.get('events/APCS2026'));
        await assert.rejects(f.load('src/repositories/VenueRepository.js').updateLayout('APCS2026', 'V1', layoutPayload(f)), /numbered seats already exist/);
        assert.equal(JSON.stringify(f.records.get('events/APCS2026')), before);
        await f.load('src/repositories/VenueRepository.js').updateMetadata('APCS2026', 'V1', layoutPayload(f));
        assert.equal(f.records.get('events/APCS2026').venues[0].label, 'Updated Hall');
    });
}
test('layout save rejects stale layouts, duplicate rows and invalid capacity/tier', async () => {
    const f = layoutFixture(); const repo = f.load('src/repositories/VenueRepository.js');
    const payload = layoutPayload(f);
    await assert.rejects(repo.updateLayout('APCS2026', 'V1', { ...payload, expected: { ...payload.expected, seatConfig: [] } }), /layout changed/);
    for (const seatConfig of [[], [{ row: 'A', seatCount: 0, areaType: 'Presto' }],
        [{ row: 'A', seatCount: 1, areaType: 'Invalid' }],
        [{ row: 'A', seatCount: 1, areaType: 'Presto' }, { row: 'a', seatCount: 2, areaType: 'Allegro' }]]) {
        await assert.rejects(repo.updateLayout('APCS2026', 'V1', { ...payload, seatConfig }), /unique row letters/);
    }
});
test('generation rejects a layout changed after its initial read, before creating seats', async () => {
    const f = layoutFixture();
    const original = f.db.runTransaction;
    f.db.runTransaction = async callback => {
        const current = f.records.get('events/APCS2026');
        f.seed('events/APCS2026', { ...current, venues: current.venues.map(v => ({ ...v, seatConfig: [{ row: 'Z', seatCount: 2, areaType: 'Presto' }] })) });
        return original(callback);
    };
    await assert.rejects(f.load('src/repositories/TicketSeatAdminRepository.js').generateSeatLayout({
        eventId: 'APCS2026', venueId: 'V1', sessionIds: ['2026-11-01_09:00-10:00'],
    }), /Venue layout or schedule changed/);
    assert.equal([...f.records.keys()].filter(key => key.startsWith('seatsAPCS2026/')).length, 0);
});
test('seat generation locks future layout edits and metadata still saves', async () => {
    const f = layoutFixture();
    await f.load('src/repositories/TicketSeatAdminRepository.js').generateSeatLayout({
        eventId: 'APCS2026', venueId: 'V1', sessionIds: ['2026-11-01_09:00-10:00'],
    });
    const repo = f.load('src/repositories/VenueRepository.js');
    await assert.rejects(repo.updateLayout('APCS2026', 'V1', layoutPayload(f)), /numbered seats already exist/);
    await repo.updateMetadata('APCS2026', 'V1', layoutPayload(f));
});
test('layout route requires the same ticketing administrator authentication', () => {
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    assert.match(route, /router.post\('\/venue-settings\/:eventId\/:venueId\/layout', requireTicketingAdmin, VenueController.updateLayout\)/);
});
