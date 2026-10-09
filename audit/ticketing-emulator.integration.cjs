// Real Firestore integration audit. Failed assertions are release blockers.
// Paper.id/email are substituted; this script cannot create invoices or send mail.
// Requires a separately started emulator: FIRESTORE_EMULATOR_HOST=127.0.0.1:8082
// Run: node apcs_service/audit/ticketing-emulator.integration.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createRequire } = require('node:module');
const serviceRoot = path.resolve(__dirname, '..');
const root = path.resolve(serviceRoot, '..');
const localRequire = createRequire(path.join(serviceRoot, 'package.json'));
const { Firestore, FieldValue, Timestamp, FieldPath } = localRequire('@google-cloud/firestore');
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8082', 'Refusing to connect outside the isolated local emulator.');
const admin = { firestore: { FieldValue, Timestamp, FieldPath } };
const quiet = { info() {}, warn() {}, error() {}, log() {} };
const eventId = 'QA20261007';
const date = '2026-11-01';
const session = '09:00-10:00';
const results = [];
// Revised 7 October 2026 after the repair batch (docs/TICKETING_REPAIR_PLAN_2026-10-07.md). The pre-repair
// run remains in docs/audits/ticketing-emulator-results-2026-10-07.json. Checks prefixed POLICY reflect the
// owner's staff-managed orchestra capacity decision; they are not repaired safety defects.

