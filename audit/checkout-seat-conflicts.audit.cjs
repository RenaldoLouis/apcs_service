// Execute checkout and production error serialization offline, without a browser or live services.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fixtureFile = path.join(__dirname, 'public-ticket.audit.cjs');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').split("test('PUBLIC:")[0];
const context = { require, __dirname, module: { exports: {} } };
vm.runInNewContext(fixtureSource + '\nmodule.exports = fixture;', context, { filename: fixtureFile });
const fixture = context.module.exports;
const seatSelection = { selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'], idempotencyKey: 'conflict-attempt' };

function productionResponse(f, error) {
    const res = { statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    // The fixture loads the real middleware with NODE_ENV unset, which uses production serialization.
    f.load('src/middlewares/ErrorHandlerMiddleware.js').errorHandler(error, {}, res, () => {});
    return res;
}

async function assertSeatConflict(f, overrides = {}) {
    const before = JSON.stringify([...f.records]);
    const { error } = await f.book({ ...seatSelection, ...overrides });
    assert.ok(error, 'Checkout must reject the unavailable seat');
    assert.equal(JSON.stringify([...f.records]), before, 'Rejection must not change any records');
    assert.equal(f.invoices.length, 0, 'No invoice may be created');
    assert.equal(f.timers.length, 0, 'No expiry timer may be scheduled');
    const res = productionResponse(f, error);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'SEAT_UNAVAILABLE');
    assert.match(res.body.message, /no longer available/);
    assert.match(res.body.message, /seat selection.*choose another seat/i);
    assert.equal(res.body.stack, undefined, 'Production must not disclose a stack');
}

for (const status of ['locked', 'booked', 'reserved', 'blocked']) {
    test(`CHECKOUT MESSAGE: a ${status} selected seat gives actionable production guidance`, async () => {
        const f = fixture();
        f.seat('seat-1', { status, bookingId: 'other-buyer', lockedByBookingId: 'other-buyer' });
        await assertSeatConflict(f);
    });
}

test('CHECKOUT MESSAGE: canonical ownership conflict has the same guidance', async () => {
    const f = fixture(); f.seat();
    const seat = f.records.get('seatsAPCS2026/seat-1');
    f.seed('ticketSeatOwnership/' + f.repo.safeDocumentId(f.repo.physicalSeatKey('APCS2026', seat)), {
        active: true, bookingId: 'other-buyer', status: 'locked',
    });
    await assertSeatConflict(f);
});

test('CHECKOUT MESSAGE: an occupied physical alias gives the same guidance', async () => {
    const f = fixture(); f.seat();
    f.seat('legacy-alias', { status: 'booked', bookingId: 'other-buyer' });
    await assertSeatConflict(f);
});

test('CHECKOUT MESSAGE: manual payment rejects a seat conflict without altering inventory', async () => {
    const f = fixture(); f.seat('seat-1', { status: 'blocked' });
    await assertSeatConflict(f, { manualPayment: true });
});

test('CHECKOUT MESSAGE: exhausted tier capacity gives quantity/category guidance', async () => {
    const f = fixture(); f.seat('seat-1', { status: 'booked', bookingId: 'other-buyer' });
    f.seed('ticketCapacity/' + f.repo.capacityDocumentId('APCS2026', 'V1', '2026-11-01', '09:00-10:00'), {
        reservedByTier: { presto: 10 },
    });
    const before = JSON.stringify([...f.records]);
    const { error } = await f.book(seatSelection);
    assert.ok(error);
    assert.equal(JSON.stringify([...f.records]), before);
    assert.equal(f.invoices.length, 0);
    const res = productionResponse(f, error);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'TICKET_CAPACITY_UNAVAILABLE');
    assert.match(res.body.message, /ticket selection.*quantity or category/i);
});

test('CHECKOUT MESSAGE: unrelated unexpected errors stay generic in production', () => {
    const f = fixture();
    const res = productionResponse(f, new Error('Private database failure details'));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Something went wrong');
    assert.equal(res.body.code, undefined);
});
