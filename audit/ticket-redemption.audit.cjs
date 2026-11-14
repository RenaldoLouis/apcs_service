// Production-code audit with in-memory Firestore. No customer records, providers or emails.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixtureFile = path.join(__dirname, 'public-ticket.audit.cjs');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').split("test('CONTROL:")[0]
    .replace('return { records, seed, timestamp', 'return { db, records, seed, timestamp')
    .replace('path: key, id: key.split', 'collection: name => collection(`${key}/${name}`), path: key, id: key.split')
    .replace('orderBy: field => collection(name, filters, { ...queryOptions, order: field })',
        'orderBy: (field, direction) => collection(name, filters, { ...queryOptions, order: field, direction })')
    .replace('a.id.localeCompare(b.id));', 'queryOptions.direction === "desc" ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id));')
    .replace("if (queryOptions.order === '__name__')", "if (queryOptions.order === 'revision') docs.sort((a, b) => b.data().revision - a.data().revision); if (queryOptions.order === '__name__')");
const context = { require, __dirname, module: { exports: {} } };
vm.runInNewContext(fixtureSource + '\nmodule.exports = fixture;', context, { filename: fixtureFile });
const actor = { uid: 'staff-1', email: 'staff@example.invalid' };
const input = { eventId: 'APCS2026', bookingId: 'order-1' };
function setup() {
    const emails = [];
    const modules = {
        './PublicTicketRepository': 'src/repositories/PublicTicketRepository.js',
        '../repositories/PublicTicketRepository': 'src/repositories/PublicTicketRepository.js',
        '../repositories/PublicTicketPaymentReceiptRepository': 'src/repositories/PublicTicketPaymentReceiptRepository.js',
        '../services/PublicTicketPaymentService': 'src/services/PublicTicketPaymentService.js',
    };
    const f = context.module.exports({ extraRequire: (name, load) => {
        if (name.endsWith('/TicketRedemptionModel')) return load('src/services/TicketRedemptionModel.js');
        if (name.endsWith('/RegistrantAttendanceImport')) return require('../src/services/RegistrantAttendanceImport');
        if (name === 'node:crypto') return require(name);
        if (name.endsWith('/ErrorHandlerMiddleware')) return load('src/middlewares/ErrorHandlerMiddleware.js');
        if (modules[name]) return load(modules[name]);
        if (name === './EmailService') return { sendPublicBookingConfirmationEmail: async booking => emails.push(booking) };
    } });
    f.seed('publicBookings/order-1', { eventId: input.eventId, paymentStatus: 'PAID', ticketingVersion: 2,
        bookingType: 'winner', registrantId: 'winner', registrantName: 'Performer One', buyerName: 'Buyer One',
        userEmail: 'buyer@example.invalid', userPhone: '12345', performerCount: 3, orchestraAttendanceTickets: 5,
        venue: 'V1', venueName: 'Hall 1', date: '2026-11-01', session: '09:00-10:00',
        tickets: [{ id: 'presto', quantity: 3 }, { id: 'allegro', quantity: 2 }], selectedSeatIds: [] });
    f.seed('orchestraAssignments/APCS2026%7Cwinner', { eventId: input.eventId, registrantId: 'winner',
        sessionId: 'orch', venue: 'V1', venueName: 'Hall 1', date: '2026-11-01', time: '19:00-20:00',
        performerCount: 3, quantity: 8, bookingIds: ['order-1'], revision: 1 });
    f.records.get('events/APCS2026').orchestraSessions[0].freeSeatingAssigned = 8;
    const repo = f.load('src/repositories/TicketRedemptionRepository.js');
    const allowance = async (channel, bookingId = input.bookingId) => (await repo.detail({ ...input, bookingId })).allowances.find(item => item.channel === channel);
    let sequence = 0;
    const request = async (channel, quantities, extra = {}) => {
        const current = await allowance(channel, extra.bookingId || input.bookingId);
        return { ...input, channel, action: 'redeem', quantities, sessionKey: current.sessionKey,
            expectedRevision: current.revision, requestId: `request-${++sequence}`, ...extra };
    };
    return { ...f, repo, allowance, request, emails };
}