async function fixture(options = {}) {
    const projectId = 'demo-apcs-ticketing-qa';
    const store = new Firestore({ projectId, host: '127.0.0.1:8082', ssl: false });
    const collections = await store.listCollections();
    if (collections.length) {
        await store.terminate();
        throw new Error('QA project must be empty: refusing to overwrite an existing database');
    }
    const invoices = [], cancellations = [], emails = [], timers = [], intervals = [];
    const db = {
        collection: store.collection.bind(store), batch: store.batch.bind(store),
        runTransaction: callback => store.runTransaction(async transaction => {
            let writesPaid = false;
            const observed = new Proxy(transaction, { get(target, name) {
                if (name === 'update') return (ref, values, ...rest) => {
                    if (values?.paymentStatus === 'PAID') writesPaid = true;
                    return target.update(ref, values, ...rest);
                };
                const value = target[name];
                return typeof value === 'function' ? value.bind(target) : value;
            } });
            const result = await callback(observed);
            if (options.failCommit) throw new Error('Injected failure before real transaction commit');
            if (options.failPaidCommit && writesPaid) throw new Error('Injected paid fulfillment failure before real commit');
            if (options.beforeCommit) await options.beforeCommit();
            return result;
        }),
    };
    const paper = {
        async createInvoice(body, callback) {
            invoices.push(body);
            if (options.beforeInvoiceResponse) await options.beforeInvoiceResponse(body);
            if (options.invoiceFails) return callback(new Error('Injected lost invoice response'));
            return callback(null, { invoiceId: `qa-invoice-${body.externalId}`, paymentUrl: 'https://example.invalid/qa-invoice' });
        },
        // Authenticated provider invoice lookup used only for verified recovery.
        async getInvoice(id) {
            if (!options.provider) throw new Error('Provider lookup unavailable in this check');
            return options.provider(id);
        },
        async deleteInvoice(id) {
            cancellations.push(id);
            if (options.beforeCancellationResponse) await options.beforeCancellationResponse(id);
            return options.cancelFails !== true;
        },
    };
    const email = new Proxy({}, { get: (_, name) => async data => { emails.push({ name, bookingId: data?.id }); } });
    // Each loader has its own module cache; a second loader models a restarted service process.
    function makeLoader() {
    const cache = new Map();
    function load(relative) {
        if (cache.has(relative)) return cache.get(relative);
        const filename = path.join(serviceRoot, relative);
        const lazy = relativePath => () => load(relativePath);
        const dependencies = {
            '../configs/firebase-init': { db, admin }, 'firebase-admin': admin, crypto: require('node:crypto'),
            '../utils/Logger': { logger: quiet }, '../utils/Logger.js': { logger: quiet },
            './PaperRepository': paper, '../repositories/PaperRepository': paper,
            './PublicTicketFailureRepository': lazy('src/repositories/PublicTicketFailureRepository.js'),
            '../repositories/PublicTicketFailureRepository': lazy('src/repositories/PublicTicketFailureRepository.js'),
            './PublicTicketRepository': lazy('src/repositories/PublicTicketRepository.js'),
            '../repositories/PublicTicketRepository': lazy('src/repositories/PublicTicketRepository.js'),
            '../repositories/PublicTicketPaymentReceiptRepository': lazy('src/repositories/PublicTicketPaymentReceiptRepository.js'),
            '../repositories/TicketSeatAdminRepository': lazy('src/repositories/TicketSeatAdminRepository.js'),
            '../services/PublicTicketPaymentService': lazy('src/services/PublicTicketPaymentService.js'),
            '../services/PublicTicketService': lazy('src/services/PublicTicketService.js'),
            '../utils/DatabaseUtil': lazy('src/utils/DatabaseUtil.js'),
            '../services/PublicTicketAdminReleaseService': {},
            '../services/PaperService.js': {}, 'express-validator': {}, '../utils/discountUtils': {},
            '../services/EmailService': email, './EmailService': email, 'jsonwebtoken': {},
        };
        const mod = new Module(filename, module);
        mod.filename = filename;
        mod.require = name => {
            assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}; external calls are forbidden`);
            const dependency = dependencies[name];
            return typeof dependency === 'function' ? dependency() : dependency;
        };
        // Timer substitution prevents the test process from creating live background jobs.
        const source = fs.readFileSync(filename, 'utf8');
        const execute = new Function('exports', 'require', 'module', '__filename', '__dirname', 'auditTimers', 'auditIntervals', `const setTimeout = cb => auditTimers.push(cb); const setInterval = cb => auditIntervals.push(cb);\n${source}`);
        execute(mod.exports, mod.require, mod, filename, path.dirname(filename), timers, intervals);
        cache.set(relative, mod.exports);
        return mod.exports;
    }
    return load;
    }
    const load = makeLoader();
    const failure = load('src/repositories/PublicTicketFailureRepository.js');
    const repo = load('src/repositories/PublicTicketRepository.js');
    const controller = load('src/controllers/PublicTicketController.js');
    const venue = { id: 'V1', label: 'QA Hall', sessions: { [date]: [session, '19:00-20:00'] }, seatConfig: [{ row: 'A', areaType: 'presto', seatCount: options.capacity || 10 }, { row: 'B', areaType: 'allegro', seatCount: 10 }] };
    await store.doc('systemSettings/global').set({ currentEventId: eventId, ticketEligibility: { enabled: false } });
    await store.doc(`events/${eventId}`).set({
        competitionScheduleState: { status: 'ready' }, venues: [venue],
        ticketTiers: [{ id: 'presto', name: 'Presto', venuePrices: { V1: 150000 } }, { id: 'allegro', name: 'Allegro', venuePrices: { V1: 75000 } }],
        addOns: [{ id: 'seat_selection_performer', name: 'Choose seat', price: 10000 }],
        orchestraSessions: [{ id: 'orch', venue: 'V1', date, time: '19:00-20:00', complimentaryQuota: options.quota ?? 10, complimentaryClaimed: 0, freeSeatingAssigned: 0 }],
    });
    await store.doc('Registrants2025/winner').set({ eventId, finalAward: 'Gold', performers: [{ fullName: 'QA Performer', email: 'qa@example.invalid' }] });
    await store.doc(`sessionAssignments/${eventId}`).set({ assignments: { [`V1_${date}_${session}`]: [{ registrantId: 'winner' }] } });
    const body = overrides => ({ buyerName: 'QA Buyer', userEmail: 'qa@example.invalid', userPhone: '080000000000', bookingType: 'public_competition', registrantId: 'winner', venue: 'V1', date, session, tickets: [{ id: 'presto', quantity: 1, priceEach: 1 }], selectedSeatIds: [], orchestraSelectedSeatIds: [], addOnIds: [], ...overrides });
    async function book(overrides) {
        let calls = 0, error, result;
        await repo.createPublicTicketBooking(body(overrides), (err, data) => { calls++; error = err; result = data; });
        assert.equal(calls, 1, 'Checkout callback must settle exactly once');
        return { error, result };
    }
    const read = async key => (await store.doc(key).get()).data();
    const booking = id => read(`publicBookings/${id}`);
    async function seat(id = 'seat-1', overrides = {}) {
        await store.doc(`seats${eventId}/${id}`).set({ eventId, venueId: 'V1', sessionId: `${date}_${session}`, row: 'A', number: 1, areaType: 'presto', seatLabel: 'A1', status: 'available', ...overrides });
    }
    async function pay(id) {
        const current = await booking(id);
        return repo.handlePublicTicketWebhookPaid(id, payload(id, current.totalAmount));
    }
    async function cleanup() {
        assert.equal(projectId, 'demo-apcs-ticketing-qa');
        for (const collection of await store.listCollections()) await store.recursiveDelete(collection);
        await store.terminate();
    }
    const receipts = async () => (await store.collection('ticketPaymentReceipts').get()).docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const confirmations = id => emails.filter(item => item.name === 'sendPublicBookingConfirmationEmail' && item.bookingId === id).length;
    return { projectId, store, db, repo, controller, failure, book, body, booking, read, seat, pay, invoices, cancellations, emails, timers, options, load, makeLoader, receipts, confirmations, cleanup };
}
const payload = (id, total = 150000) => ({ invoice: { id: `qa-invoice-${id}`, number: id, status: 'paid', total_amount: total } });
const response = () => ({ statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } });
async function check(name, run, options = {}) {
    if (process.env.APCS_QA_FILTER && !name.includes(process.env.APCS_QA_FILTER)) return;
    let f;
    const started = Date.now();
    try {
        f = await fixture(options);
        const detail = await run(f);
        results.push({ name, status: 'PASS', detail });
    } catch (error) {
        const state = f ? {
            invoiceCalls: f.invoices.length,
            bookings: (await f.store.collection('publicBookings').get()).docs.map(doc => ({ id: doc.id, status: doc.data().paymentStatus, seatIds: doc.data().selectedSeatIds })),
            seats: (await f.store.collection(`seats${eventId}`).get()).docs.map(doc => ({ id: doc.id, status: doc.data().status, owner: doc.data().lockedByBookingId || doc.data().bookingId || null })),
            capacity: (await f.store.collection('ticketCapacity').get()).docs.map(doc => doc.data().reservedByTier),
        } : null;
        results.push({ name, status: 'FAIL', error: error.message, state });
        process.exitCode = 1;
    } finally {
        if (f) await f.cleanup();
    }
    results.at(-1).elapsedMs = Date.now() - started;
    console.log(`${results.at(-1).status}: ${name}${results.at(-1).error ? ` — ${results.at(-1).error}` : ''}`);
}

(async () => {
    // Fail promptly when the local emulator is stopped; never wait for SDK retries.
    await new Promise((resolve, reject) => {
        const socket = require('node:net').createConnection({ host: '127.0.0.1', port: 8082 });
        socket.setTimeout(2000);
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', error => { socket.destroy(); reject(new Error(`Local QA emulator unavailable: ${error.message}`)); });
        socket.once('timeout', () => { socket.destroy(); reject(new Error('Local QA emulator unavailable: connection timed out')); });
    });
    await check('Minimal emulator control: 20 claims on one document must accept one claimant', async f => {
        const ref = f.store.doc('emulatorControl/chair');
        await ref.set({ owner: null });
        const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => f.store.runTransaction(async transaction => {
            const snap = await transaction.get(ref);
            if (snap.data().owner !== null) throw new Error('Already claimed');
            transaction.update(ref, { owner: i });
            return i;
        })));
        assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
    });
    await check('20 simultaneous buyers of the same chair produce one booking and invoice', async f => {
        await f.seat();
        const attempts = await Promise.all(Array.from({ length: 20 }, () => f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] })));
        const accepted = attempts.filter(attempt => !attempt.error);
        assert.equal(accepted.length, 1); assert.equal(f.invoices.length, 1);
        const id = accepted[0].result.bookingId;
        assert.equal((await f.read(`seats${eventId}/seat-1`)).lockedByBookingId, id);
        assert.equal((await f.store.collection('publicBookings').get()).size, 1);
        return { accepted: 1, rejected: 19 };
    });
    await check('Two document aliases for one physical chair cannot sell twice', async f => {
        await f.seat('alias-1'); await f.seat('alias-2');
        const attempts = await Promise.all(['alias-1', 'alias-2'].map(id => f.book({ selectedSeatIds: [id], addOnIds: ['seat_selection_performer'] })));
        assert.equal(attempts.filter(attempt => !attempt.error).length, 1);
        assert.equal((await f.store.collection('ticketSeatOwnership').get()).size, 1);
    });
    await check('20 simultaneous unselected purchases cannot oversell the last tier place', async f => {
        const attempts = await Promise.all(Array.from({ length: 20 }, () => f.book()));
        assert.equal(attempts.filter(attempt => !attempt.error).length, 1);
        const counters = await f.store.collection('ticketCapacity').get();
        assert.equal(counters.docs[0].data().reservedByTier.presto, 1);
    }, { capacity: 1 });
    await check('Concurrent retries of one checkout create one invoice and one capacity reservation', async f => {
        const attempts = await Promise.all(Array.from({ length: 10 }, () => f.book({ idempotencyKey: 'qa-retry' })));
        attempts.forEach(attempt => assert.ifError(attempt.error));
        assert.equal(new Set(attempts.map(attempt => attempt.result.bookingId)).size, 1);
        assert.equal(f.invoices.length, 1);
        const counters = await f.store.collection('ticketCapacity').get();
        assert.equal(counters.docs[0].data().reservedByTier.presto, 1);
    });
    await check('Idempotency recovery control: refused concurrent requests can retry the same checkout', async f => {
        const attempts = await Promise.all(Array.from({ length: 10 }, () => f.book({ idempotencyKey: 'qa-recover-retry' })));
        const initialErrors = attempts.filter(attempt => attempt.error).map(attempt => attempt.error.message);
        const retry = await f.book({ idempotencyKey: 'qa-recover-retry' });
        assert.ifError(retry.error);
        assert.equal(f.invoices.length, 1);
        assert.equal((await f.store.collection('publicBookings').get()).size, 1);
        const counters = await f.store.collection('ticketCapacity').get();
        assert.equal(counters.docs[0].data().reservedByTier.presto, 1);
        attempts.filter(attempt => !attempt.error).forEach(attempt => assert.equal(attempt.result.bookingId, retry.result.bookingId));
        return { initialErrors, recoveredBookingId: retry.result.bookingId };
    });
    await check('Concurrent duplicate paid callbacks preserve one booked chair and reservation', async f => {
        await f.seat(); const attempt = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] }); assert.ifError(attempt.error);
        const id = attempt.result.bookingId;
        await Promise.all(Array.from({ length: 10 }, () => f.pay(id)));
        assert.equal((await f.booking(id)).paymentStatus, 'PAID');
        assert.equal((await f.read(`seats${eventId}/seat-1`)).status, 'booked');
        assert.equal((await f.store.collection('ticketCapacity').get()).docs[0].data().reservedByTier.presto, 1);
    });
    await check('Expiry retains inventory when provider cancellation fails', async f => {
        await f.seat(); const attempt = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] }); assert.ifError(attempt.error);
        await f.store.doc(`publicBookings/${attempt.result.bookingId}`).update({ lockExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
        assert.equal(await f.failure.expirePublicTicketBooking(attempt.result.bookingId), false);
        assert.equal((await f.booking(attempt.result.bookingId)).paymentStatus, 'pending');
        assert.equal((await f.read(`seats${eventId}/seat-1`)).status, 'locked');
    }, { cancelFails: true });
    await check('Repeated confirmed expiry releases chair and capacity exactly once', async f => {
        await f.seat(); const attempt = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] }); assert.ifError(attempt.error);
        const id = attempt.result.bookingId;
        await f.store.doc(`publicBookings/${id}`).update({ lockExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
        await Promise.all([f.failure.expirePublicTicketBooking(id), f.failure.expirePublicTicketBooking(id)]);
        assert.equal((await f.booking(id)).paymentStatus, 'expired');
        assert.equal((await f.read(`seats${eventId}/seat-1`)).status, 'available');
        assert.equal((await f.store.collection('ticketCapacity').get()).docs[0].data().reservedByTier.presto, 0);
    });
    await check('Payment that wins while cancellation is waiting is never released', async f => {
        await f.seat(); const attempt = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] }); assert.ifError(attempt.error);
        const id = attempt.result.bookingId;
        await f.store.doc(`publicBookings/${id}`).update({ lockExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
        f.options.beforeCancellationResponse = async () => f.pay(id);
        assert.equal(await f.failure.expirePublicTicketBooking(id), false);
        assert.equal((await f.booking(id)).paymentStatus, 'PAID');
        assert.equal((await f.read(`seats${eventId}/seat-1`)).status, 'booked');
    });
    await check('Manual mark-paid retries retain inventory and never call Paper.id', async f => {
        await f.seat(); const attempt = await f.book({ manualPayment: true, selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] }); assert.ifError(attempt.error);
        const actor = { uid: 'qa-staff', email: 'qa@example.invalid' };
        await Promise.all([f.repo.markManualBookingPaid(attempt.result.bookingId, actor), f.repo.markManualBookingPaid(attempt.result.bookingId, actor)]);
        assert.equal((await f.booking(attempt.result.bookingId)).paymentStatus, 'PAID');
        assert.equal(f.invoices.length, 0);
    });
    await check('PUBLIC ORCHESTRA: both independent sessions purchase and confirm without numbered-seat locks', async f => {
        const times = ['15:30-17:30', '19:30-21:30'];
        const venue = (await f.read(`events/${eventId}`)).venues[0];
        await f.store.doc(`events/${eventId}`).update({
            venues: [{ ...venue, sessions: { [date]: [session] } }],
            orchestraSessions: times.map((time, index) => ({ id: `orch-${index}`, venue: 'V1', date, time })),
        });
        const bookingIds = [];
        for (const time of times) {
            const attempt = await f.book({
                bookingType: 'public_orchestra', registrantId: undefined, session: time,
                userEmail: 'renaldolouis555@gmail.com', userPhone: '082385590505',
            });
            assert.ifError(attempt.error);
            bookingIds.push(attempt.result.bookingId);
            const pending = await f.booking(attempt.result.bookingId);
            assert.equal(pending.session, time);
            assert.equal(pending.seatingMode, 'free');
            assert.equal(pending.paymentStatus, 'pending');
            assert.equal(pending.totalAmount, 150000);
            const paidResponse = response();
            await f.controller.handlePublicTicketWebhook({
                body: payload(attempt.result.bookingId, pending.totalAmount),
            }, paidResponse);
            assert.equal(paidResponse.statusCode, 200);
            assert.equal((await f.booking(attempt.result.bookingId)).paymentStatus, 'PAID');
            assert.equal((await f.booking(attempt.result.bookingId)).emailSent, true);
            assert.equal(f.emails.filter(item => item.name === 'sendPublicBookingConfirmationEmail'
                && item.bookingId === attempt.result.bookingId).length, 1);
        }
        assert.equal(f.invoices.length, 2);
        assert.ok((await f.receipts()).every(receipt => receipt.status === 'processed'));
        assert.equal((await f.receipts()).length, 2);
        assert.equal((await f.store.collection('ticketSeatOwnership').get()).size, 0);
        assert.equal((await f.store.collection(`seats${eventId}`).get()).size, 0);
        assert.deepEqual((await f.read(`events/${eventId}`)).venues[0].sessions[date], [session]);
        const capacity = (await f.store.collection('ticketCapacity').get()).docs.map(doc => doc.data());
        assert.equal(capacity.length, 2);
        for (const counter of capacity) {
            assert.ok(times.includes(counter.session));
            assert.equal(counter.capacityPolicy, 'staff_managed');
            assert.equal(counter.reservedByTier.presto, 1);
        }
        return { times, bookingIds, paymentStatus: 'PAID', invoiceCalls: 2, numberedSeatLocks: 0 };
    });
    await check('POLICY: direct public orchestra sales exceed the competition layout while competition tier capacity holds', async f => {
        // Revised policy (formerly: the eleventh orchestra ticket must be refused by the quota/layout ceiling).
        const attempt = await f.book({ bookingType: 'public_orchestra', registrantId: undefined, session: '19:00-20:00', tickets: [{ id: 'presto', quantity: 10 }] });
        assert.ifError(attempt.error);
        await f.pay(attempt.result.bookingId);
        const beyond = await f.book({ bookingType: 'public_orchestra', registrantId: undefined, session: '19:00-20:00', tickets: [{ id: 'allegro', quantity: 15 }, { id: 'presto', quantity: 5 }] });
        assert.ifError(beyond.error);
        assert.equal((await f.booking(attempt.result.bookingId)).paymentStatus, 'PAID');
        assert.equal((await f.booking(attempt.result.bookingId)).seatingMode, 'free');
        const counters = (await f.store.collection('ticketCapacity').get()).docs.map(doc => doc.data());
        const orchestra = counters.find(counter => counter.session === '19:00-20:00');
        assert.equal(orchestra.reservedByTier.presto, 15); assert.equal(orchestra.reservedByTier.allegro, 15);
        assert.equal(orchestra.capacityPolicy, 'staff_managed');
        const saved = await f.load('src/repositories/OrchestraAssignmentRepository.js').saveSession({ eventId, session: { id: 'orch', venue: 'V1', date, time: '19:00-20:00', complimentaryQuota: 9999 } });
        assert.equal(saved.complimentaryQuota, 9999);
        // The numbered competition session keeps its 10-seat presto ceiling.
        assert.ifError((await f.book({ tickets: [{ id: 'presto', quantity: 10 }] })).error);
        assert.match((await f.book({ tickets: [{ id: 'presto', quantity: 1 }] })).error.message, /capacity/);
        return { orchestraHeadcount: orchestra.reservedByTier, competitionLayoutPresto: 10 };
    });
    await check('Orchestra: paid winner and public tickets combine with the performer once for staff assignment', async f => {
        const publicAttempt = await f.book(); assert.ifError(publicAttempt.error);
        const winnerAttempt = await f.book({ bookingType: 'winner', tickets: [{ id: 'presto', quantity: 2 }] }); assert.ifError(winnerAttempt.error);
        await f.pay(publicAttempt.result.bookingId); await f.pay(winnerAttempt.result.bookingId);
        const assignment = await f.load('src/repositories/OrchestraAssignmentRepository.js').assignGroup({ eventId, registrantId: 'winner', sessionId: 'orch' }, { email: 'qa@example.invalid' });
        assert.equal(assignment.quantity, 4);
        assert.equal(assignment.assignment.quantity, 4);
        assert.equal((await f.read(`events/${eventId}`)).orchestraSessions[0].freeSeatingAssigned, 4);
    });
    await check('POLICY: a paid performance group is assigned in full whatever the informational quota (staff-managed capacity)', async f => {
        // Revised policy (formerly: assignment had to fit quota 1). This is not a software capacity guarantee.
        const attempt = await f.book({ bookingType: 'winner', tickets: [{ id: 'presto', quantity: 2 }] }); assert.ifError(attempt.error);
        await f.pay(attempt.result.bookingId);
        assert.equal((await f.booking(attempt.result.bookingId)).paymentStatus, 'PAID');
        const assigned = await f.load('src/repositories/OrchestraAssignmentRepository.js').assignGroup({ eventId, registrantId: 'winner', sessionId: 'orch' }, { email: 'qa@example.invalid' });
        assert.equal(assigned.assignment.quantity, 3);
        assert.equal((await f.read(`events/${eventId}`)).orchestraSessions[0].freeSeatingAssigned, 3);
    }, { quota: 1 });
    await check('An early paid callback must remain recoverable after invoice persistence', async f => {
        // Revised entry point: checkout now runs through the real controller, which replays early receipts.
        let callbackResponse;
        f.options.beforeInvoiceResponse = async body => {
            callbackResponse = response();
            await f.controller.handlePublicTicketWebhook({ body: payload(body.externalId) }, callbackResponse);
        };
        const res = response();
        await f.controller.createPublicTicketBooking({ body: f.body() }, res, error => { throw error; });
        assert.equal(res.statusCode, 201);
        const id = res.body.bookingId;
        const current = await f.booking(id);
        assert.ok(current.paymentStatus === 'PAID' || current.paymentDetails || callbackResponse.statusCode >= 500,
            `Callback HTTP ${callbackResponse.statusCode}; booking ${current.paymentStatus}; invoice saved; no payment receipt/retry record`);
        assert.equal(callbackResponse.statusCode, 200);
        assert.equal((await f.receipts())[0].status, 'processed');
        assert.equal(f.confirmations(id), 1);
        return { callback: callbackResponse.body, bookingStatus: current.paymentStatus };
    });
    await check('Failed payment fulfillment must persist a receipt or request provider retry', async f => {
        const attempt = await f.book(); assert.ifError(attempt.error);
        f.options.failCommit = true;
        const responses = [];
        const genericController = f.load('src/controllers/PaperController.js');
        for (const [handler, name] of [
            [f.controller.handlePublicTicketWebhook, 'public callback'],
            [genericController.handlePaperWebhook, 'generic callback used by staging'],
        ]) {
            const res = response();
            await handler({ body: payload(attempt.result.bookingId) }, res);
            responses.push({ name, http: res.statusCode, body: res.body });
        }
        const current = await f.booking(attempt.result.bookingId);
        assert.ok(current.paymentDetails || responses.every(res => res.http >= 500),
            `Rollback verified: ${JSON.stringify(responses)}, booking ${current.paymentStatus}, no durable payment details`);
        return { responses };
    });
    await check('A paid callback whose fulfillment commit fails keeps a durable receipt and is paid once after restart', async f => {
        await f.seat(); const attempt = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] }); assert.ifError(attempt.error);
        const id = attempt.result.bookingId;
        f.options.failPaidCommit = true;
        const genericController = f.load('src/controllers/PaperController.js');
        const responses = [];
        const total = (await f.booking(id)).totalAmount;
        for (const handler of [f.controller.handlePublicTicketWebhook, genericController.handlePaperWebhook]) {
            const res = response(); await handler({ body: payload(id, total) }, res);
            responses.push({ http: res.statusCode, status: res.body.status });
        }
        assert.ok(responses.every(res => res.http === 200 && res.status === 'RECEIVED_FOR_RECONCILIATION'), JSON.stringify(responses));
        const [receipt] = await f.receipts();
        assert.equal(receipt.status, 'pending', `${receipt.reason}: ${receipt.lastError}`); assert.equal(receipt.deliveryCount, 2);
        assert.equal((await f.booking(id)).paymentStatus, 'pending');
        assert.equal((await f.read(`seats${eventId}/seat-1`)).status, 'locked');
        f.options.failPaidCommit = false;
        // Simulate elapsed backoff, then start the recovery job in a fresh module cache (a restarted process).
        await f.store.doc(`ticketPaymentReceipts/${receipt.id}`).update({ nextAttemptAt: 0 });
        const restarted = f.makeLoader();
        restarted('src/jobs/PublicTicketPaymentRecoveryJob.js').startPublicTicketPaymentRecovery();
        await f.timers.at(-1)();
        assert.equal((await f.booking(id)).paymentStatus, 'PAID');
        assert.equal((await f.read(`seats${eventId}/seat-1`)).status, 'booked');
        assert.equal((await f.receipts())[0].status, 'processed');
        assert.equal(f.confirmations(id), 1);
        return { responses };
    });
    await check('Lost invoice response must allow recovery of a subsequent matching paid callback', async f => {
        const attempt = await f.book(); assert.ok(attempt.error);
        const records = await f.store.collection('publicBookings').get();
        const id = records.docs[0].id;
        f.options.provider = async invoiceId => ({ invoiceId, number: id, paymentStatus: 'paid', total: records.docs[0].data().totalAmount });
        // The genuine provider identity is deliberately not saved: this models an ambiguous response.
        const res = response(); await f.controller.handlePublicTicketWebhook({ body: payload(id) }, res);
        const current = await f.booking(id);
        assert.ok(current.paymentDetails || res.statusCode >= 500,
            `HTTP ${res.statusCode}; booking ${current.paymentStatus}; cancellation ${current.checkoutFailure?.invoiceCancellationStatus}; no durable paid recovery`);
        assert.equal(current.paymentStatus, 'PAID');
        assert.equal(current.invoiceId, `qa-invoice-${id}`);
        assert.equal(current.paymentVerification.source, 'paper_sales_invoice_api');
        return { http: res.statusCode, recovered: current.paymentStatus };
    }, { invoiceFails: true });
    await check('An unverified or forged paid callback for a lost invoice keeps inventory held and is never marked PAID', async f => {
        await f.seat();
        const attempt = await f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] }); assert.ok(attempt.error);
        const id = (await f.store.collection('publicBookings').get()).docs[0].id;
        const total = (await f.booking(id)).totalAmount;
        f.options.provider = async invoiceId => invoiceId === 'forged'
            ? { invoiceId, number: 'other-booking', paymentStatus: 'paid', total }
            : { invoiceId, number: id, paymentStatus: 'unpaid', total };
        for (const invoiceId of ['forged', `qa-invoice-${id}`]) {
            const res = response(); await f.controller.handlePublicTicketWebhook({ body: { invoice: { id: invoiceId, number: id, status: 'paid', total_amount: total } } }, res);
            assert.equal(res.statusCode, 200);
        }
        const receipts = await f.receipts();
        assert.equal(receipts.find(item => item.providerInvoiceId === 'forged').status, 'needs_review');
        assert.equal(receipts.find(item => item.providerInvoiceId === `qa-invoice-${id}`).reason, 'provider_not_paid');
        assert.equal((await f.booking(id)).paymentStatus, 'failed');
        assert.equal((await f.read(`seats${eventId}/seat-1`)).lockedByBookingId, id, 'Inventory stays held without provider truth');
        assert.equal((await f.store.collection('ticketCapacity').get()).docs[0].data().reservedByTier.presto, 1);
    }, { invoiceFails: true });
    await check('Anonymous matching callback must not mark a booking paid', async f => {
        // Deferred finding (callback authenticity) — intentionally still failing; not part of this repair batch.
        const attempt = await f.book(); assert.ifError(attempt.error);
        const res = response(); await f.controller.handlePublicTicketWebhook({ body: payload(attempt.result.bookingId), headers: {} }, res);
        assert.notEqual((await f.booking(attempt.result.bookingId)).paymentStatus, 'PAID', 'Unsigned callback was accepted and persisted as PAID');
    });
    await check('Seat generation overlapping checkout must preserve the newly acquired lock', async f => {
        // Revised: generation now runs in the backend transaction; a checkout is started while it holds its reads.
        const sessionId = `${date}_${session}`;
        const id = `V1-presto-A1_${eventId}_${sessionId}`;
        await f.seat(id);
        let injected = false, pending;
        f.options.beforeCommit = async () => {
            if (injected) return;
            injected = true;
            pending = f.book({ selectedSeatIds: [id], addOnIds: ['seat_selection_performer'] });
            await new Promise(resolve => setTimeout(resolve, 500));
        };
        const generated = await f.load('src/repositories/TicketSeatAdminRepository.js').generateSeatLayout({ eventId, venueId: 'V1', sessionIds: [sessionId] });
        f.options.beforeCommit = null;
        const attempt = await pending;
        assert.ifError(attempt.error);
        const current = await f.read(`seats${eventId}/${id}`);
        assert.equal(current.lockedByBookingId, attempt.result.bookingId, `Checkout lock overwritten; resulting seat status ${current.status}`);
        assert.equal(current.status, 'locked');
        return { generated };
    });
    await check('Repeated generation concurrent with ten checkouts never erases a lock', async f => {
        const sessionId = `${date}_${session}`;
        const ids = Array.from({ length: 10 }, (_, index) => `V1-presto-A${index + 1}_${eventId}_${sessionId}`);
        for (const [index, id] of ids.entries()) await f.seat(id, { number: index + 1, seatLabel: `A${index + 1}` });
        const generator = f.load('src/repositories/TicketSeatAdminRepository.js');
        const [checkouts, ...generations] = await Promise.all([
            Promise.all(ids.map(id => f.book({ selectedSeatIds: [id], addOnIds: ['seat_selection_performer'] }))),
            generator.generateSeatLayout({ eventId, venueId: 'V1', sessionIds: [sessionId] }).then(value => ({ value }), error => ({ error })),
            generator.generateSeatLayout({ eventId, venueId: 'V1', sessionIds: [sessionId] }).then(value => ({ value }), error => ({ error })),
        ]);
        const accepted = checkouts.filter(item => !item.error);
        for (const [index, item] of checkouts.entries()) {
            if (item.error) continue;
            assert.equal((await f.read(`seats${eventId}/${ids[index]}`)).lockedByBookingId, item.result.bookingId);
        }
        // A generator that exhausts its transaction retries fails safely and can be rerun by staff.
        const retried = await generator.generateSeatLayout({ eventId, venueId: 'V1', sessionIds: [sessionId] });
        for (const [index, item] of checkouts.entries()) {
            if (!item.error) assert.equal((await f.read(`seats${eventId}/${ids[index]}`)).lockedByBookingId, item.result.bookingId);
        }
        assert.equal((await f.store.collection(`seats${eventId}`).get()).size, 20, 'The layout is complete without duplicates');
        return {
            accepted: accepted.length, rejected: checkouts.length - accepted.length,
            generations: generations.map(item => item.error ? `failed safely: ${item.error.message}` : item.value),
            finalPass: retried,
        };
    });
    await check('Staff assignment of paid unselected seats runs atomically on the backend under contention', async f => {
        // Replaces the retired Web SDK Transaction.get(Query) capability probe: staff assignment no longer depends on it.
        await f.seat('seat-1'); await f.seat('alias-1', { seatLabel: 'A-1' });
        const first = await f.book(); const second = await f.book({ tickets: [{ id: 'presto', quantity: 1 }] });
        assert.ifError(first.error); assert.ifError(second.error);
        await f.pay(first.result.bookingId); await f.pay(second.result.bookingId);
        const seatAdmin = f.load('src/repositories/TicketSeatAdminRepository.js');
        const actor = { uid: 'qa-staff', email: 'qa@example.invalid' };
        const outcomes = await Promise.allSettled([
            seatAdmin.assignPaidBookingSeats({ bookingId: first.result.bookingId, seatIds: ['seat-1'] }, actor),
            seatAdmin.assignPaidBookingSeats({ bookingId: second.result.bookingId, seatIds: ['alias-1'] }, actor),
            f.book({ selectedSeatIds: ['seat-1'], addOnIds: ['seat_selection_performer'] }).then(item => { if (item.error) throw item.error; return item; }),
        ]);
        assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1, JSON.stringify(outcomes.map(item => item.reason?.message || 'ok')));
        assert.equal((await f.store.collection('ticketSeatOwnership').where('active', '==', true).get()).size, 1);
        return { outcomes: outcomes.map(item => item.status === 'fulfilled' ? 'accepted' : item.reason.message) };
    });
    await check('Classification: attendance groups persist, publish no performance, and stay hidden from discovery and forged checkout', async f => {
        const planningEvent = 'QAPLAN';
        const planning = f.load('src/repositories/CompetitionPlanningRepository.js');
        await f.store.doc(`events/${planningEvent}`).set({
            venues: [{ id: 'V1', label: 'QA Hall', sessions: { [date]: ['19:00-20:00'] }, seatConfig: [{ row: 'A', areaType: 'presto', seatCount: 10 }, { row: 'B', areaType: 'allegro', seatCount: 10 }] }],
            ticketTiers: [{ id: 'presto', name: 'Presto', venuePrices: { V1: 150000 } }, { id: 'allegro', name: 'Allegro', venuePrices: { V1: 75000 } }],
            addOns: [], orchestraSessions: [{ id: 'orch', venue: 'V1', date, time: '19:00-20:00', complimentaryQuota: 0, complimentaryClaimed: 0, freeSeatingAssigned: 0 }],
        });
        for (const id of ['perf-1', 'guest-1']) await f.store.doc(`Registrants2025/${id}`).set({ eventId: planningEvent, finalAward: 'Gold', performers: [{ fullName: id }] });
        await planning.saveDraft(planningEvent, 0, []);
        const slots = await planning.saveSlot(planningEvent, 1, { venueId: 'V1', date, start: '09:00', end: '10:00' });
        await planning.saveDraft(planningEvent, 2, [
            { groupId: 'G1', venueId: 'V1', date, label: 'Group 1', slotId: slots.draftSlots[0].slotId, registrantIds: ['perf-1'] },
            { groupId: 'G2', venueId: 'V1', date, label: 'Orchestra guests', purpose: 'orchestra_attendance', registrantIds: ['guest-1'] },
        ]);
        const reloaded = await planning.getPlanningState(planningEvent);
        assert.equal(reloaded.groups.find(group => group.groupId === 'G2').purpose, 'orchestra_attendance');
        const preview = await planning.previewPublication(planningEvent);
        assert.ok(preview.canPublish, preview.errors.join(' '));
        await planning.publish(planningEvent, preview.revision, { uid: 'qa-staff' });
        const projection = await f.read(`sessionAssignments/${planningEvent}`);
        assert.equal(Object.keys(projection.assignments).join(','), `V1_${date}_09:00-10:00`);
        assert.equal(projection.attendanceOnlyRegistrantIds.join(','), 'guest-1');
        await f.load('src/repositories/TicketSeatAdminRepository.js').generateSeatLayout({ eventId: planningEvent, venueId: 'V1', sessionIds: [`${date}_09:00-10:00`] });
        assert.equal((await planning.markReady(planningEvent, { uid: 'qa-staff' })).ready, true);
        await f.store.doc('systemSettings/global').set({ currentEventId: planningEvent, ticketEligibility: { enabled: false } });
        for (const buyerType of ['public', undefined]) {
            let found;
            await f.repo.getEligibleWinners({ buyerType }, (error, data) => { assert.ifError(error); found = data; });
            assert.equal(found.winners.map(item => item.registrantId).join(','), 'perf-1');
        }
        const forged = await f.book({ registrantId: 'guest-1', venue: 'V1', date, session: '09:00-10:00' });
        assert.ok(forged.error, 'An attendance member cannot be bought as a competition performance');
        assert.ifError((await f.book({ registrantId: 'perf-1', venue: 'V1', date, session: '09:00-10:00' })).error);
        const direct = await f.book({ bookingType: 'public_orchestra', registrantId: undefined, session: '19:00-20:00', tickets: [{ id: 'presto', quantity: 25 }] });
        assert.ifError(direct.error);
        return { forged: forged.error.message, attendanceOnly: projection.attendanceOnlyRegistrantIds };
    });
    console.log(JSON.stringify({ emulator: '127.0.0.1:8082', externalPaymentAndEmail: 'substituted', passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
