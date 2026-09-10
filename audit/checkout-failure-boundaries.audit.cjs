// Offline boundary checks: no browser, credentials, or live provider calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Paper invoice error preserves an already created invoice ID', async () => {
    const filename = path.join(__dirname, '../src/repositories/PaperRepository.js');
    const date = { format: () => '07-09-2026', add: () => date };
    const dependencies = {
        '../utils/Logger': { logger: { info() {}, error() {} } },
        axios: { post: async () => ({ data: { data: { id: 'created-invoice' } } }) },
        '../middlewares/ErrorHandlerMiddleware': { AppError: Error },
        dayjs: () => date,
        '../utils/invoiceUtils': { buildInvoiceItem: item => item, buildInvoiceNotes: () => '', DEFAULT_USD_TO_IDR_RATE: 16000 },
        '../configs/firebase-init': { db: { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) } },
    };
    const context = { module: { exports: {} }, process: { env: {} }, console: { error() {} }, require: name => {
        assert.ok(name in dependencies, `Unexpected dependency ${name}`);
        return dependencies[name];
    } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    let calls = 0;
    await context.module.exports.createInvoice({ user: { name: 'Fixture' }, items: [], externalId: 'booking' }, error => {
        calls++;
        assert.match(error.message, /Payment URL not generated/);
        assert.equal(error.invoiceId, 'created-invoice');
    });
    assert.equal(calls, 1);
});

test('Manual Mark Paid rechecks persisted failed status before writing', async () => {
    const filename = path.join(__dirname, '../../apcs_web/src/Pages/AdminDashboard/PublicCustomersList.js');
    const source = fs.readFileSync(filename, 'utf8');
    // Execute the actual handler, isolated from JSX and browser rendering.
    const start = source.indexOf('    const handleMarkPaid = ');
    const end = source.indexOf('    const handleDeleteBooking = ', start);
    assert.ok(start >= 0 && end > start);
    let writes = 0, successes = 0;
    const errors = [];
    const context = {
        db: {}, doc: () => ({}), console: { error() {} },
        message: { loading() {}, success: () => successes++, error: value => errors.push(value.content) },
        runTransaction: async (_db, callback) => callback({
            get: async () => ({ exists: () => true, data: () => ({ paymentStatus: 'failed' }) }),
            update: () => writes++,
        }),
    };
    vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.handler = handleMarkPaid;`, context, { filename });
    await context.handler({ id: 'booking', paymentStatus: 'pending' });
    assert.equal(writes, 0);
    assert.equal(successes, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /cannot be marked paid/);
});

test('Manual Mark Paid cannot take a seat locked by another booking', async () => {
    const filename = path.join(__dirname, '../../apcs_web/src/Pages/AdminDashboard/PublicCustomersList.js');
    const source = fs.readFileSync(filename, 'utf8');
    const start = source.indexOf('    const handleMarkPaid = ');
    const end = source.indexOf('    const handleDeleteBooking = ', start);
    let reads = 0, writes = 0;
    const errors = [];
    const context = {
        db: {}, console: { error() {} }, deleteField: () => '__DELETE__',
        doc: (_db, collectionName, id) => ({ collectionName, id }),
        message: { loading() {}, success() {}, error: value => errors.push(value.content) },
        setCustomers() {},
        runTransaction: async (_db, callback) => callback({
            get: async () => {
                reads++;
                return reads === 1
                    ? { exists: () => true, data: () => ({ paymentStatus: 'pending', eventId: 'APCS2026', selectedSeatIds: ['seat-1'] }) }
                    : { exists: () => true, data: () => ({ status: 'locked', lockedByBookingId: 'another-booking', seatLabel: 'A1' }) };
            },
            update: () => writes++,
        }),
    };
    vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.handler = handleMarkPaid;`, context, { filename });
    await context.handler({ id: 'booking' });
    assert.equal(writes, 0);
    assert.match(errors[0], /no longer locked by this booking/);
});

test('Public failed status stops polling and ignores older in-flight responses', async () => {
    const filename = path.join(__dirname, '../../apcs_web/src/Pages/Register/WaitingPayment.js');
    const source = fs.readFileSync(filename, 'utf8');
    const start = source.indexOf('    useEffect(() => {');
    const end = source.indexOf('    // Timer effect', start);
    assert.ok(start >= 0 && end > start);
    let tick, cleanup, requests = 0;
    const pendingResponses = [], statuses = [];
    const context = {
        id: 'booking', isPublicTicket: true, stopPolling: { current: false },
        location: { state: { isPublicTicket: true } },
        setStatus: status => statuses.push(status), setLoading() {}, setLockExpiresAt() {}, setTimeLeftStr() {},
        setIsPublicTicketDetected() {}, setPaymentLink() {},
        useEffect: effect => { cleanup = effect(); },
        setInterval: callback => { tick = callback; return 1; }, clearInterval() {}, console: { error() {} },
        apis: { publicTicket: { getBookingStatus: () => {
            requests++;
            return new Promise(resolve => pendingResponses.push(resolve));
        } } },
    };
    vm.runInNewContext(source.slice(start, end), context, { filename });
    const secondPoll = tick();
    pendingResponses[1]({ data: { paymentStatus: 'failed' } });
    await secondPoll;
    pendingResponses[0]({ data: { paymentStatus: 'PAID' } });
    await Promise.resolve();
    await tick();
    assert.deepEqual(statuses, ['PENDING', 'FAILED']);
    assert.equal(requests, 2);
    assert.equal(context.stopPolling.current, true);
    cleanup();
});

test('Public local deadline keeps polling until the server confirms a terminal outcome', () => {
    const filename = path.join(__dirname, '../../apcs_web/src/Pages/Register/WaitingPayment.js');
    const source = fs.readFileSync(filename, 'utf8');
    const start = source.indexOf('    // Timer effect');
    const end = source.indexOf('    const handleFinish = ', start);
    assert.ok(start >= 0 && end > start);
    let tick;
    const statuses = [];
    const context = {
        lockExpiresAt: '1970-01-01T00:00:00.000Z', status: 'PENDING', stopPolling: { current: false },
        setTimeLeftStr() {}, setStatus: value => statuses.push(value), setLoading() {},
        useEffect: effect => effect(), setInterval: callback => { tick = callback; return 1; }, clearInterval() {},
    };
    vm.runInNewContext(source.slice(start, end), context, { filename });
    tick();
    assert.deepEqual(statuses, []);
    assert.equal(context.stopPolling.current, false);
});