// Compare actual checkout/fulfillment results in identical databases, with and without
// prior performance/orchestra/performer handovers. Only redemption records may differ.
const businessState = f => JSON.parse(JSON.stringify([...f.records]
    .filter(([key]) => !key.startsWith('ticketRedemptions/')).sort(([a], [b]) => a.localeCompare(b))));
for (const scenario of [
    { name: 'winner Paper.id purchase with selected numbered seats', buyer: { bookingType: 'winner', registrantId: 'winner' }, selected: true },
    { name: 'public performance Paper.id purchase with unselected seats', buyer: { bookingType: 'public_competition', registrantId: 'winner' } },
    { name: 'direct orchestra Paper.id free-seating purchase', buyer: { bookingType: 'public_orchestra', isOrchestra: true, session: '19:00-20:00' } },
    { name: 'public performance manual payment and numbered seats', buyer: { bookingType: 'public_competition', registrantId: 'winner', manualPayment: true }, selected: true },
    { name: 'direct orchestra manual free-seating payment', buyer: { bookingType: 'public_orchestra', isOrchestra: true, session: '19:00-20:00', manualPayment: true } },
]) {
    test(`REDEMPTION ISOLATION: ${scenario.name} has identical price, invoice, payment and inventory outcomes`, async () => {
        const run = async redeemed => {
            const f = setup();
            f.records.get('events/APCS2026').ticketTiers.push({ id: 'allegro', name: 'Allegro', venuePrices: { V1: 100000 } });
            f.records.get('events/APCS2026').venues[0].seatConfig.push({ row: 'C', seatCount: 10, areaType: 'allegro' });
            f.seat('new-seat', { number: 6, seatLabel: 'A6' });
            if (redeemed) {
                const before = businessState(f);
                await f.repo.claim(await f.request('performance', { presto: 1 }), actor);
                await f.repo.claim(await f.request('orchestra', { orchestra: 1 }), actor);
                await f.repo.claim(await f.request('performers', { performers: 1 }), actor);
                assert.deepEqual(businessState(f), before);
            }
            const access = [];
            const collection = f.db.collection;
            f.db.collection = name => { access.push(name); return collection(name); };
            const body = { ...scenario.buyer, idempotencyKey: 'purchase-isolation', tickets: [{ id: 'presto', quantity: 1 }],
                ...(scenario.selected ? { selectedSeatIds: ['new-seat'], addOnIds: ['seat_selection_performer'] } : {}) };
            const created = await f.book(body);
            assert.ifError(created.error);
            const id = created.result.bookingId;
            const pending = f.records.get(`publicBookings/${id}`);
            assert.equal(pending.paymentStatus, 'pending');
            assert.equal(pending.totalAmount, scenario.selected ? 160000 : 150000);
            const retry = await f.book(body);
            assert.ifError(retry.error); assert.equal(retry.result.bookingId, id);
            if (scenario.buyer.manualPayment) {
                await f.load('src/repositories/PublicTicketRepository.js').markManualBookingPaid(id, actor);
                assert.equal(f.invoices.length, 0);
            } else {
                const service = f.load('src/services/PublicTicketPaymentService.js');
                const payload = { invoice: { id: pending.invoiceId, number: id, status: 'paid', total_amount: pending.totalAmount } };
                const paid = await service.handlePublicBookingPaidCallback(id, pending, payload);
                assert.equal(paid.body.status, 'OK');
                await service.handlePublicBookingPaidCallback(id, f.records.get(`publicBookings/${id}`), payload);
                assert.equal(f.emails.length, 1); assert.equal(f.invoices.length, 1);
            }
            assert.equal(f.records.get(`publicBookings/${id}`).paymentStatus, 'PAID');
            if (scenario.selected) assert.equal(f.records.get('seatsAPCS2026/new-seat').bookingId, id);
            assert.equal(access.some(name => name.startsWith('ticketRedemptions')), false,
                'Checkout and payment never read or write redemption state');
            return { records: businessState(f), invoices: JSON.parse(JSON.stringify(f.invoices)),
                emails: JSON.parse(JSON.stringify(f.emails)), timers: f.timers.length };
        };
        assert.deepEqual(await run(true), await run(false));
    });
}

