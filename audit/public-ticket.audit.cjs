// Offline audit: exercises production repository/job code with in-memory dependencies.
// Run from the monorepo: node --test apcs_service/audit/public-ticket.audit.cjs
// Failing tests are unresolved safety invariants, not expected-success regressions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}) {
    let now = Date.parse('2026-09-06T05:00:00Z');
    let sequence = 0;
    const timers = [], intervals = [], logs = [], invoices = [];
    const timestamp = value => ({ toDate: () => new Date(value) });
    const clone = value => {
        if (value == null || typeof value !== 'object') return value;
        if (typeof value.toDate === 'function') return timestamp(value.toDate().getTime());
        if (Object.prototype.toString.call(value) === '[object Date]') return timestamp(value.getTime());
        if (Array.isArray(value)) return Array.from(value, clone);
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
    };
    const records = new Map();
    const seed = (key, value) => records.set(key, clone(value));
    seed('systemSettings/global', { currentEventId: 'APCS2026', ticketEligibility: { enabled: false } });
    seed('Registrants2025/winner', { eventId: 'APCS2026', finalAward: 'Gold', performers: [{ fullName: 'Audit Winner', email: 'winner@example.invalid' }] });
    seed('sessionAssignments/APCS2026', { assignments: { 'V1_2026-11-01_09:00-10:00': [{ registrantId: 'winner' }] } });
    seed('events/APCS2026', {
        venues: [{ id: 'V1', label: 'Hall 1', sessions: { '2026-11-01': ['09:00-10:00'] }, seatConfig: [{ row: 'A', seatCount: 10, areaType: 'presto' }, { row: 'B', seatCount: 10, areaType: 'lento' }] }],
        ticketTiers: [
            { id: 'presto', name: 'Presto', venuePrices: { V1: 150000 } },
            { id: 'lento', name: 'Lento', venuePrices: { V1: 75000 } },
        ],
        addOns: [{ id: 'seat_selection_performer', name: 'Choose seat', price: 10000 }],
        orchestraSessions: [{ id: 'orch', venue: 'V1', date: '2026-11-01', time: '19:00-20:00', reservedRows: ['A'], complimentaryQuota: 10, complimentaryClaimed: 0 }],
    });
    const ref = key => ({
        path: key, id: key.split('/').pop(),
        get: async () => {
            if (options.failRegistrantRead && key.startsWith('Registrants2025/')) throw new Error('Fixture registrant read failure');
            return snapshot(key);
        },
        update: async values => commit([['update', key, values]]),
        set: async values => seed(key, values),
    });
    const snapshot = key => ({ exists: records.has(key), id: key.split('/').pop(), ref: ref(key), data: () => clone(records.get(key)) });
    const commit = operations => {
        const next = new Map(records);
        for (const [kind, key, values] of operations) {
            if (options.cleanupFails && values.paymentStatus === 'failed') throw new Error('Fixture cleanup failure');
            if (options.failInvoiceSave && values.invoiceId && key.startsWith('publicBookings/') && values.paymentStatus !== 'failed') throw new Error('Fixture invoice save failure');
            if (kind === 'update' && !next.has(key)) throw new Error(`Missing document ${key}`);
            const data = kind === 'update' ? { ...next.get(key), ...clone(values) } : clone(values);
            for (const field of Object.keys(data)) if (data[field] === '__DELETE__') delete data[field];
            next.set(key, data);
        }
        records.clear();
        for (const [key, value] of next) records.set(key, value);
    };
    const writer = enforceReadOrder => {
        const operations = [];
        const checkRead = () => {
            if (enforceReadOrder && operations.length) throw new Error('Firestore transactions require all reads to be executed before all writes.');
        };
        return {
            get: async target => { checkRead(); return target.__query ? target.get() : snapshot(target.path); },
            getAll: async (...targets) => { checkRead(); return targets.map(target => snapshot(target.path)); },
            update: (target, values) => operations.push(['update', target.path, values]),
            set: (target, values) => operations.push(['set', target.path, values]),
            commit: async () => commit(operations),
        };
    };
    const collection = (name, filters = [], queryOptions = {}) => ({
        __query: true,
        doc: id => ref(`${name}/${id || `booking-${++sequence}`}`),
        where: (field, operator, value) => collection(name, [...filters, [field, operator, value]], queryOptions),
        orderBy: field => collection(name, filters, { ...queryOptions, order: field }),
        limit: count => collection(name, filters, { ...queryOptions, limit: count }),
        startAfter: cursor => collection(name, filters, { ...queryOptions, cursor: typeof cursor === 'string' ? cursor : cursor.id }),
        get: async () => {
            let docs = [...records.keys()].filter(key => key.startsWith(`${name}/`)).map(snapshot).filter(doc =>
                filters.every(([field, operator, value]) => operator === '==' ? doc.data()[field] === value : value.includes(field === '__name__' ? doc.id : doc.data()[field])));
            if (queryOptions.order === '__name__') docs.sort((a, b) => a.id.localeCompare(b.id));
            if (queryOptions.cursor) docs = docs.filter(doc => doc.id.localeCompare(queryOptions.cursor) > 0);
            if (queryOptions.limit) docs = docs.slice(0, queryOptions.limit);
            return { docs, empty: docs.length === 0 };
        },
    });
    const db = { collection, batch: () => writer(false), runTransaction: async callback => {
        const transaction = writer(true);
        const result = await callback(transaction);
        await transaction.commit();
        return result;
    } };
    const admin = { firestore: { FieldValue: { serverTimestamp: () => timestamp(now), delete: () => '__DELETE__' }, FieldPath: { documentId: () => '__name__' } } };
    const paper = {
        createInvoice: async (body, callback) => {
            invoices.push(body);
            if (options.beforeInvoiceResponse) await options.beforeInvoiceResponse({ records, seed, body });
            if (options.invoiceRejects) throw new Error('Fixture rejected invoice promise');
            if (options.invoiceFails) callback(Object.assign(new Error('Fixture invoice failure'), options.errorInvoiceId ? { invoiceId: options.errorInvoiceId } : {}));
            else callback(null, { invoiceId: `invoice-${body.externalId}`, paymentUrl: 'https://example.invalid/pay' });
        },
        deleteInvoice: async id => {
            if (options.onCancel) options.onCancel(id);
            if (options.cancelThrows) throw new Error('Fixture cancellation failure');
            return !options.cancelFails;
        },
    };
    const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, message => logs.push(message)]));
    class AuditDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const load = relative => {
        const filename = path.join(__dirname, '..', relative);
        const context = {
            module: { exports: {} }, process: { env: {} }, Date: AuditDate,
            setTimeout: callback => timers.push(callback), setInterval: callback => intervals.push(callback),
            require: name => {
                if (name.endsWith('firebase-init')) return { db, admin };
                if (name === 'firebase-admin') return admin;
                if (name.endsWith('/Logger')) return { logger };
                if (name.endsWith('/PaperRepository')) return paper;
                if (name.endsWith('/PublicTicketFailureRepository')) return load('src/repositories/PublicTicketFailureRepository.js');
                if (name === 'jsonwebtoken') return {};
                throw new Error(`Unmocked dependency: ${name}`);
            },
        };
        vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
        return context.module.exports;
    };
    const repo = load('src/repositories/PublicTicketRepository.js');
    const seat = (id = 'seat-1', overrides = {}) => seed(`seatsAPCS2026/${id}`, {
        eventId: 'APCS2026', venueId: 'V1', sessionId: '2026-11-01_09:00-10:00',
        areaType: 'presto', row: 'A', number: 1, seatLabel: 'A1', status: 'available', ...overrides,
    });
    const body = overrides => ({
        buyerName: 'Audit Buyer', userEmail: 'audit@example.invalid', userPhone: '+6200000000',
        venue: 'V1', date: '2026-11-01', session: '09:00-10:00',
        tickets: [{ id: 'presto', name: 'Presto', quantity: 1, priceEach: 1 }],
        selectedSeatIds: [], orchestraSelectedSeatIds: [], addOnIds: [], ...overrides,
    });
    const book = async overrides => {
        let called = 0, error, result;
        await repo.createPublicTicketBooking(body(overrides), (err, data) => { called++; error = err; result = data; });
        assert.equal(called, 1, 'Repository must settle its callback exactly once');
        return { error, result };
    };
    return { records, seed, timestamp, seat, body, book, repo, load, timers, intervals, invoices, logs,
        advance: milliseconds => { now += milliseconds; } };
}

