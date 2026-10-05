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