test('REDEMPTION ISOLATION: staff seat assignment remains available after a performance claim', async () => {
    const f = setup();
    f.seat('assignable-seat', { number: 7, seatLabel: 'A7' });
    await f.repo.claim(await f.request('performance', { presto: 1 }), actor);
    const before = JSON.stringify([...f.records].filter(([key]) => key.startsWith('ticketRedemptions/')));
    await f.load('src/repositories/TicketSeatAdminRepository.js').assignPaidBookingSeats({ bookingId: input.bookingId, seatIds: ['assignable-seat'] }, actor);
    assert.equal(f.records.get('seatsAPCS2026/assignable-seat').bookingId, input.bookingId);
    assert.equal(JSON.stringify([...f.records].filter(([key]) => key.startsWith('ticketRedemptions/'))), before);
});

test('REDEMPTION ISOLATION: a later purchase can update the same orchestra assignment without losing issued tickets', async () => {
    const f = setup();
    await f.repo.claim(await f.request('orchestra', { orchestra: 2 }), actor);
    await f.repo.claim(await f.request('performers', { performers: 1 }), actor);
    f.seed('publicBookings/later-order', { ...f.records.get('publicBookings/order-1'), bookingType: 'public_competition',
        tickets: [{ id: 'presto', quantity: 1 }], performerCount: 0, orchestraAttendanceTickets: 1 });
    const before = JSON.stringify([...f.records].filter(([key]) => key.startsWith('ticketRedemptions/')));
    const saved = await f.load('src/repositories/OrchestraAssignmentRepository.js').assignGroup({ eventId: input.eventId, registrantId: 'winner', sessionId: 'orch' }, actor);
    assert.equal(saved.assignment.quantity, 9); assert.ok(saved.assignment.bookingIds.includes('later-order'));
    assert.equal((await f.allowance('orchestra')).redeemed.orchestra, 2);
    assert.equal((await f.allowance('performers', 'later-order')).redeemed.performers, 1);
    assert.equal(JSON.stringify([...f.records].filter(([key]) => key.startsWith('ticketRedemptions/'))), before);
});

test('REDEMPTION: performance categories, orchestra benefit and shared performers are independent', async () => {
    const f = setup();
    const before = JSON.stringify([...f.records]);
    assert.equal((await f.repo.detail(input)).allowances.length, 3);
    assert.equal(JSON.stringify([...f.records]), before, 'Lookup makes no writes');
    await f.repo.claim(await f.request('performance', { presto: 2 }), actor);
    assert.equal((await f.allowance('performance')).remaining.presto, 1);
    assert.equal((await f.allowance('orchestra')).remaining.orchestra, 5);
    await f.repo.claim(await f.request('orchestra', { orchestra: 4 }), actor);
    assert.equal((await f.allowance('orchestra')).remaining.orchestra, 1);
    assert.equal((await f.allowance('performers')).remaining.performers, 3);
    assert.equal(JSON.stringify([...f.records].filter(([key]) => !key.startsWith('ticketRedemptions/'))), before,
        'Payment, tickets, seats and capacity stay intact');
    const history = (await f.allowance('orchestra')).history;
    assert.equal(history[0].actorUid, actor.uid); assert.equal(history[0].actorEmail, actor.email);
    assert.equal(history[0].bookingId, input.bookingId); assert.ok(history[0].claimedAt);
});

test('REDEMPTION: detail shows the current linked registrant note for a guest booking', async () => {
    const f = setup();
    f.seed('Registrants2025/winner', { eventId: 'APCS2025', adminNote: '  First line\nSecond line  ' });
    f.records.get('publicBookings/order-1').adminNote = 'Booking note';
    const linked = await f.repo.detail(input);
    assert.equal(linked.registrantNote, 'First line\nSecond line');
    assert.equal(linked.bookingAdminNote, 'Booking note');
    assert.equal(Object.hasOwn((await f.repo.list({ eventId: input.eventId })).bookings[0], 'registrantNote'), false);

    for (const adminNote of ['Updated note', '  ', undefined, 42]) {
        f.records.get('Registrants2025/winner').adminNote = adminNote;
        const detail = await f.repo.detail(input);
        assert.equal(detail.registrantNote, adminNote === 'Updated note' ? adminNote : '');
        assert.equal(detail.allowances.length, 3);
    }
    f.records.delete('Registrants2025/winner');
    assert.equal((await f.repo.detail(input)).registrantNote, '');
});

