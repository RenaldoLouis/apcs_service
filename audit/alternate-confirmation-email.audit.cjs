// Offline production-controller checks: no real database, SMTP or browser calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(overrides = {}) {
    const booking = { userEmail: 'original@example.invalid', paymentStatus: 'PAID', emailSent: true,
        eventId: 'APCS2026', registrantId: 'winner', tickets: [{ id: 'presto', quantity: 2 }],
        selectedSeatIds: ['A1', 'A2'], ...overrides.booking };
    const original = JSON.stringify(booking);
    const sent = [];
    const reads = [];
    const db = { collection(name) {
        assert.equal(name, 'publicBookings');
        return { doc(id) {
            reads.push(id);
            return { async get() { return { id, exists: overrides.exists !== false, data: () => booking }; },
                async update(patch) {
                    if (!overrides.legacyResend) assert.fail('Alternate delivery must not change saved booking/email status');
                    Object.assign(booking, patch);
                } };
        } };
    } };
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '../src/controllers/PublicTicketController.js'), 'utf8');
    vm.runInNewContext(source, { module, exports: module.exports, require(name) {
        if (name.endsWith('/firebase-init')) return { db };
        if (name.endsWith('/EmailService')) return { async sendPublicBookingConfirmationEmail(data) {
            if (overrides.sendError) throw new Error('SMTP unavailable');
            sent.push(data);
        } };
        if (name.endsWith('/Logger')) return { logger: { info() {}, error() {} } };
        return {};
    } }, { filename: 'PublicTicketController.js' });
    async function send(body = { bookingId: 'booking-1', recipientEmail: ' second@example.invalid ' },
        method = 'sendPublicTicketEmailToAddress') {
        const response = { statusCode: 200, status(code) { this.statusCode = code; return this; },
            json(data) { this.body = data; return this; } };
        await module.exports[method]({ body, ticketingAdmin: { uid: 'staff-1' } }, response,
            error => { throw error; });
        assert.equal(JSON.stringify(booking), original, 'Saved contact/payment/inventory values remain unchanged');
        return response;
    }
    return { send, sent, reads, booking, controller: module.exports };
}

for (const emailSent of [true, false, undefined]) {
    test(`ALTERNATE EMAIL: paid booking with emailSent=${emailSent} sends only to the entered address`, async () => {
        const f = fixture({ booking: { emailSent } });
        const result = await f.send();
        assert.equal(result.statusCode, 200);
        assert.equal(result.body.sent, true);
        assert.equal(result.body.recipientEmail, 'second@example.invalid');
        assert.equal(f.sent.length, 1);
        assert.equal(f.sent[0].userEmail, 'second@example.invalid');
        assert.equal(f.sent[0].id, 'booking-1');
        assert.equal(f.sent[0].registrantId, 'winner');
        assert.deepEqual(f.sent[0].tickets, f.booking.tickets);
        assert.deepEqual(f.sent[0].selectedSeatIds, ['A1', 'A2']);
    });
}

for (const paymentStatus of ['pending', 'expired', 'failed', 'archived_test']) {
    test(`ALTERNATE EMAIL: ${paymentStatus} cannot receive a paid confirmation`, async () => {
        const f = fixture({ booking: { paymentStatus } });
        assert.equal((await f.send()).statusCode, 409);
        assert.equal(f.sent.length, 0);
    });
}

for (const recipientEmail of ['', 'bad', 'one@example.invalid,two@example.invalid',
    'one@example.invalid;two@example.invalid', 'Name <one@example.invalid>',
    'one@example.invalid\r\nBcc:other@example.invalid', ['one@example.invalid'],
    'a..b@example.invalid', 'one@-example.invalid', `${'a'.repeat(65)}@example.invalid`]) {
    test(`ALTERNATE EMAIL: rejects malformed/multiple recipient ${JSON.stringify(recipientEmail)}`, async () => {
        const f = fixture();
        assert.equal((await f.send({ bookingId: 'booking-1', recipientEmail })).statusCode, 400);
        assert.equal(f.sent.length, 0);
        assert.equal(f.reads.length, 0);
    });
}

test('ALTERNATE EMAIL: missing/invalid booking reference is rejected before lookup', async () => {
    for (const bookingId of [undefined, '', 'invalid/path', ['booking-1']]) {
        const f = fixture();
        assert.equal((await f.send({ bookingId, recipientEmail: 'second@example.invalid' })).statusCode, 400);
        assert.equal(f.reads.length, 0);
    }
});

test('ALTERNATE EMAIL: missing booking is not sent', async () => {
    const f = fixture({ exists: false });
    assert.equal((await f.send()).statusCode, 404);
    assert.equal(f.sent.length, 0);
});

