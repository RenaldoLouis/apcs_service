// Offline only: production repository/controller code, substituted database/provider/mail.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { memoryDb } = require('./helpers/group-email-memory-db.cjs');
const { AppError } = require('../src/middlewares/ErrorHandlerMiddleware');
const source = fs.readFileSync(path.join(__dirname, '../src/repositories/PublicTicketContactRepository.js'), 'utf8');
const actor = { uid: 'staff-1', email: 'staff@example.invalid' };
const contact = { buyerName: 'Corrected Buyer', userEmail: 'corrected@example.invalid', userPhone: '+62 (812) 1234-5678' };
const expected = booking => Object.fromEntries(['buyerName', 'userName', 'userEmail', 'userPhone'].map(key => [key, booking[key] ?? null]));
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(overrides = {}) {
    const initial = { eventId: 'APCS2026', paymentStatus: 'pending', buyerName: 'Old Buyer', userName: 'Old Buyer',
        userEmail: 'old@example.invalid', userPhone: '+62811111111', invoiceId: 'invoice-1',
        paymentUrl: 'https://example.invalid/pay', idempotencyKey: 'checkout-1', totalAmount: 150000,
        tickets: [{ id: 'presto', quantity: 1 }], selectedSeatIds: ['seat-1'], physicalSeatKeys: ['chair-1'],
        manualInstructionsEmailSent: true, emailSent: false, expiry: { invoiceCancellationStatus: 'not_requested' },
        ...overrides };
    const records = new Map([
        ['publicBookings/booking-1', initial],
        ['seatsAPCS2026/seat-1', { status: 'locked', lockedByBookingId: 'booking-1' }],
        ['ticketSeatOwnership/chair-1', { active: true, bookingId: 'booking-1' }],
        ['ticketCapacity/capacity-1', { reservedByTier: { presto: 1 } }],
        ['ticketCheckoutKeys/checkout-1', { bookingId: 'booking-1', requestFingerprint: 'original fingerprint' }],
    ]);
    const f = memoryDb(records);
    const module = { exports: {} };
    vm.runInNewContext(source, { module, require(name) {
        if (name.endsWith('/firebase-init')) return { db: f.db };
        if (name.endsWith('/ErrorHandlerMiddleware')) return { AppError };
        throw new Error(`Unexpected dependency ${name}`);
    } });
    const input = { bookingId: 'booking-1', eventId: 'APCS2026', contact, expectedContact: expected(initial) };
    return { ...f, input, save: (inputOverride = input, staff = actor) => module.exports.updatePendingBuyerContact(inputOverride, staff) };
}

test('pending contact edit changes only contact fields, preserving every other document and booking field', async () => {
    const f = fixture();
    const before = plain([...f.records]);
    const result = await f.save();
    const desired = { ...contact, userName: contact.buyerName };
    assert.deepEqual(plain(result), { bookingId: 'booking-1', eventId: 'APCS2026', updated: true, contact: desired });
    const expectedRecords = new Map(before);
    expectedRecords.set('publicBookings/booking-1', { ...expectedRecords.get('publicBookings/booking-1'), ...desired });
    assert.deepEqual(plain([...f.records]), [...expectedRecords]);
    assert.deepEqual(f.reads, ['publicBookings/booking-1']);
});

test('manual booking corrections preserve payment mode, holds and delivery history', async () => {
    const f = fixture({ paymentMode: 'manual', invoiceId: null, paymentUrl: null });
    await f.save();
    const saved = f.records.get('publicBookings/booking-1');
    assert.equal(saved.paymentMode, 'manual');
    assert.equal(saved.paymentStatus, 'pending');
    assert.equal(saved.manualInstructionsEmailSent, true);
    assert.equal(saved.emailSent, false);
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
});

for (const paymentStatus of ['PAID', 'paid', 'expired', 'failed', 'archived_test', 'PENDING', undefined]) {
    test(`reject ${paymentStatus} even if the browser previously saw pending`, async () => {
        const f = fixture();
        f.records.get('publicBookings/booking-1').paymentStatus = paymentStatus;
        const before = plain([...f.records]);
        await assert.rejects(f.save(), error => error.statusCode === 409 && /pending/i.test(error.message));
        assert.deepEqual(plain([...f.records]), before);
    });
}

test('same correction can be acknowledged again without writing, but never after payment', async () => {
    const f = fixture();
    await f.save();
    let writes = 0;
    f.db.commitHook = operations => { writes += operations.length; };
    await f.save();
    assert.equal(writes, 0);
    f.records.get('publicBookings/booking-1').paymentStatus = 'PAID';
    await assert.rejects(f.save(), /Only pending/);
});