test('REDEMPTION: direct orchestra respects purchased categories and free seating without a registrant', async () => {
    const f = setup();
    Object.assign(f.records.get('publicBookings/order-1'), { bookingType: 'public_orchestra', isOrchestra: true,
        seatingMode: 'free', registrantId: '', orchestraAttendanceTickets: 0, session: '19:00-20:00',
        adminNote: '  Imported booking note\nSecond line  ' });
    const detail = await f.repo.detail(input);
    assert.equal(detail.bookingAdminNote, 'Imported booking note\nSecond line');
    assert.equal(detail.registrantNote, '');
    assert.equal(detail.allowances.length, 1); assert.equal(detail.allowances[0].channel, 'orchestra');
    await f.repo.claim(await f.request('orchestra', { presto: 3, allegro: 1 }), actor);
    assert.equal((await f.allowance('orchestra')).remaining.allegro, 1);
    await assert.rejects(f.repo.claim(await f.request('orchestra', { lento: 1 }), actor), /exceeds/);
});

test('REDEMPTION: shared performers cannot be issued again through another booking', async () => {
    const f = setup();
    f.seed('publicBookings/order-2', { ...f.records.get('publicBookings/order-1'), bookingType: 'public_competition', performerCount: 0 });
    f.records.get('orchestraAssignments/APCS2026%7Cwinner').bookingIds.push('order-2');
    await f.repo.claim(await f.request('performers', { performers: 2 }), actor);
    assert.equal((await f.allowance('performers', 'order-2')).remaining.performers, 1);
    await f.repo.claim(await f.request('performers', { performers: 1 }, { bookingId: 'order-2' }), actor);
    await assert.rejects(f.repo.claim(await f.request('performers', { performers: 1 }), actor), /exceeds/);
    assert.equal((await f.allowance('orchestra', 'order-2')).remaining.orchestra, 5);
});

test('REDEMPTION: pending, failed, expired, wrong event and archived bookings cannot be redeemed', async () => {
    for (const status of ['pending', 'failed', 'expired']) {
        const f = setup(); f.records.get('publicBookings/order-1').paymentStatus = status;
        await assert.rejects(f.repo.claim(await f.request('performance', { presto: 1 }), actor), /Payment/);
        assert.equal([...f.records.keys()].filter(key => key.startsWith('ticketRedemptions/')).length, 0);
    }
    const f = setup();
    await assert.rejects(f.repo.detail({ ...input, eventId: 'APCS2025' }), /not found/);
    f.records.get('publicBookings/order-1').paymentStatus = 'archived_test';
    await assert.rejects(f.repo.detail(input), /not found/);
});

test('REDEMPTION: missing, uncovered and stale orchestra assignments allow paid handover', async () => {
    for (const edit of [f => f.records.delete('orchestraAssignments/APCS2026%7Cwinner'),
        f => { f.records.get('orchestraAssignments/APCS2026%7Cwinner').bookingIds = []; },
        f => { f.records.get('orchestraAssignments/APCS2026%7Cwinner').time = 'wrong'; }]) {
        const f = setup(); edit(f);
        const before = businessState(f);
        assert.equal((await f.allowance('orchestra')).session, null);
        assert.equal((await f.allowance('orchestra')).sessionOptional, true);
        await f.repo.claim(await f.request('orchestra', { orchestra: 1 }), actor);
        await f.repo.claim(await f.request('performers', { performers: 1 }), actor);
        assert.deepEqual(businessState(f), before);
        assert.equal((await f.allowance('orchestra')).remaining.orchestra, 4);
        assert.equal((await f.allowance('performers')).remaining.performers, 2);
        await f.repo.claim(await f.request('performance', { presto: 1 }), actor);
    }
});

test('REDEMPTION: replay is exactly once, mismatched replay and stale staff requests reject', async () => {
    const f = setup();
    const request = await f.request('orchestra', { orchestra: 2 });
    const stale = { ...request, requestId: 'other-staff' };
    await f.repo.claim(request, actor);
    await f.repo.claim(await f.request('orchestra', { orchestra: 1 }), actor);
    assert.equal((await f.repo.claim(request, actor)).replayed, true);
    assert.equal((await f.allowance('orchestra')).redeemed.orchestra, 3);
    assert.equal((await f.allowance('orchestra')).history.length, 2);
    await assert.rejects(f.repo.claim({ ...request, quantities: { orchestra: 1 } }, actor), /different claim/);
    await assert.rejects(f.repo.claim(stale, actor), /Another staff member/);
});