const paidInvoice = (bookingId, totalAmount) => ({
    invoice: { id: `invoice-${bookingId}`, total_amount: totalAmount },
});

test('PUBLIC: checkout sends only the supplied test contact to Paper.id and accepts a staging paid callback', async () => {
    const f = fixture();
    const { error, result } = await f.book({
        userEmail: 'payment-test@example.invalid', userPhone: '080000000000',
    });
    assert.ifError(error);
    assert.equal(f.invoices[0].user.email, 'payment-test@example.invalid');
    assert.equal(f.invoices[0].user.phone, '080000000000');
    const booking = f.records.get(`publicBookings/${result.bookingId}`);
    await f.repo.handlePublicTicketWebhookPaid(result.bookingId, {
        invoice: { id: booking.invoiceId, number: result.bookingId, status: 'paid', amount_due: 0, total_amount: booking.totalAmount },
    });
    assert.equal(f.records.get(`publicBookings/${result.bookingId}`).paymentStatus, 'PAID');
});

test('WINNER: checkout uses the buyer test contact and accepts a production paid callback amount', async () => {
    const f = fixture();
    const { error, result } = await f.book({
        registrantId: 'winner', registrantName: 'Audit Winner',
        userEmail: 'payment-test@example.invalid', userPhone: '080000000000',
    });
    assert.ifError(error);
    assert.equal(f.invoices[0].user.email, 'payment-test@example.invalid');
    assert.equal(f.invoices[0].user.phone, '080000000000');
    const booking = f.records.get(`publicBookings/${result.bookingId}`);
    await f.repo.handlePublicTicketWebhookPaid(result.bookingId, {
        invoice: { id: booking.invoiceId, number: result.bookingId, status: 'paid', amount: booking.totalAmount, amount_due: 0 },
        payment_info: { method: 'bank_transfer', channel: 'bni' },
    });
    assert.equal(f.records.get(`publicBookings/${result.bookingId}`).paymentStatus, 'PAID');
});

test('SAFETY: conflicting callback amount fields cannot mark a booking paid', async () => {
    const f = fixture();
    const { error, result } = await f.book();
    assert.ifError(error);
    await assert.rejects(f.repo.handlePublicTicketWebhookPaid(result.bookingId, {
        invoice: { id: `invoice-${result.bookingId}`, status: 'paid', total_amount: 150000, amount: 1 },
    }), /amount/i);
    assert.equal(f.records.get(`publicBookings/${result.bookingId}`).paymentStatus, 'pending');
});

test('CONTROL: selected-seat checkout recalculates price and payment books its seat', async () => {
    const f = fixture(); f.seat();
    const { error, result } = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    assert.ifError(error);
    assert.equal(f.records.get(`publicBookings/${result.bookingId}`).totalAmount, 160000);
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
    await f.repo.handlePublicTicketWebhookPaid(result.bookingId, paidInvoice(result.bookingId, 160000));
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'booked');
    assert.equal(f.records.get(`publicBookings/${result.bookingId}`).paymentStatus, 'PAID');
});

test('CONTROL: assigned winner lookup returns the existing performance session', async () => {
    const f = fixture();
    let result;
    await f.repo.getEligibleWinners({}, (error, data) => { assert.ifError(error); result = data; });
    assert.equal(result.winners[0].registrantId, 'winner');
    assert.equal(result.winners[0].session.venue, 'V1');
    assert.equal(result.winners[0].session.time, '09:00-10:00');
    assert.equal(result.winners[0].isEnsemble, false);
    assert.deepEqual(result.winners[0].performerNames, ['Audit Winner']);
});