test('ALTERNATE EMAIL: SMTP failure reports unconfirmed send and leaves original status untouched', async () => {
    const f = fixture({ sendError: true });
    const result = await f.send();
    assert.equal(result.statusCode, 502);
    assert.match(result.body.message, /confirm|delivery/i);
    assert.equal(f.sent.length, 0);
});

test('ALTERNATE EMAIL: route is protected by the existing ticketing-admin middleware', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    assert.match(source, /router\.post\('\/public-ticket\/admin\/send-email-to-address',\s*requireTicketingAdmin,\s*PublicTicketController\.sendPublicTicketEmailToAddress\)/);
});

test('ALTERNATE EMAIL: current resend retains its original-address behavior', async () => {
    const f = fixture({ legacyResend: true });
    const result = await f.send({ bookingId: 'booking-1', recipientEmail: 'ignored@example.invalid' }, 'resendPublicTicketEmail');
    assert.equal(result.statusCode, 200);
    assert.equal(f.sent.length, 1, 'Existing resend still sends when emailSent is already true');
    assert.equal(f.sent[0].userEmail, 'original@example.invalid');
});

test('ALTERNATE EMAIL: unauthenticated and unlisted staff are denied by real middleware', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/middlewares/TicketingAdminMiddleware.js'), 'utf8');
    for (const [token, listed, expected] of [[null, false, 401], ['valid', false, 403], ['valid', true, 200]]) {
        const module = { exports: {} };
        vm.runInNewContext(source, { module, require: () => ({
            admin: { auth: () => ({ verifyIdToken: async () => ({ uid: 'staff', email: 'staff@example.invalid' }) }) },
            db: { collection: () => ({ doc: () => ({ get: async () => ({ exists: listed }) }) }) },
        }) });
        const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() {} };
        let passed = false;
        await module.exports.requireTicketingAdmin({ headers: { 'auth-token': token } }, res, () => { passed = true; });
        assert.equal(res.statusCode, expected);
        assert.equal(passed, listed);
    }
});

function apiFixture({ token = 'fresh-token', failure, acknowledgement } = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../apcs_web/src/apis/index.js'), 'utf8');
    const authSource = source.slice(source.indexOf('const ticketingAdminOptions ='), source.indexOf('const scoringResultEmailRequest ='));
    const start = source.indexOf('    sendPublicTicketEmailToAddress: async');
    const end = source.indexOf('    releaseBooking:', start);
    const method = source.slice(start, end).replace(/,\s*$/, '');
    const calls = [];
    const context = { auth: { currentUser: token ? { getIdToken: async () => token } : null },
        http: { post: async (...args) => {
            calls.push(args);
            if (failure) throw failure;
            return { data: acknowledgement };
        } } };
    vm.runInNewContext(`${authSource}\nthis.send = ({ ${method} }).sendPublicTicketEmailToAddress;`, context);
    return { send: context.send, calls };
}

test('ALTERNATE EMAIL API: sends only booking ID and chosen recipient with a fresh staff token', async () => {
    const acknowledgement = { bookingId: 'booking-1', recipientEmail: 'second@example.invalid', sent: true };
    const f = apiFixture({ acknowledgement });
    assert.deepEqual(await f.send('booking-1', 'second@example.invalid'), acknowledgement);
    assert.equal(f.calls[0][0], '/api/v1/apcs/public-ticket/admin/send-email-to-address');
    assert.equal(JSON.stringify(f.calls[0][1]), JSON.stringify({ bookingId: 'booking-1', recipientEmail: 'second@example.invalid' }));
    assert.equal(f.calls[0][2].headers['auth-token'], 'fresh-token');
});

test('ALTERNATE EMAIL API: signed-out staff cannot submit', async () => {
    const f = apiFixture({ token: null });
    await assert.rejects(f.send('booking-1', 'second@example.invalid'), /Sign in/);
    assert.equal(f.calls.length, 0);
});

test('ALTERNATE EMAIL API: backend validation explanation is preserved', async () => {
    const f = apiFixture({ failure: { response: { data: { message: 'Enter one valid email address.' } } } });
    await assert.rejects(f.send('booking-1', 'second@example.invalid'), /one valid email/);
});

test('ALTERNATE EMAIL API: lost response prompts a delivery check before retry', async () => {
    const f = apiFixture({ failure: new Error('Network Error') });
    await assert.rejects(f.send('booking-1', 'second@example.invalid'), /Check delivery before retrying/);
});