test('REDEMPTION: a partial handover note stays with its claim through replay, a later claim and undo', async () => {
    const f = setup();
    const note = 'Mom and friend collected two. Dad will collect the last ticket.';
    const request = await f.request('performance', { presto: 2 }, { note: `  ${note}  ` });
    const first = await f.repo.claim(request, actor);
    const afterFirst = await f.allowance('performance');
    assert.equal(afterFirst.remaining.presto, 1);
    assert.equal(afterFirst.history[0].note, note);
    assert.equal((await f.repo.claim({ ...request, note }, actor)).replayed, true);
    await assert.rejects(f.repo.claim({ ...request, note: 'Changed note' }, actor), /different claim/);
    await assert.rejects(f.repo.claim({ ...request, note: undefined }, actor), /different claim/);

    const last = await f.request('performance', { presto: 1 });
    await f.repo.claim(last, actor);
    assert.equal((await f.repo.claim({ ...last, note: '  ' }, actor)).replayed, true);
    const afterLast = await f.allowance('performance');
    assert.equal(afterLast.remaining.presto, 0);
    assert.equal(afterLast.history.length, 2);
    assert.equal(afterLast.history[0].note, undefined);
    assert.equal(afterLast.history[1].note, note);

    await f.repo.claim(await f.request('performance', null, { action: 'undo', targetClaimId: first.claimId, reason: 'Wrong party' }), actor);
    const corrected = await f.allowance('performance');
    assert.equal(corrected.remaining.presto, 2);
    assert.equal(corrected.history[0].reason, 'Wrong party');
    assert.equal(corrected.history[0].note, undefined);
    assert.equal(corrected.history.find(item => item.id === first.claimId).note, note);
});

test('REDEMPTION: invalid notes cannot change claim history or remaining quantities', async () => {
    const f = setup();
    const request = await f.request('performance', { presto: 1 });
    for (const note of [null, 42, { text: 'Note' }, 'a'.repeat(501)]) {
        await assert.rejects(f.repo.claim({ ...request, note }, actor), /at most 500 characters/);
    }
    const current = await f.allowance('performance');
    assert.equal(current.remaining.presto, 3);
    assert.equal(current.history.length, 0);
});

test('PERFORMER ATTENDANCE: individual roster members without paid bookings can be marked present once', async () => {
    const f = setup();
    const attendance = f.load('src/repositories/PerformerAttendanceRepository.js');
    const eventId = input.eventId;
    f.seed('Registrants2025/duet', { eventId, name: 'Parent Name', willAttend: false,
        performers: [{ fullName: 'Alice Example' }, { firstName: 'Ben', lastName: 'Example' }] });
    f.seed('Registrants2025/winner', { eventId, performers: ['Paid Student'] });
    f.seed('Registrants2025/guest', { eventId: 'APCS2025', performers: ['Other Event'] });
    f.seed('publicBookings/pending', { eventId, registrantId: 'duet', paymentStatus: 'pending' });
    const { performers } = await attendance.candidates({ eventId });
    assert.deepEqual(Array.from(performers, person => person.name), ['Alice Example', 'Ben Example']);
    const request = { eventId, registrantId: 'duet', performerId: performers[0].id };
    const before = businessState(f);
    const first = (await attendance.markPresent(request, actor)).attendance;
    assert.equal(first.name, 'Alice Example');
    assert.equal(first.actorEmail, actor.email);
    assert.ok(first.markedAt > 0);
    assert.deepEqual(businessState(f), before);
    const replay = await attendance.markPresent(request, { uid: 'different', email: 'different@example.invalid' });
    assert.deepEqual(replay.attendance, first);
    assert.deepEqual(Array.from((await attendance.candidates({ eventId })).performers, person => person.name), ['Ben Example']);
    assert.equal((await attendance.list({ eventId, search: 'alice' })).attendance.length, 1);
    assert.equal((await attendance.list({ eventId, search: 'ben' })).attendance.length, 0);
    assert.equal((await attendance.list({ eventId: 'APCS2025' })).attendance.length, 0);

    f.records.get('publicBookings/pending').paymentStatus = 'paid';
    await assert.rejects(attendance.markPresent({ ...request, performerId: performers[1].id }, actor), /now has a paid booking/);
    await assert.rejects(attendance.markPresent({ ...request, performerId: 'a'.repeat(64) }, actor), /no longer available/);
    await assert.rejects(attendance.markPresent(request, {}), /administrator/);
    assert.equal((await attendance.list({ eventId })).attendance.length, 1);
});