test('CONTROL: assigned winner lookup returns all performer names and isEnsemble for ensemble registrants', async () => {
    const f = fixture();
    f.seed('Registrants2025/ensemble-winner', {
        eventId: 'APCS2026',
        finalAward: 'Gold',
        PerformanceCategory: 'Ensemble',
        performers: [
            { fullName: 'Member One', email: 'm1@example.invalid' },
            { fullName: 'Member Two', email: 'm2@example.invalid' },
        ],
    });
    f.seed('sessionAssignments/APCS2026', {
        assignments: {
            'V1_2026-11-01_09:00-10:00': [
                { registrantId: 'winner' },
                { registrantId: 'ensemble-winner' },
            ],
        },
    });
    let result;
    await f.repo.getEligibleWinners({}, (error, data) => { assert.ifError(error); result = data; });
    const ensembleWinner = result.winners.find(w => w.registrantId === 'ensemble-winner');
    assert.ok(ensembleWinner);
    assert.equal(ensembleWinner.isEnsemble, true);
    assert.deepEqual(ensembleWinner.performerNames, ['Member One', 'Member Two']);
});

test('CONTROL: ordinary public expiry releases a seat when no complimentary quota exists', async () => {
    const f = fixture(); f.seat();
    const { result } = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    f.advance(31 * 60 * 1000);
    await f.timers[0]();
    assert.equal(f.records.get(`publicBookings/${result.bookingId}`).paymentStatus, 'expired');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'available');
});

test('SAFETY: rejected booking must preserve another buyer’s booked seat', async () => {
    const f = fixture(); f.seat('seat-1', { status: 'booked', bookingId: 'paid-owner' });
    const { error } = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    assert.match(error.message, /no longer available/);
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'booked');
});

test('FAILURE: rejected checkout preserves a different buyer’s hold and existing quota', async () => {
    const f = fixture();
    f.seat('seat-1', { status: 'locked', lockedAt: f.timestamp(Date.parse('2026-09-06T05:00:00Z')), lockedByBookingId: 'other' });
    const event = f.records.get('events/APCS2026');
    event.orchestraSessions[0].complimentaryClaimed = 3;
    const { error } = await f.book({ registrantId: 'winner', selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    assert.ok(error);
    assert.equal(f.records.get('seatsAPCS2026/seat-1').lockedByBookingId, 'other');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed, 3);
});

test('FAILURE: unknown invoice outcome retains committed inventory for reconciliation', async () => {
    const f = fixture({ invoiceFails: true }); f.seat();
    const { error } = await f.book({ registrantId: 'winner', selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    assert.match(error.message, /invoice failure/);
    const booking = f.records.get('publicBookings/booking-1');
    assert.equal(booking.paymentStatus, 'failed');
    assert.equal(booking.checkoutFailure.quotaRefundStatus, 'held');
    assert.equal(booking.checkoutFailure.invoiceCancellationStatus, 'unknown');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed, 0);
    await f.load('src/repositories/PublicTicketFailureRepository.js').failPublicTicketBooking('booking-1');
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed, 0);
    await assert.rejects(f.repo.handlePublicTicketWebhookPaid('booking-1', {}), /failed/i);
});

for (const cancelMode of ['success', 'false', 'throw']) {
    test(`FAILURE: known invoice is retained with cancellation outcome ${cancelMode}`, async () => {
        const canceled = [];
        const f = fixture({ failInvoiceSave: true, cancelFails: cancelMode === 'false', cancelThrows: cancelMode === 'throw', onCancel: id => canceled.push(id) });
        const { error } = await f.book();
        assert.match(error.message, /invoice save failure/);
        const booking = f.records.get('publicBookings/booking-1');
        assert.equal(booking.invoiceId, 'invoice-booking-1');
        assert.equal(booking.paymentStatus, 'failed');
        assert.equal(booking.checkoutFailure.invoiceCancellationStatus, cancelMode === 'success' ? 'canceled' : 'failed');
        assert.deepEqual(canceled, ['invoice-booking-1']);
    });
}

test('FAILURE: missing/reassigned seats do not block owned-seat cleanup; missing quota needs reconciliation', async () => {
    const f = fixture();
    f.seat('owned', { status: 'locked', lockedByBookingId: 'failed-booking' });
    f.seat('reused', { status: 'locked', lockedByBookingId: 'other' });
    f.seed('publicBookings/failed-booking', { eventId: 'APCS2026', paymentStatus: 'pending', selectedSeatIds: ['owned', 'missing', 'reused'], complimentaryTickets: 2, orchestraSessionId: 'deleted-session' });
    await f.load('src/repositories/PublicTicketFailureRepository.js').failPublicTicketBooking('failed-booking');
    assert.equal(f.records.get('seatsAPCS2026/owned').status, 'available');
    assert.equal(f.records.get('seatsAPCS2026/reused').lockedByBookingId, 'other');
    assert.equal(f.records.get('publicBookings/failed-booking').checkoutFailure.quotaRefundStatus, 'reconciliation_required');
});

test('FAILURE: payment completed before invoice error prevents rollback and cancellation', async () => {
    let cancellationCount = 0;
    const f = fixture({ invoiceFails: true, onCancel: () => cancellationCount++, beforeInvoiceResponse: ({ records }) => {
        records.get('publicBookings/booking-1').paymentStatus = 'PAID';
    } });
    f.seat();
    await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    assert.equal(f.records.get('publicBookings/booking-1').paymentStatus, 'PAID');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
    assert.equal(cancellationCount, 0);
});

test('FAILURE: price validation failure cannot release seats or refund existing quota', async () => {
    const f = fixture(); f.seat('seat-1', { status: 'booked', bookingId: 'other' });
    f.records.get('events/APCS2026').ticketTiers[0].venuePrices = {};
    f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed = 4;
    const { error } = await f.book({ registrantId: 'winner' });
    assert.match(error.message, /Pricing not configured/);
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed, 4);
    assert.equal(f.records.get('seatsAPCS2026/seat-1').bookingId, 'other');
    assert.equal(f.invoices.length, 0);
});

test('FAILURE: cleanup failure preserves the original error and callback contract', async () => {
    const f = fixture({ invoiceFails: true, cleanupFails: true }); f.seat();
    const { error } = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    assert.match(error.message, /invoice failure/);
    assert.ok(f.logs.some(log => log.includes('booking-1') && log.includes('Fixture cleanup failure')));
    // A failed atomic cleanup leaves all allocations intact for recovery.
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
});