for (const acknowledgement of [undefined, { sent: false },
    { bookingId: 'other', recipientEmail: 'second@example.invalid', sent: true },
    { bookingId: 'booking-1', recipientEmail: 'wrong@example.invalid', sent: true }]) {
    test(`ALTERNATE EMAIL API: mismatched send acknowledgement ${JSON.stringify(acknowledgement)} is not success`, async () => {
        const f = apiFixture({ acknowledgement });
        await assert.rejects(f.send('booking-1', 'second@example.invalid'), /could not be confirmed/);
    });
}

test('ALTERNATE EMAIL: real confirmation sender targets only the override and preserves booking content', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/EmailService.js'), 'utf8');
    const start = source.indexOf('async function getTicketDisplayDetails(');
    const end = source.indexOf('async function sendJuryDeadlineReminderEmail(', start);
    const details = require('../src/services/OrchestraEmailDetails');
    let mail, template;
    const context = { require: name => name.endsWith('/competitionDisplayTime') ? require('../src/utils/competitionDisplayTime')
        : ({ db: { collection() { throw new Error('Unexpected database read'); } } }),
        Intl, escapeTicketHtml: details.escapeHtml, attendanceHtml: details.attendanceHtml,
        getTemplate: (name, data) => { template = { name, data }; return 'real-template-input'; },
        transporter: { sendMail: async options => { mail = options; } }, logger: { info() {} } };
    vm.runInNewContext(source.slice(start, end), context);
    await context.sendPublicBookingConfirmationEmail({ id: 'booking-1', userEmail: 'second@example.invalid',
        venueName: 'Saved Hall', buyerName: 'Buyer', registrantName: 'Performer', date: '2026-11-14', session: '10:00-11:00',
        performanceSeatLabels: ['A1', 'A2'], tickets: [{ name: 'Presto', quantity: 2 }], totalAmount: 300000 });
    assert.equal(mail.to, 'second@example.invalid');
    assert.equal(mail.cc, undefined);
    assert.equal(mail.bcc, undefined);
    assert.equal(template.name, 'publicBookingConfirmation');
    assert.equal(template.data.bookingId, 'booking-1');
    assert.equal(template.data.venueName, 'Saved Hall');
    assert.equal(template.data.performanceSeatLabels, 'A1, A2');
    assert.equal(template.data.ticketSummary, '2x Presto');
});

function modalFixture({ recipient = ' second@example.invalid ', booking = { id: 'booking-1' }, sending = false, failure } = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../../apcs_web/src/Pages/AdminDashboard/PublicCustomersList.js'), 'utf8');
    const start = source.indexOf('    const handleSendAlternateEmail = async () => {');
    const end = source.indexOf('    const handleMarkPaid =', start);
    const state = { booking, recipient, error: '', sending, calls: [], successes: [] };
    const context = { alternateEmailBooking: booking, alternateEmail: recipient, sendingAlternateEmail: sending,
        setAlternateEmailError: value => { state.error = value; },
        setSendingAlternateEmail: value => { state.sending = value; },
        setAlternateEmailBooking: value => { state.booking = value; },
        setAlternateEmail: value => { state.recipient = value; },
        message: { success: value => state.successes.push(value) },
        apis: { publicTicket: { sendPublicTicketEmailToAddress: async (...args) => {
            state.calls.push(args);
            if (failure) throw new Error(failure);
        } } } };
    vm.runInNewContext(`${source.slice(start, end)}\nthis.send = handleSendAlternateEmail;`, context);
    return { state, send: context.send };
}

test('ALTERNATE EMAIL UI: successful manual send uses the trimmed recipient and closes/clears the modal', async () => {
    const f = modalFixture();
    await f.send();
    assert.equal(JSON.stringify(f.state.calls), JSON.stringify([['booking-1', 'second@example.invalid']]));
    assert.equal(f.state.booking, null);
    assert.equal(f.state.recipient, '');
    assert.equal(f.state.sending, false);
    assert.equal(f.state.successes.length, 1);
});

test('ALTERNATE EMAIL UI: failed/uncertain delivery retains the recipient and open modal', async () => {
    const f = modalFixture({ failure: 'Check delivery before retrying.' });
    await f.send();
    assert.equal(f.state.booking.id, 'booking-1');
    assert.equal(f.state.recipient, ' second@example.invalid ');
    assert.equal(f.state.sending, false);
    assert.equal(f.state.error, 'Check delivery before retrying.');
    assert.equal(f.state.successes.length, 0);
});

test('ALTERNATE EMAIL UI: invalid address, closed modal and in-progress send never submit', async () => {
    for (const options of [{ recipient: '' }, { recipient: 'bad' }, { recipient: 'one@example.invalid,two@example.invalid' },
        { booking: null }, { sending: true }]) {
        const f = modalFixture(options);
        await f.send();
        assert.equal(f.state.calls.length, 0);
        assert.equal(f.state.successes.length, 0);
    }
});