test('PERFORMER ATTENDANCE: roster search continues after a page with no matches', async () => {
    const f = setup();
    const attendance = f.load('src/repositories/PerformerAttendanceRepository.js');
    const eventId = input.eventId;
    for (let index = 0; index < 25; index += 1) {
        f.seed(`Registrants2025/early-${index}`, { eventId, performers: ['Other Student'] });
    }
    f.seed('Registrants2025/late', { eventId, performers: ['Late Student'] });
    const query = { eventId, search: 'late student' };
    const first = await attendance.candidates(query);
    assert.equal(first.performers.length, 0);
    assert.ok(first.nextCursor);
    const second = await attendance.candidates({ ...query, cursor: first.nextCursor });
    assert.deepEqual(Array.from(second.performers, person => person.name), ['Late Student']);
    assert.equal(second.nextCursor, null);
});

test('REDEMPTION: zero, negative, fractional, excess and forged tier quantities are rejected atomically', async () => {
    for (const quantities of [{ presto: 0 }, { presto: -1 }, { presto: 0.5 }, { presto: 4 }, { evil: 1 }]) {
        const f = setup();
        await assert.rejects(f.repo.claim(await f.request('performance', quantities), actor));
        assert.equal([...f.records.keys()].filter(key => key.startsWith('ticketRedemptions/')).length, 0);
    }
    const f = setup();
    await assert.rejects(f.repo.claim(await f.request('performance', { presto: 1 }, { sessionKey: 'wrong' }), actor), /session changed/);
    await assert.rejects(f.repo.claim(await f.request('performance', { presto: 1 }), {}), /administrator/);
});

test('REDEMPTION: undo restores only the selected claim with an audited reason and cannot repeat', async () => {
    const f = setup();
    const first = await f.repo.claim(await f.request('performance', { presto: 2, allegro: 1 }), actor);
    await f.repo.claim(await f.request('performance', { allegro: 1 }), actor);
    const undo = await f.request('performance', null, { action: 'undo', targetClaimId: first.claimId, reason: 'Wrong party at desk.' });
    await f.repo.claim(undo, actor);
    assert.equal((await f.repo.claim(undo, actor)).replayed, true);
    const allowance = await f.allowance('performance');
    assert.equal(allowance.remaining.presto, 3); assert.equal(allowance.remaining.allegro, 1);
    assert.equal(allowance.history[0].reason, 'Wrong party at desk.');
    await assert.rejects(f.repo.claim(await f.request('performance', null, { action: 'undo', targetClaimId: first.claimId, reason: 'Again' }), actor), /already been undone/);
});

test('REDEMPTION: replay of an undone claim cannot authorize a handover after its correction', async () => {
    const f = setup();
    const original = await f.request('orchestra', { orchestra: 2 });
    const claimed = await f.repo.claim(original, actor);
    await f.repo.claim(await f.request('orchestra', null, { action: 'undo', targetClaimId: claimed.claimId, reason: 'Issued to wrong party.' }), actor);
    await assert.rejects(f.repo.claim(original, actor), /has been undone/);
    assert.equal((await f.allowance('orchestra')).remaining.orchestra, 5);
});

test('REDEMPTION: orchestra reassignment is blocked after redemption and allowed after correction', async () => {
    const f = setup();
    const orchestra = f.load('src/repositories/OrchestraAssignmentRepository.js');
    f.records.get('Registrants2025/winner').performers = [{}, {}, {}];
    const group = { eventId: input.eventId, registrantId: 'winner', sessionId: 'orch' };
    await orchestra.assignGroup(group, actor);
    f.records.get('events/APCS2026').orchestraSessions.push({ id: 'orch2', venue: 'V1', date: '2026-11-02', time: '18:00-19:00' });
    const claimed = await f.repo.claim(await f.request('performers', { performers: 1 }), actor);
    await assert.rejects(orchestra.assignGroup({ ...group, sessionId: 'orch2' }, actor), /already been redeemed/);
    await f.repo.claim(await f.request('performers', null, { action: 'undo', targetClaimId: claimed.claimId, reason: 'Changing session before handover.' }), actor);
    await orchestra.assignGroup({ ...group, sessionId: 'orch2' }, actor);
    await f.repo.claim(await f.request('performers', { performers: 3 }), actor);
    assert.equal((await f.allowance('performers')).remaining.performers, 0);
});