test('FAILURE: rejected invoice promise is returned through the callback', async () => {
    const f = fixture({ invoiceRejects: true });
    const { error } = await f.book();
    assert.match(error.message, /rejected invoice promise/);
    assert.equal(f.records.get('publicBookings/booking-1').paymentStatus, 'failed');
});

test('FAILURE: invoice ID returned with an error remains available for cancellation', async () => {
    const canceled = [];
    const f = fixture({ invoiceFails: true, errorInvoiceId: 'created-without-url', onCancel: id => canceled.push(id) });
    await f.book();
    assert.equal(f.records.get('publicBookings/booking-1').invoiceId, 'created-without-url');
    assert.deepEqual(canceled, ['created-without-url']);
});

test('FAILURE: cancellation retry does not refund quota again', async () => {
    const f = fixture({ failInvoiceSave: true, cancelFails: true });
    await f.book({ registrantId: 'winner' });
    f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed = 5;
    await f.load('src/repositories/PublicTicketFailureRepository.js').failPublicTicketBooking('booking-1');
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed, 5);
});

test('FAILURE: cleanup uses stored event after active-event switch', async () => {
    const f = fixture({ invoiceFails: true, errorInvoiceId: 'invoice-booking-1', beforeInvoiceResponse: ({ seed }) => {
        seed('systemSettings/global', { currentEventId: 'APCS2027' });
    } }); f.seat();
    await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'available');
    assert.equal(f.records.get('publicBookings/booking-1').paymentStatus, 'failed');
});