test('two staff editing the same original contact cannot overwrite each other', async () => {
    const f = fixture();
    const competing = { ...f.input, contact: { ...contact, buyerName: 'Other Staff Correction' } };
    const results = await Promise.allSettled([f.save(), f.save(competing)]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.statusCode, 409);
    assert.equal(f.records.get('publicBookings/booking-1').buyerName, contact.buyerName);
});

test('a Firestore transaction retry rechecks payment instead of committing an earlier pending snapshot', async () => {
    const f = fixture();
    const original = f.db.runTransaction;
    f.db.runTransaction = async operation => {
        await operation({ get: ref => ref.get(), update() {} }); // discarded first attempt
        f.records.get('publicBookings/booking-1').paymentStatus = 'PAID';
        return original(operation);
    };
    await assert.rejects(f.save(), /Only pending/);
    assert.equal(f.records.get('publicBookings/booking-1').buyerName, 'Old Buyer');
});

test('wrong event, missing booking and documentation record reject without writes', async () => {
    for (const kind of ['event', 'deleted', 'documentation']) {
        const f = fixture();
        if (kind === 'event') f.input.eventId = 'APCS2025';
        if (kind === 'deleted') f.records.delete('publicBookings/booking-1');
        if (kind === 'documentation') f.records.get('publicBookings/booking-1').recordType = 'documentation_only';
        const before = plain([...f.records]);
        await assert.rejects(f.save(), error => [404, 409].includes(error.statusCode));
        assert.deepEqual(plain([...f.records]), before);
    }
});

test('legacy userName-only bookings acquire aligned buyerName without changing registrant identity', async () => {
    const f = fixture({ buyerName: undefined, registrantName: 'Existing Performer', registrantId: 'winner' });
    await f.save();
    assert.equal(f.records.get('publicBookings/booking-1').buyerName, contact.buyerName);
    assert.equal(f.records.get('publicBookings/booking-1').registrantName, 'Existing Performer');
    assert.equal(f.records.get('publicBookings/booking-1').registrantId, 'winner');
});

for (const invalid of [
    { buyerName: '' }, { buyerName: 'a'.repeat(201) }, { buyerName: 'Name\nInjected' },
    { userEmail: 'bad' }, { userEmail: 'a@example.invalid,b@example.invalid' },
    { userEmail: 'a@example.invalid\r\nBcc: b@example.invalid' }, { userEmail: 'Display <a@example.invalid>' },
    { userPhone: '' }, { userPhone: '123' }, { userPhone: '123456789012345678901' }, { userPhone: 'abc123456' },
    { userEmail: null }, { buyerName: {} },
]) {
    test(`invalid input rejects before database access: ${JSON.stringify(invalid)}`, async () => {
        const f = fixture();
        await assert.rejects(f.save({ ...f.input, contact: { ...contact, ...invalid } }), error => error.statusCode === 400);
        assert.equal(f.reads.length, 0);
    });
}

test('request cannot inject payment, seats, invoice, note or arbitrary contact fields', async () => {
    for (const field of ['paymentStatus', 'selectedSeatIds', 'invoiceId', 'adminNote', 'userName', '__proto__']) {
        const f = fixture();
        const changed = { ...f.input, contact: { ...contact, [field]: 'injected' } };
        await assert.rejects(f.save(changed), error => error.statusCode === 400);
        await assert.rejects(f.save({ ...f.input, [field]: 'injected' }), error => error.statusCode === 400);
        assert.equal(f.reads.length, 0);
    }
});

test('missing staff identity, expected-contact snapshot or valid references cannot submit', async () => {
    const f = fixture();
    for (const staff of [null, {}, { uid: 'staff' }, { email: 'staff@example.invalid' }]) {
        await assert.rejects(f.save(f.input, staff), error => error.statusCode === 403);
    }
    for (const change of [{ expectedContact: {} }, { expectedContact: null }, { bookingId: '../other' }, { eventId: '' }]) {
        await assert.rejects(f.save({ ...f.input, ...change }), error => error.statusCode === 400);
    }
    assert.equal(f.reads.length, 0);
});

test('commit failure leaves the original booking intact', async () => {
    const f = fixture();
    const before = plain([...f.records]);
    f.db.commitHook = () => { throw new Error('Injected database failure'); };
    await assert.rejects(f.save(), /database failure/);
    assert.deepEqual(plain([...f.records]), before);
});