test('REDEMPTION: historical complimentary tickets use their saved session without granting v2 performer places', async () => {
    const f = setup();
    Object.assign(f.records.get('publicBookings/order-1'), { ticketingVersion: 1, complimentaryTickets: 2, orchestraSessionId: 'orch' });
    assert.equal((await f.repo.detail(input)).allowances.length, 2);
    await f.repo.claim(await f.request('orchestra', { orchestra: 2 }), actor);
    assert.equal((await f.allowance('orchestra')).remaining.orchestra, 0);
});

test('REDEMPTION: search finds later pages, respects event and excludes archived records', async () => {
    const f = setup();
    for (let index = 0; index < 520; index++) f.seed(`publicBookings/b-${String(index).padStart(4, '0')}`, {
        ...f.records.get('publicBookings/order-1'), buyerName: index === 510 ? 'Late Buyer' : 'Someone Else' });
    f.seed('publicBookings/foreign', { ...f.records.get('publicBookings/order-1'), eventId: 'APCS2025', buyerName: 'Late Buyer' });
    const first = await f.repo.list({ eventId: input.eventId, search: 'late buyer' });
    assert.equal(first.bookings.length, 0); assert.ok(first.nextCursor); assert.equal(first.scanned, 500);
    const second = await f.repo.list({ eventId: input.eventId, search: 'late buyer', cursor: first.nextCursor });
    assert.equal(second.bookings.length, 1); assert.equal(second.bookings[0].id, 'b-0510'); assert.equal(second.nextCursor, null);
    f.records.get('publicBookings/b-0510').paymentStatus = 'archived_test';
    assert.equal((await f.repo.list({ eventId: input.eventId, search: 'late buyer', cursor: first.nextCursor })).bookings.length, 0);
});

test('REDEMPTION: every API route uses admin middleware; fallback rules cannot authorize client writes', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    for (const action of ['list', 'detail', 'claim']) assert.ok(routes.includes(`'/public-ticket/admin/redemption/${action}', requireTicketingAdmin, TicketRedemptionController.${action}`));
    const rules = fs.readFileSync(path.join(__dirname, '../../apcs_web/firestore.rules'), 'utf8');
    assert.match(rules, /match \/ticketRedemptions\/\{document=\*\*\}[^}]*allow write: if false/);
    assert.ok(rules.includes("collection != 'ticketRedemptions'"));
});


test('REDEMPTION: without any configured orchestra sessions, shared places remain once per paid winner group', async () => {
    const f = setup();
    f.records.delete('orchestraAssignments/APCS2026%7Cwinner');
    f.records.get('events/APCS2026').orchestraSessions = [];
    f.seed('publicBookings/order-2', { ...f.records.get('publicBookings/order-1'), bookingType: 'public_competition', performerCount: 0 });
    await f.repo.claim(await f.request('performers', { performers: 2 }), actor);
    assert.equal((await f.allowance('performers', 'order-2')).remaining.performers, 1);
    await f.repo.claim(await f.request('performers', { performers: 1 }, { bookingId: 'order-2' }), actor);
    await assert.rejects(f.repo.claim(await f.request('performers', { performers: 1 }), actor), /exceeds/);
    await f.repo.claim(await f.request('orchestra', { orchestra: 5 }), actor);
    await assert.rejects(f.repo.claim(await f.request('orchestra', { orchestra: 1 }), actor), /exceeds/);
});