test('FAILURE: unknown invoice outcome records reconciliation without releasing owned seats', async () => {
    const f = fixture({ invoiceFails: true, beforeInvoiceResponse: ({ records }) => records.delete('events/APCS2026') }); f.seat();
    await f.book({ registrantId: 'winner', selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
    assert.equal(f.records.get('publicBookings/booking-1').checkoutFailure.quotaRefundStatus, 'held');
});

test('SAFETY: a session with zero seat inventory must reject 100 seated tickets', async () => {
    const f = fixture();
    const { error } = await f.book({ tickets: [{ id: 'presto', name: 'Presto', quantity: 100 }] });
    assert.ok(error, 'Checkout accepted 100 tickets without any seat or capacity reservation');
});

test('SAFETY: unselected tickets reserve the same tier capacity as selected tickets', async () => {
    const f = fixture();
    const first = await f.book({ tickets: [{ id: 'presto', name: 'Presto', quantity: 10 }] });
    assert.ifError(first.error);
    const second = await f.book({ tickets: [{ id: 'presto', name: 'Presto', quantity: 1 }] });
    assert.ok(second.error, 'A second unselected booking exceeded the physical presto capacity');
});

test('SAFETY: public checkout must enforce a closed eligibility schedule', async () => {
    const f = fixture();
    f.seed('systemSettings/global', { currentEventId: 'APCS2026', ticketEligibility: { enabled: true, schedule: [] } });
    assert.ok((await f.book()).error, 'Public checkout ignored the closed sales window');
});

test('SAFETY: disabling date restrictions must not authorize a nonexistent winner', async () => {
    const f = fixture();
    const { error } = await f.book({ registrantId: 'nonexistent', orchestraSessionId: 'orch' });
    assert.ok(error, 'Unknown registrant received complimentary quota');
});

test('SAFETY: a winner cannot replace their assigned competition session at checkout', async () => {
    const f = fixture();
    f.records.get('events/APCS2026').venues[0].sessions['2026-11-01'].push('10:00-11:00');
    const { error } = await f.book({ registrantId: 'winner', session: '10:00-11:00' });
    assert.ok(error, 'Winner bypassed the saved competition assignment');
});

test('SAFETY: paid seat must match the purchased venue, session, and tier', async () => {
    const f = fixture(); f.seat('wrong-seat', { venueId: 'OTHER', sessionId: 'other-session', areaType: 'presto' });
    const { error } = await f.book({ tickets: [{ id: 'lento', name: 'Lento', quantity: 1 }], selectedSeatIds: ['wrong-seat'], addOnIds: ['seat_selection_performer'] });
    assert.ok(error, 'A different venue/session premium seat was accepted for a Lento ticket');
});

test('SAFETY: duplicate seat IDs must not count as two physical seats', async () => {
    const f = fixture(); f.seat();
    const { error } = await f.book({ tickets: [{ id: 'presto', name: 'Presto', quantity: 2 }], selectedSeatIds: ['seat-1', 'seat-1'], addOnIds: ['seat_selection_performer', 'seat_selection_performer'] });
    assert.ok(error, 'Two tickets were locked against one physical seat');
});

test('SAFETY: complimentary expiry timer must expire booking and refund quota', async () => {
    const f = fixture();
    const { result } = await f.book({ registrantId: 'winner' });
    Object.assign(f.records.get(`publicBookings/${result.bookingId}`), { ticketingVersion: 1, complimentaryTickets: 2, orchestraSessionId: 'orch' });
    f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed = 2;
    f.advance(31 * 60 * 1000);
    await f.timers[0]();
    assert.equal(f.records.get(`publicBookings/${result.bookingId}`).paymentStatus, 'expired', f.logs.join('\n'));
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed, 0);
});

test('SAFETY: restart sweeper must expire complimentary booking and refund quota', async () => {
    const f = fixture();
    const { result } = await f.book({ registrantId: 'winner' });
    Object.assign(f.records.get(`publicBookings/${result.bookingId}`), { ticketingVersion: 1, complimentaryTickets: 2, orchestraSessionId: 'orch' });
    f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed = 2;
    f.advance(31 * 60 * 1000);
    f.load('src/jobs/PublicTicketSweeper.js').startPublicTicketSweeper();
    await f.intervals[0]();
    assert.equal(f.records.get(`publicBookings/${result.bookingId}`).paymentStatus, 'expired', f.logs.join('\n'));
});

test('SAFETY: cancellation failure keeps expiry inventory locked for reconciliation', async () => {
    const f = fixture({ cancelFails: true }); f.seat();
    const { result } = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    f.advance(31 * 60 * 1000);
    await f.timers[0]();
    assert.equal(f.records.get(`publicBookings/${result.bookingId}`).paymentStatus, 'pending');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
    assert.equal(f.records.get(`publicBookings/${result.bookingId}`).expiry.invoiceCancellationStatus, 'failed');
});

test('SAFETY: invoice failure must leave no pending booking that can later release reused seats', async () => {
    const f = fixture({ invoiceFails: true }); f.seat();
    const { error } = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    assert.match(error.message, /invoice failure/);
    const pending = [...f.records.entries()].filter(([key, value]) => key.startsWith('publicBookings/') && value.paymentStatus === 'pending');
    assert.equal(pending.length, 0, 'Failed invoice left its booking pending after releasing seats');
});

test('SAFETY: payment after an active-event switch must use the booking’s saved event', async () => {
    const f = fixture(); f.seat();
    const { result } = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    f.seed('systemSettings/global', { currentEventId: 'APCS2027' });
    await assert.doesNotReject(() => f.repo.handlePublicTicketWebhookPaid(result.bookingId, paidInvoice(result.bookingId, 160000)));
});

test('SAFETY: paid fulfillment must reject a seat now owned by another booking', async () => {
    const f = fixture(); f.seat();
    const { result } = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    f.seat('seat-1', { status: 'booked', bookingId: 'other-owner' });
    await assert.rejects(() => f.repo.handlePublicTicketWebhookPaid(result.bookingId, paidInvoice(result.bookingId, 160000)));
});

test('SAFETY: eligibility database failure must reach callback instead of escaping the wrapper', async () => {
    const f = fixture({ failRegistrantRead: true });
    f.seed('systemSettings/global', { currentEventId: 'APCS2026', ticketEligibility: { enabled: true, schedule: [] } });
    let callbackError;
    await assert.doesNotReject(() => f.repo.createPublicTicketBooking(f.body({ registrantId: 'winner' }), err => { callbackError = err; }));
    assert.ok(callbackError);
});

test('SAFETY: callback marked paid must reject a mismatched payment amount', async () => {
    const f = fixture(); f.seat();
    const { result } = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    await assert.rejects(() => f.repo.handlePublicTicketWebhookPaid(result.bookingId, paidInvoice(result.bookingId, 1)));
});

test('SAFETY: public buyers must not lock arbitrary complimentary orchestra seats', async () => {
    const f = fixture(); f.seat('orchestra-seat', { sessionId: '2026-11-01_19:00-20:00' });
    const { error } = await f.book({ orchestraSelectedSeatIds: ['orchestra-seat'] });
    assert.ok(error, 'Public buyer locked an extra orchestra seat without entitlement or add-on');
});

test('SAFETY: paid public buyers cannot select reserved orchestra rows', async () => {
    const f = fixture();
    f.records.get('events/APCS2026').venues[0].sessions['2026-11-01'].push('19:00-20:00');
    f.seat('orchestra-a1', { sessionId: '2026-11-01_19:00-20:00', row: 'A', seatLabel: 'A1' });
    const { error } = await f.book({
        session: '19:00-20:00', selectedSeatIds: ['orchestra-a1'], addOnIds: ['seat_selection_performer'],
    });
    assert.ok(error, 'A paid public buyer selected a row reserved for complimentary winner seats');
});

test('SAFETY: winner-selected complimentary orchestra seats must stay in reserved rows', async () => {
    const f = fixture();
    f.records.get('events/APCS2026').addOns.push({ id: 'seat_selection', name: 'Choose orchestra seats', price: 0 });
    f.seat('orchestra-b1', { sessionId: '2026-11-01_19:00-20:00', row: 'B', seatLabel: 'B1' });
    f.seat('orchestra-b2', { sessionId: '2026-11-01_19:00-20:00', row: 'B', number: 2, seatLabel: 'B2' });
    const { error } = await f.book({
        registrantId: 'winner', addOnIds: ['seat_selection'],
        orchestraSelectedSeatIds: ['orchestra-b1', 'orchestra-b2'],
    });
    assert.ok(error, 'Winner selected complimentary orchestra seats outside reserved rows');
});

test('SAFETY: a local timeout cannot take over inventory before cancellation confirmation', async () => {
    const f = fixture(); f.seat();
    const first = await f.book({ registrantId: 'winner', selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    assert.ifError(first.error);
    f.advance(31 * 60 * 1000);
    const second = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] });
    assert.ok(second.error, 'A locally expired hold was taken over before provider cancellation');
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed, 0);
    f.load('src/jobs/PublicTicketSweeper.js').startPublicTicketSweeper();
    await f.intervals[0]();
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed, 0);
});

test('SAFETY: duplicate paid callback must still return a booking ID for confirmation email', async () => {
    const f = fixture();
    const { result } = await f.book();
    await f.repo.handlePublicTicketWebhookPaid(result.bookingId, paidInvoice(result.bookingId, 150000));
    const replay = await f.repo.handlePublicTicketWebhookPaid(result.bookingId, paidInvoice(result.bookingId, 150000));
    assert.equal(replay.id, result.bookingId);
});

test('REGRESSION: aliases for one physical chair cannot produce two paid bookings', async () => {
    const f = fixture();
    f.seat('legacy-a1');
    f.seat('canonical-a1', { seatLabel: 'A-1' });
    const first = await f.book({ selectedSeatIds: ['legacy-a1'], addOnIds: ['seat_selection_performer'] });
    assert.ifError(first.error);
    await f.repo.handlePublicTicketWebhookPaid(first.result.bookingId, paidInvoice(first.result.bookingId, 160000));
    const second = await f.book({ selectedSeatIds: ['canonical-a1'], addOnIds: ['seat_selection_performer'] });
    assert.match(second.error.message, /physical seat/i);
});

test('REGRESSION: client masterclass flags cannot bypass competition-seat capacity', async () => {
    const f = fixture();
    const { error } = await f.book({
        isMasterclass: true,
        tickets: [{ id: 'presto', name: 'Presto', quantity: 100 }],
    });
    assert.match(error.message, /product does not match|session type/i);
});

