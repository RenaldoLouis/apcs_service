// Run only against a disposable emulator: FIRESTORE_EMULATOR_HOST=127.0.0.1:8082 node this-file.
// Loads production redemption repositories with an isolated SDK; no app, credentials, jobs or integrations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
assert.equal(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8082', 'Only the disposable port-8082 emulator is allowed.');
const serviceRoot = path.resolve(__dirname, '..');
const serviceRequire = createRequire(path.join(serviceRoot, 'package.json'));
const webRequire = createRequire(path.join(serviceRoot, '../apcs_web/package.json'));
const { Firestore, FieldValue, FieldPath } = serviceRequire('@google-cloud/firestore');
const store = new Firestore({ projectId: 'demo-apcs-redemption-qa', host: '127.0.0.1:8082', ssl: false });
const db = { collection: store.collection.bind(store), runTransaction: callback => store.runTransaction(callback, { maxAttempts: 10 }) };
const admin = { firestore: { FieldValue, FieldPath } };
const cache = new Map();
function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const filename = path.join(serviceRoot, relative);
    const context = { module: { exports: {} }, process: { env: {} }, require: name => {
        if (name === '../configs/firebase-init') return { db, admin };
        if (name === '../services/TicketRedemptionModel') return load('src/services/TicketRedemptionModel.js');
        if (name === '../middlewares/ErrorHandlerMiddleware') return load('src/middlewares/ErrorHandlerMiddleware.js');
        throw new Error(`External dependency refused: ${name}`);
    } };
    // SDK transaction callbacks require a Promise from this Node realm.
    const execute = new Function('require', 'module', 'process', fs.readFileSync(filename, 'utf8'));
    execute(context.require, context.module, context.process);
    cache.set(relative, context.module.exports);
    return context.module.exports;
}
const repo = load('src/repositories/TicketRedemptionRepository.js');
const orchestra = load('src/repositories/OrchestraAssignmentRepository.js');
const eventId = 'REDEMPTION_QA';
const actor = { uid: 'qa-staff', email: 'staff@example.invalid' };
const date = '2026-11-01';
const results = [];
let client, webApp;
async function run() {
    if ((await store.listCollections()).length) throw new Error('The isolated QA project must be empty; refusing to overwrite existing records.');
    let seeded = false;
    try {
        seeded = true;
        await store.doc(`events/${eventId}`).set({ venues: [{ id: 'V1', label: 'QA Hall', sessions: { [date]: ['09:00-10:00'] } }],
            orchestraSessions: [{ id: 'orch', venue: 'V1', date, time: '19:00-20:00', freeSeatingAssigned: 10 },
                { id: 'orch2', venue: 'V1', date, time: '20:00-21:00', freeSeatingAssigned: 0 }] });
        const booking = { eventId, paymentStatus: 'PAID', ticketingVersion: 2, bookingType: 'winner', registrantId: 'group',
            performerCount: 3, orchestraAttendanceTickets: 5, buyerName: 'QA Buyer', venue: 'V1', date, session: '09:00-10:00',
            tickets: [{ id: 'presto', quantity: 5 }], venueName: 'QA Hall' };
        await store.doc('publicBookings/winner').set(booking);
        await store.doc('publicBookings/public').set({ ...booking, bookingType: 'public_competition', performerCount: 0,
            orchestraAttendanceTickets: 2, tickets: [{ id: 'allegro', quantity: 2 }] });
        await store.doc('Registrants2025/group').set({ eventId, performers: [{}, {}, {}] });
        await store.doc(`orchestraAssignments/${encodeURIComponent(`${eventId}|group`)}`).set({ eventId, registrantId: 'group',
            sessionId: 'orch', venue: 'V1', venueName: 'QA Hall', date, time: '19:00-20:00',
            quantity: 10, performerCount: 3, paidTicketCount: 7, publicTicketCount: 2, winnerTicketCount: 5,
            bookingIds: ['public', 'winner'], revision: 1, notifiedBookingIds: [] });
        const requestFor = async (channel, quantities, requestId, bookingId = 'winner') => {
            const allowance = (await repo.detail({ eventId, bookingId })).allowances.find(item => item.channel === channel);
            return { eventId, bookingId, channel, quantities, requestId, action: 'redeem', expectedRevision: allowance.revision, sessionKey: allowance.sessionKey };
        };
        const performance = await requestFor('performance', { presto: 3 }, 'performance-a');
        const competition = await Promise.allSettled([
            repo.claim(performance, actor), repo.claim({ ...performance, requestId: 'performance-b' }, { ...actor, uid: 'staff-b' }),
        ]);
        assert.equal(competition.filter(item => item.status === 'fulfilled').length, 1);
        assert.match(competition.find(item => item.status === 'rejected').reason.message, /Another staff member/);
        assert.equal((await repo.detail({ eventId, bookingId: 'winner' })).allowances.find(item => item.channel === 'performance').redeemed.presto, 3);
        results.push('Two simultaneous staff claims: one commit, one stale-request rejection; 3/5 redeemed.');

        const same = await requestFor('orchestra', { orchestra: 2 }, 'same-request');
        const replay = await Promise.all([repo.claim(same, actor), repo.claim(same, actor), repo.claim(same, actor)]);
        assert.equal(replay.filter(item => item.replayed).length, 2);
        const benefit = (await repo.detail({ eventId, bookingId: 'winner' })).allowances.find(item => item.channel === 'orchestra');
        assert.equal(benefit.redeemed.orchestra, 2); assert.equal(benefit.history.length, 1);
        results.push('Three concurrent identical request IDs: one handover/history entry, two replays.');

        const performerA = await requestFor('performers', { performers: 2 }, 'performer-a');
        const performerB = await requestFor('performers', { performers: 2 }, 'performer-b', 'public');
        const performers = await Promise.allSettled([repo.claim(performerA, actor), repo.claim(performerB, actor)]);
        assert.equal(performers.filter(item => item.status === 'fulfilled').length, 1);
        assert.match(performers.find(item => item.status === 'rejected').reason.message, /Another staff member/);
        for (const bookingId of ['winner', 'public']) assert.equal((await repo.detail({ eventId, bookingId })).allowances.find(item => item.channel === 'performers').remaining.performers, 1);
        results.push('Concurrent performer claims through different bookings: shared 2/3 total, one remaining.');

        const undo = { ...same, action: 'undo', expectedRevision: benefit.revision, targetClaimId: benefit.history[0].id,
            requestId: 'undo-a', reason: 'QA correction' };
        const undos = await Promise.allSettled([repo.claim(undo, actor), repo.claim({ ...undo, requestId: 'undo-b' }, actor)]);
        assert.equal(undos.filter(item => item.status === 'fulfilled').length, 1);
        assert.equal((await repo.detail({ eventId, bookingId: 'winner' })).allowances.find(item => item.channel === 'orchestra').remaining.orchestra, 5);
        results.push('Concurrent undo: one correction commit; the original two tickets restored once.');
        await assert.rejects(repo.claim(same, actor), /has been undone/);
        results.push('Retry of the original claim after correction is rejected, without authorizing a new handover.');

        await assert.rejects(orchestra.assignGroup({ eventId, registrantId: 'group', sessionId: 'orch2' }, actor), /already been redeemed/);
        results.push('Orchestra session move rejected while shared performer places remain redeemed.');

        // Native Web SDK calls in Node test rules, without launching a browser or the app.
        await store.doc(`whitelist/${actor.email}`).set({ email: actor.email });
        const appSdk = webRequire('firebase/app');
        const sdk = webRequire('firebase/firestore');
        webApp = appSdk.initializeApp({ projectId: 'demo-apcs-redemption-qa', apiKey: 'qa-only' }, 'redemption-rules-qa');
        client = sdk.getFirestore(webApp);
        sdk.connectFirestoreEmulator(client, '127.0.0.1', 8082, { mockUserToken: { sub: actor.uid, email: actor.email } });
        const stateRef = sdk.doc(client, 'ticketRedemptions', benefit.id);
        assert.ok((await sdk.getDoc(stateRef)).exists());
        for (const ref of [stateRef, sdk.doc(client, 'ticketRedemptions', benefit.id, 'claims', 'forged'),
            sdk.doc(client, 'ticketRedemptions', benefit.id, 'requests', 'forged')]) {
            await assert.rejects(sdk.setDoc(ref, { redeemed: { orchestra: 0 } }), error => error.code === 'permission-denied');
        }
        results.push('Actual rules: whitelisted client can read state but cannot write state, history or replay keys.');
        console.log(JSON.stringify({ passed: results.length, checks: results }, null, 2));
    } finally {
        if (client) await webRequire('firebase/firestore').terminate(client);
        if (webApp) await webRequire('firebase/app').deleteApp(webApp);
        if (seeded) for (const collection of await store.listCollections()) await store.recursiveDelete(collection);
        await store.terminate();
    }
}
run().catch(async error => { console.error(error); await store.terminate().catch(() => {}); process.exitCode = 1; });