test('REDEMPTION: first assignment preserves sessionless claims, replay and corrections', async () => {
    const f = setup();
    f.records.delete('orchestraAssignments/APCS2026%7Cwinner');
    f.records.get('events/APCS2026').orchestraSessions[0].freeSeatingAssigned = 0;
    const request = await f.request('orchestra', { orchestra: 2 });
    const original = await f.repo.claim(request, actor);
    await f.repo.claim(await f.request('performers', { performers: 1 }), actor);
    const before = JSON.stringify([...f.records].filter(([key]) => key.startsWith('ticketRedemptions/')));
    const orchestra = f.load('src/repositories/OrchestraAssignmentRepository.js');
    await orchestra.assignGroup({ eventId: input.eventId, registrantId: 'winner', sessionId: 'orch' }, actor);
    assert.equal(JSON.stringify([...f.records].filter(([key]) => key.startsWith('ticketRedemptions/'))), before);
    assert.equal((await f.allowance('orchestra')).remaining.orchestra, 3);
    assert.equal((await f.allowance('performers')).remaining.performers, 2);
    assert.equal((await f.repo.claim(request, actor)).replayed, true);
    await f.repo.claim(await f.request('orchestra', { orchestra: 1 }), actor);
    assert.equal((await f.repo.claim(request, actor)).replayed, true);
    await f.repo.claim(await f.request('orchestra', null, { action: 'undo', targetClaimId: original.claimId, reason: 'Correct original handover' }), actor);
    assert.equal((await f.allowance('orchestra')).remaining.orchestra, 4);
    assert.equal((await f.allowance('orchestra')).history.find(item => item.id === original.claimId).session, null);
    await assert.rejects(f.repo.claim(request, actor), /undone/);
    f.records.get('events/APCS2026').orchestraSessions.push({ id: 'orch2', venue: 'V1', date: '2026-11-02', time: '18:00-19:00' });
    await assert.rejects(orchestra.assignGroup({ eventId: input.eventId, registrantId: 'winner', sessionId: 'orch2' }, actor), /already been redeemed/);
});

test('REDEMPTION: public-only, unpaid winner and foreign winner cannot grant shared places via an assignment', async () => {
    for (const edit of [booking => { booking.bookingType = 'public_competition'; },
        booking => { booking.paymentStatus = 'pending'; }, booking => { booking.eventId = 'other'; }]) {
        const f = setup();
        f.seed('publicBookings/public-order', { ...f.records.get('publicBookings/order-1'), bookingType: 'public_competition', performerCount: 0 });
        edit(f.records.get('publicBookings/order-1'));
        assert.equal(await f.allowance('performers', 'public-order'), undefined);
        await assert.rejects(f.repo.claim({ ...input, bookingId: 'public-order', channel: 'performers', requestId: 'forged',
            expectedRevision: 0, sessionKey: '', quantities: { performers: 1 } }, actor), /no entitlement/);
    }
});

test('REDEMPTION: unpaid optional allowances, direct and historical missing sessions remain protected', async () => {
    for (const paymentStatus of ['pending', 'failed', 'expired']) {
        const f = setup();
        f.records.delete('orchestraAssignments/APCS2026%7Cwinner');
        f.seed('publicBookings/paid-winner', { ...f.records.get('publicBookings/order-1') });
        f.records.get('publicBookings/order-1').paymentStatus = paymentStatus;
        for (const channel of ['orchestra', 'performers']) {
            await assert.rejects(f.repo.claim(await f.request(channel, { [channel]: 1 }), actor), /Payment/);
        }
    }
    for (const changes of [{ bookingType: 'public_orchestra', isOrchestra: true, session: 'unknown' },
        { ticketingVersion: 1, complimentaryTickets: 2, orchestraSessionId: 'unknown' }]) {
        const f = setup(); Object.assign(f.records.get('publicBookings/order-1'), changes);
        const allowance = await f.allowance('orchestra');
        await assert.rejects(f.repo.claim(await f.request('orchestra', { [Object.keys(allowance.quantities)[0]]: 1 }), actor), /review/);
    }
});

test('REDEMPTION: assignment changes reject stale new submissions without resetting counts', async () => {
    const f = setup();
    f.records.delete('orchestraAssignments/APCS2026%7Cwinner');
    const stale = await f.request('orchestra', { orchestra: 1 });
    await f.load('src/repositories/OrchestraAssignmentRepository.js').assignGroup({ eventId: input.eventId, registrantId: 'winner', sessionId: 'orch' }, actor);
    await assert.rejects(f.repo.claim(stale, actor), /session changed/);
    await f.repo.claim(await f.request('orchestra', { orchestra: 1 }), actor);
    f.records.get('orchestraAssignments/APCS2026%7Cwinner').time = 'changed';
    assert.match((await f.allowance('orchestra')).blockedReason, /differ/);
});