test('REGRESSION: free-seating public orchestra demand preserves the winner headcount pool', async () => {
    const f = fixture();
    f.records.get('events/APCS2026').venues[0].sessions['2026-11-01'].push('19:00-20:00');
    const first = await f.book({ session: '19:00-20:00', tickets: [{ id: 'presto', name: 'Presto', quantity: 10 }], isOrchestra: true });
    assert.ifError(first.error);
    assert.equal(f.records.get(`publicBookings/${first.result.bookingId}`).seatingMode, 'free');
    assert.ok((await f.book({ session: '19:00-20:00', isOrchestra: true })).error);
});

test('REGRESSION: winner attendance is recorded without a customer session or pending personal claim', async () => {
    const f = fixture();
    const first = await f.book({ registrantId: 'winner' });
    assert.ifError(first.error);
    const booking = f.records.get(`publicBookings/${first.result.bookingId}`);
    assert.equal(booking.orchestraAttendanceTickets, 1);
    assert.equal(booking.performerCount, 1);
    assert.equal(booking.complimentaryTickets, 0);
    assert.equal(booking.winnerClaimId, '');
});

test('REGRESSION: confirmed unpaid cancellation preserves winner attendance eligibility on retry', async () => {
    const f = fixture();
    const first = await f.book({ registrantId: 'winner' });
    assert.ifError(first.error);
    f.advance(31 * 60 * 1000);
    await f.timers[0]();
    const retry = await f.book({ registrantId: 'winner' });
    assert.ifError(retry.error);
    assert.equal(f.records.get(`publicBookings/${retry.result.bookingId}`).orchestraAttendanceTickets, 1);
});

test('REGRESSION: the same checkout idempotency key returns one booking and invoice', async () => {
    const f = fixture();
    const first = await f.book({ idempotencyKey: 'retry-key' });
    const retry = await f.book({ idempotencyKey: 'retry-key' });
    assert.ifError(first.error);
    assert.ifError(retry.error);
    assert.equal(retry.result.bookingId, first.result.bookingId);
    assert.equal(f.invoices.length, 1);
});

test('ADMIN RELEASE: a known invoice is canceled before its booking inventory is released', async () => {
    let canceledInvoiceId = null;
    const f = fixture({ onCancel: id => { canceledInvoiceId = id; } });
    f.seat('seat-1', { status: 'locked', lockedByBookingId: 'booking-admin-release' });
    const event = f.records.get('events/APCS2026');
    event.orchestraSessions[0].complimentaryClaimed = 1;
    f.seed('publicBookings/booking-admin-release', {
        eventId: 'APCS2026', paymentStatus: 'pending', invoiceId: 'invoice-admin-release',
        selectedSeatIds: ['seat-1'], orchestraSelectedSeatIds: [],
        physicalSeatKeys: ['APCS2026|V1|2026-11-01_09:00-10:00|A|1'],
        capacityReservation: { capacityId: 'capacity-1', byTier: { presto: 1 } },
        complimentaryTickets: 1, orchestraSessionId: 'orch', winnerClaimId: 'claim-1',
        createdAt: f.timestamp(Date.parse('2026-09-06T03:00:00Z')),
    });
    f.seed('ticketSeatOwnership/APCS2026_7CV1_7C2026-11-01_09_3A00-10_3A00_7CA_7C1', {
        bookingId: 'booking-admin-release', active: true, status: 'locked',
    });
    f.seed('ticketCapacity/capacity-1', { reservedByTier: { presto: 1 } });
    f.seed('winnerOrchestraClaims/claim-1', { bookingId: 'booking-admin-release', active: true });

    const result = await f.load('src/services/PublicTicketAdminReleaseService.js')
        .releasePublicTicketBooking('booking-admin-release', {
            reason: 'customer_declined',
        }, { uid: 'admin-1', email: 'admin@example.invalid' });

    assert.equal(canceledInvoiceId, 'invoice-admin-release');
    assert.equal(result.released, true);
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'available');
    assert.equal(f.records.get('ticketCapacity/capacity-1').reservedByTier.presto, 0);
    assert.equal(f.records.get('winnerOrchestraClaims/claim-1').active, false);
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[0].complimentaryClaimed, 0);
    const booking = f.records.get('publicBookings/booking-admin-release');
    assert.equal(booking.paymentStatus, 'expired');
    assert.equal(booking.expiry.invoiceCancellationStatus, 'canceled');
    assert.equal(booking.adminRelease.reason, 'customer_declined');
    assert.equal(booking.adminRelease.releasedByEmail, 'admin@example.invalid');
});

test('ADMIN RELEASE: an unknown invoice outcome requires explicit Paper verification', async () => {
    const f = fixture();
    f.seat('seat-1', { status: 'locked', lockedByBookingId: 'booking-unknown-release' });
    f.seed('publicBookings/booking-unknown-release', {
        eventId: 'APCS2026', paymentStatus: 'failed',
        selectedSeatIds: ['seat-1'], orchestraSelectedSeatIds: [], physicalSeatKeys: [],
        capacityReservation: null, complimentaryTickets: 0,
        createdAt: f.timestamp(Date.parse('2026-09-06T03:00:00Z')),
        checkoutFailure: {
            reason: 'Invoice response was lost', cleanupStatus: 'awaiting_cancellation',
            quotaRefundStatus: 'held', reconciliationReasons: ['provider_cancellation_required'],
            invoiceCancellationStatus: 'unknown',
        },
    });
    const service = f.load('src/services/PublicTicketAdminReleaseService.js');

    await assert.rejects(
        service.releasePublicTicketBooking('booking-unknown-release', {
            reason: 'no_response_after_one_hour', manualProviderConfirmation: false,
        }, { uid: 'admin-1', email: 'admin@example.invalid' }),
        /confirm.*Paper\.id/i,
    );
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');

    const result = await service.releasePublicTicketBooking('booking-unknown-release', {
        reason: 'no_response_after_one_hour', manualProviderConfirmation: true,
    }, { uid: 'admin-1', email: 'admin@example.invalid' });
    assert.equal(result.released, true);
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'available');
    const booking = f.records.get('publicBookings/booking-unknown-release');
    assert.equal(booking.paymentStatus, 'failed');
    assert.equal(booking.checkoutFailure.cleanupStatus, 'complete');
    assert.equal(booking.checkoutFailure.invoiceCancellationStatus, 'manually_verified_no_active_invoice');
});