test('the contact route requires the existing whitelist middleware and controller catches repository rejection', async () => {
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    assert.match(route, /router\.post\('\/public-ticket\/admin\/update-buyer-contact', requireTicketingAdmin, PublicTicketController\.updatePendingBuyerContact\)/);
    const controller = fs.readFileSync(path.join(__dirname, '../src/controllers/PublicTicketController.js'), 'utf8');
    const start = controller.indexOf('async function updatePendingBuyerContact(');
    const end = controller.indexOf('/** POST', start);
    const context = { require: () => ({ updatePendingBuyerContact: async () => { throw new AppError('Only pending', 409); } }) };
    vm.runInNewContext(controller.slice(start, end), context);
    let error;
    await context.updatePendingBuyerContact({ body: {}, ticketingAdmin: actor }, {}, value => { error = value; });
    assert.equal(error.statusCode, 409);
});

test('real checkout retry and payment fulfillment preserve corrected contacts and original chair ownership', async () => {
    const filename = path.join(__dirname, 'public-ticket.audit.cjs');
    const fixtureSource = fs.readFileSync(filename, 'utf8').split("test('PUBLIC:")[0];
    const context = { require, __dirname, module: { exports: {} } };
    vm.runInNewContext(`${fixtureSource}\nmodule.exports = fixture;`, context, { filename });
    const f = context.module.exports();
    f.seat();
    const cart = { selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'], idempotencyKey: 'retry-key' };
    const first = await f.book(cart);
    assert.ifError(first.error);
    const key = `publicBookings/${first.result.bookingId}`;
    const original = f.records.get(key);
    const update = f.load('src/repositories/PublicTicketContactRepository.js');
    await update.updatePendingBuyerContact({ bookingId: first.result.bookingId, eventId: 'APCS2026',
        contact, expectedContact: expected(original) }, actor);
    const retry = await f.book(cart);
    assert.ifError(retry.error);
    assert.equal(retry.result.bookingId, first.result.bookingId);
    assert.equal(f.invoices.length, 1);
    assert.equal(f.invoices[0].user.email, 'audit@example.invalid', 'issued invoice stays unchanged');
    assert.equal(f.records.get(key).userEmail, contact.userEmail, 'checkout retry cannot restore old contact');
    const paid = await f.repo.handlePublicTicketWebhookPaid(first.result.bookingId, {
        invoice: { id: original.invoiceId, status: 'paid', total_amount: original.totalAmount },
    });
    assert.equal(paid.userEmail, contact.userEmail, 'confirmation input uses corrected address');
    assert.equal(paid.buyerName, contact.buyerName);
    assert.equal(f.records.get(key).paymentStatus, 'PAID');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'booked');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').assignedTo.userName, contact.buyerName);
    assert.equal(f.records.get('seatsAPCS2026/seat-1').assignedTo.userEmail, contact.userEmail);
    assert.deepEqual(plain(f.records.get(key).selectedSeatIds), ['seat-1']);
    assert.equal(f.records.get(key).totalAmount, original.totalAmount);
});

test('a corrected pending purchase can still receive numbered seats through the real paid-only assignment flow', async () => {
    const filename = path.join(__dirname, 'public-ticket.audit.cjs');
    const context = { require, __dirname, module: { exports: {} } };
    vm.runInNewContext(`${fs.readFileSync(filename, 'utf8').split("test('PUBLIC:")[0]}\nmodule.exports = fixture;`, context);
    const f = context.module.exports({ extraRequire: (name, load) => name === './PublicTicketRepository'
        ? load('src/repositories/PublicTicketRepository.js') : undefined });
    f.seat();
    const purchase = await f.book();
    assert.ifError(purchase.error);
    const bookingId = purchase.result.bookingId;
    const booking = f.records.get(`publicBookings/${bookingId}`);
    await f.load('src/repositories/PublicTicketContactRepository.js').updatePendingBuyerContact({
        bookingId, eventId: 'APCS2026', contact, expectedContact: expected(booking),
    }, actor);
    const seats = f.load('src/repositories/TicketSeatAdminRepository.js');
    await assert.rejects(seats.assignPaidBookingSeats({ bookingId, seatIds: ['seat-1'] }, actor), /paid booking/);
    await f.repo.handlePublicTicketWebhookPaid(bookingId, {
        invoice: { id: booking.invoiceId, status: 'paid', total_amount: booking.totalAmount },
    });
    await seats.assignPaidBookingSeats({ bookingId, seatIds: ['seat-1'] }, actor);
    assert.deepEqual(plain(f.records.get(`publicBookings/${bookingId}`).selectedSeatIds), ['seat-1']);
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'booked');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').assignedTo.userEmail, contact.userEmail);
    assert.equal(f.records.get(`publicBookings/${bookingId}`).userName, contact.buyerName);
});