test('ADMIN RELEASE: no-response reason is blocked until the booking is one hour old', async () => {
    const f = fixture();
    f.seat('seat-1', { status: 'locked', lockedByBookingId: 'booking-too-new' });
    f.seed('publicBookings/booking-too-new', {
        eventId: 'APCS2026', paymentStatus: 'failed',
        selectedSeatIds: ['seat-1'], orchestraSelectedSeatIds: [], physicalSeatKeys: [],
        capacityReservation: null, complimentaryTickets: 0,
        createdAt: f.timestamp(Date.parse('2026-09-06T04:30:00Z')),
        checkoutFailure: { cleanupStatus: 'awaiting_cancellation', invoiceCancellationStatus: 'unknown' },
    });

    await assert.rejects(
        f.load('src/services/PublicTicketAdminReleaseService.js')
            .releasePublicTicketBooking('booking-too-new', {
                reason: 'no_response_after_one_hour', manualProviderConfirmation: true,
            }, { uid: 'admin-1', email: 'admin@example.invalid' }),
        /wait one hour/i,
    );
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
});

test('ADMIN RELEASE: failed Paper cancellation keeps inventory locked', async () => {
    const f = fixture({ cancelFails: true });
    f.seat('seat-1', { status: 'locked', lockedByBookingId: 'booking-cancel-fails' });
    f.seed('publicBookings/booking-cancel-fails', {
        eventId: 'APCS2026', paymentStatus: 'failed', invoiceId: 'invoice-cancel-fails',
        selectedSeatIds: ['seat-1'], orchestraSelectedSeatIds: [], physicalSeatKeys: [],
        capacityReservation: null, complimentaryTickets: 0,
        createdAt: f.timestamp(Date.parse('2026-09-06T03:00:00Z')),
        checkoutFailure: { cleanupStatus: 'awaiting_cancellation', invoiceCancellationStatus: 'failed' },
    });

    await assert.rejects(
        f.load('src/services/PublicTicketAdminReleaseService.js')
            .releasePublicTicketBooking('booking-cancel-fails', {
                reason: 'customer_declined',
            }, { uid: 'admin-1', email: 'admin@example.invalid' }),
        /could not confirm.*cancellation/i,
    );
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
    assert.notEqual(f.records.get('publicBookings/booking-cancel-fails').checkoutFailure.cleanupStatus, 'complete');
});

test('ADMIN RELEASE: a paid booking can never be released', async () => {
    const f = fixture();
    f.seat('seat-1', { status: 'booked', bookingId: 'booking-paid' });
    f.seed('publicBookings/booking-paid', {
        eventId: 'APCS2026', paymentStatus: 'PAID', invoiceId: 'invoice-paid',
        selectedSeatIds: ['seat-1'], orchestraSelectedSeatIds: [], physicalSeatKeys: [],
        capacityReservation: null, complimentaryTickets: 0,
    });

    await assert.rejects(
        f.load('src/services/PublicTicketAdminReleaseService.js')
            .releasePublicTicketBooking('booking-paid', {
                reason: 'customer_declined',
            }, { uid: 'admin-1', email: 'admin@example.invalid' }),
        /paid booking/i,
    );
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'booked');
});

test('ADMIN RELEASE: a pending checkout without an invoice cannot be manually released', async () => {
    const f = fixture();
    f.seat('seat-1', { status: 'locked', lockedByBookingId: 'booking-pending-no-invoice' });
    f.seed('publicBookings/booking-pending-no-invoice', {
        eventId: 'APCS2026', paymentStatus: 'pending',
        selectedSeatIds: ['seat-1'], orchestraSelectedSeatIds: [], physicalSeatKeys: [],
        capacityReservation: null, complimentaryTickets: 0,
        createdAt: f.timestamp(Date.parse('2026-09-06T03:00:00Z')),
    });

    await assert.rejects(
        f.load('src/services/PublicTicketAdminReleaseService.js')
            .releasePublicTicketBooking('booking-pending-no-invoice', {
                reason: 'customer_declined', manualProviderConfirmation: true,
            }, { uid: 'admin-1', email: 'admin@example.invalid' }),
        /still pending invoice creation/i,
    );
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
});

test('ADMIN RELEASE: local inventory release is atomic and retries without canceling Paper twice', async () => {
    let cancellationCount = 0;
    const f = fixture({ onCancel: () => { cancellationCount += 1; } });
    f.seat('seat-1', { status: 'locked', lockedByBookingId: 'booking-missing-capacity' });
    f.seed('publicBookings/booking-missing-capacity', {
        eventId: 'APCS2026', paymentStatus: 'pending', invoiceId: 'invoice-missing-capacity',
        selectedSeatIds: ['seat-1'], orchestraSelectedSeatIds: [], physicalSeatKeys: [],
        capacityReservation: { capacityId: 'missing-capacity', byTier: { presto: 1 } },
        complimentaryTickets: 0,
        createdAt: f.timestamp(Date.parse('2026-09-06T03:00:00Z')),
    });
    const service = f.load('src/services/PublicTicketAdminReleaseService.js');

    await assert.rejects(
        service.releasePublicTicketBooking('booking-missing-capacity', {
            reason: 'customer_declined',
        }, { uid: 'admin-1', email: 'admin@example.invalid' }),
        /missing_capacity_reservation/i,
    );
    assert.equal(cancellationCount, 1);
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
    assert.equal(
        f.records.get('publicBookings/booking-missing-capacity').expiry.invoiceCancellationStatus,
        'canceled',
    );

    f.seed('ticketCapacity/missing-capacity', { reservedByTier: { presto: 1 } });
    const result = await service.releasePublicTicketBooking('booking-missing-capacity', {
        reason: 'customer_declined',
    }, { uid: 'admin-1', email: 'admin@example.invalid' });
    assert.equal(result.released, true);
    assert.equal(cancellationCount, 1);
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'available');
});

test('ADMIN RELEASE: only customer-declined and one-hour no-response reasons are accepted', async () => {
    const f = fixture();
    f.seed('publicBookings/booking-invalid-reason', {
        eventId: 'APCS2026', paymentStatus: 'failed', selectedSeatIds: [],
        orchestraSelectedSeatIds: [], physicalSeatKeys: [], capacityReservation: null,
        complimentaryTickets: 0,
    });

    await assert.rejects(
        f.load('src/services/PublicTicketAdminReleaseService.js')
            .releasePublicTicketBooking('booking-invalid-reason', {
                reason: 'paper_invoice_not_found', manualProviderConfirmation: true,
            }, { uid: 'admin-1', email: 'admin@example.invalid' }),
        error => {
            assert.match(error.message, /valid reason/i);
            assert.equal(error.code, 'INVALID_RELEASE_REASON');
            return true;
        },
    );
});

test('ADMIN RELEASE: a late invoice ID prevents a manually confirmed release', async () => {
    const f = fixture();
    f.seat('seat-1', { status: 'locked', lockedByBookingId: 'booking-late-invoice' });
    f.seed('publicBookings/booking-late-invoice', {
        eventId: 'APCS2026', paymentStatus: 'failed', invoiceId: 'invoice-arrived-late',
        selectedSeatIds: ['seat-1'], orchestraSelectedSeatIds: [], physicalSeatKeys: [],
        capacityReservation: null, complimentaryTickets: 0,
        checkoutFailure: { cleanupStatus: 'awaiting_cancellation', invoiceCancellationStatus: 'unknown' },
    });

    await assert.rejects(
        f.load('src/repositories/PublicTicketFailureRepository.js')
            .releaseAdminBookingInventory('booking-late-invoice', {
                terminalStatus: 'failed', lifecycleField: 'checkoutFailure',
                invoiceCancellationStatus: 'manually_verified_no_active_invoice',
                reason: 'customer_declined', note: '', actor: { uid: 'admin-1' },
                expectedPaymentStatus: 'failed', expectedInvoiceId: null,
                expectedInvoiceCancellationStatus: null,
            }),
        /invoice changed/i,
    );
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
});

test('MANUAL PAYMENT: checkout reserves seats without an invoice or expiry and staff confirms owned inventory once', async () => {
    const f = fixture(); f.seat();
    const request = {
        bookingType: 'winner', registrantId: 'winner', manualPayment: true,
        idempotencyKey: 'manual-winner-1', selectedSeatIds: ['seat-1'],
        addOnIds: ['seat_selection_performer'],
    };
    const first = await f.book(request);
    assert.ifError(first.error);
    assert.equal(f.invoices.length, 0);
    assert.equal(f.timers.length, 0);
    const booking = f.records.get(`publicBookings/${first.result.bookingId}`);
    assert.equal(booking.paymentMode, 'manual');
    assert.equal(booking.lockExpiresAt, null);
    assert.equal(booking.invoiceId, undefined);
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'locked');
    const retry = await f.book(request);
    assert.ifError(retry.error);
    assert.equal(retry.result.bookingId, first.result.bookingId);
    const paid = await f.repo.markManualBookingPaid(first.result.bookingId, { uid: 'admin-1', email: 'admin@example.invalid' });
    assert.equal(paid.paymentStatus, 'PAID');
    assert.equal(f.records.get(`publicBookings/${first.result.bookingId}`).paymentStatus, 'PAID');
    assert.equal(f.records.get('seatsAPCS2026/seat-1').status, 'booked');
    assert.equal((await f.repo.markManualBookingPaid(first.result.bookingId, { uid: 'admin-1' })).alreadyPaid, true);
});

test('MANUAL PAYMENT: staff cancellation releases only an explicitly unpaid manual booking', async () => {
    const f = fixture();
    const order = await f.book({
        bookingType: 'public_competition', registrantId: 'winner', manualPayment: true,
        tickets: [{ id: 'presto', name: 'Presto', quantity: 5 }],
    });
    assert.ifError(order.error);
    const id = order.result.bookingId;
    const service = f.load('src/services/PublicTicketAdminReleaseService.js');
    await assert.rejects(service.releasePublicTicketBooking(id, {
        reason: 'manual_payment_unpaid', paymentNotReceivedConfirmed: false,
    }, { uid: 'admin-1' }), /Confirm that staff checked payment/);
    const result = await service.releasePublicTicketBooking(id, {
        reason: 'manual_payment_unpaid', paymentNotReceivedConfirmed: true,
    }, { uid: 'admin-1', email: 'admin@example.invalid' });
    assert.equal(result.released, true);
    assert.equal(f.records.get(`publicBookings/${id}`).paymentStatus, 'expired');
    assert.equal(f.records.get(`publicBookings/${id}`).adminRelease.reason, 'manual_payment_unpaid');
    const capacity = [...f.records.entries()].find(([key]) => key.startsWith('ticketCapacity/'))[1];
    assert.equal(capacity.reservedByTier.presto, 0);
    assert.equal(f.invoices.length, 0);
});

test('PUBLIC PERFORMANCE: public sale remains available when the winner purchase tier is closed', async () => {
    const f = fixture();
    f.records.get('systemSettings/global').ticketEligibility = {
        enabled: true,
        schedule: [{ date: '2026-09-06', allowedTiers: ['Public'] }],
    };
    const publicOrder = await f.book({ bookingType: 'public_competition', registrantId: 'winner' });
    assert.ifError(publicOrder.error);
    assert.equal(f.records.get(`publicBookings/${publicOrder.result.bookingId}`).orchestraAttendanceTickets, 1);
    const winnerOrder = await f.book({ bookingType: 'winner', registrantId: 'winner' });
    assert.match(winnerOrder.error.message, /not eligible to purchase tickets today/);
    const publicList = await new Promise((resolve, reject) => {
        f.repo.getEligibleWinners({ buyerType: 'public' }, (error, result) => error ? reject(error) : resolve(result));
    });
    assert.equal(publicList.winners.length, 1);
    assert.equal(publicList.winners[0].email, '');
});
