// Offline production-code regression tests; no provider, email or Firestore calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fixtureFile = path.join(__dirname, 'public-ticket.audit.cjs');
const fixtureSource = fs.readFileSync(fixtureFile, 'utf8').split("test('CONTROL:")[0].replace('return { records, seed, timestamp', 'return { db, records, seed, timestamp');
const context = { require, __dirname, module: { exports: {} } };
vm.runInNewContext(fixtureSource + '\nmodule.exports = fixture;', context, { filename: fixtureFile });
const fixture = context.module.exports;
const actor = { email: 'admin@example.invalid' };
const request = { eventId: 'APCS2026', registrantId: 'winner', sessionId: 'orch' };
const repo = f => f.load('src/repositories/OrchestraAssignmentRepository.js');
async function purchase(f, quantity, paid = true, extra = {}) {
    const result = await f.book({ registrantId: 'winner', tickets: [{ id: 'presto', name: 'Presto', quantity }], ...extra });
    assert.ifError(result.error);
    if (paid) await f.repo.handlePublicTicketWebhookPaid(result.result.bookingId, {
        invoice: { id: `invoice-${result.result.bookingId}`, total_amount: quantity * 150000 },
    });
    return result.result.bookingId;
}
function ensemble(f) {
    f.records.get('Registrants2025/winner').performers = [1, 2, 3, 4].map(index => ({ fullName: `Member ${index}` }));
}

test('ORCHESTRA: ensemble purchases 3 + 2 count all four members once = 9', async () => {
    const f = fixture(); ensemble(f);
    await purchase(f, 3); await purchase(f, 2);
    const group = await repo(f).readGroup('APCS2026', 'winner');
    assert.equal(group.paidTicketCount, 5); assert.equal(group.performerCount, 4); assert.equal(group.quantity, 9);
    const assigned = await repo(f).assignGroup(request, actor);
    assert.equal(assigned.assignment.quantity, 9);
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[0].freeSeatingAssigned, 9);
    assert.equal([...f.records.keys()].filter(key => key.startsWith('winnerOrchestraClaims/')).length, 0);
});

test('ORCHESTRA: five public competition tickets add five places; winner purchase adds performer roster once', async () => {
    const f = fixture();
    f.records.get('Registrants2025/winner').performers = [1, 2, 3].map(index => ({ fullName: `Member ${index}` }));
    const publicOrder = await f.book({
        bookingType: 'public_competition', registrantId: 'winner',
        tickets: [{ id: 'presto', name: 'Presto', quantity: 5 }],
    });
    assert.ifError(publicOrder.error);
    const publicBooking = f.records.get(`publicBookings/${publicOrder.result.bookingId}`);
    assert.equal(publicBooking.performerCount, 0);
    assert.equal(publicBooking.orchestraAttendanceTickets, 5);
    await f.repo.handlePublicTicketWebhookPaid(publicOrder.result.bookingId, {
        invoice: { id: publicBooking.invoiceId, total_amount: publicBooking.totalAmount },
    });
    const repository = repo(f);
    const publicOnly = await repository.readGroup('APCS2026', 'winner');
    assert.equal(publicOnly.publicTicketCount, 5);
    assert.equal(publicOnly.performerCount, 0);
    assert.equal(publicOnly.quantity, 5);
    await repository.assignGroup(request, actor);
    await purchase(f, 2);
    const mixed = await repository.readGroup('APCS2026', 'winner');
    assert.equal(mixed.publicTicketCount, 5);
    assert.equal(mixed.winnerTicketCount, 2);
    assert.equal(mixed.performerCount, 3);
    assert.equal(mixed.quantity, 10);
    const updated = await repository.assignGroup(request, actor);
    assert.equal(updated.assignment.quantity, 10);
    assert.equal(updated.assignment.bookingIds.length, 2);
});

test('ORCHESTRA: pending and failed purchases never consume performer places', async () => {
    const f = fixture(); ensemble(f);
    const pendingId = await purchase(f, 3, false);
    assert.equal((await repo(f).readGroup('APCS2026', 'winner')).quantity, 0);
    await f.load('src/repositories/PublicTicketFailureRepository.js').failPublicTicketBooking(pendingId, { reason: 'Cancelled' });
    await purchase(f, 2);
    assert.equal((await repo(f).readGroup('APCS2026', 'winner')).quantity, 6);
});

test('ORCHESTRA: solo repeats and duplicate paid callbacks count one performer', async () => {
    const f = fixture();
    const firstId = await purchase(f, 3); await purchase(f, 2);
    await f.repo.handlePublicTicketWebhookPaid(firstId, { invoice: { id: `invoice-${firstId}`, total_amount: 450000 } });
    assert.equal((await repo(f).readGroup('APCS2026', 'winner')).quantity, 6);
});

test('ORCHESTRA: paid group only; insufficient quota cannot cap or partially assign', async () => {
    const f = fixture(); ensemble(f);
    await purchase(f, 3, false);
    await assert.rejects(repo(f).assignGroup(request, actor), /Only paid/);
    await purchase(f, 2);
    f.records.get('events/APCS2026').orchestraSessions[0].complimentaryQuota = 5;
    await assert.rejects(repo(f).assignGroup(request, actor), /whole group/);
    assert.equal([...f.records.keys()].filter(key => key.startsWith('orchestraAssignments/')).length, 0);
});

test('ORCHESTRA: assignment retry is idempotent and reassign releases the old count once', async () => {
    const f = fixture();
    await purchase(f, 3);
    const repository = repo(f);
    const first = await repository.assignGroup(request, actor);
    const repeated = await repository.assignGroup(request, actor);
    assert.equal(repeated.assignment.revision, first.assignment.revision);
    f.records.get('events/APCS2026').orchestraSessions.push({ id: 'orch2', venue: 'V1', date: '2026-11-02', time: '18:00-19:00', complimentaryQuota: 8 });
    await repository.assignGroup({ ...request, sessionId: 'orch2' }, actor);
    const sessions = f.records.get('events/APCS2026').orchestraSessions;
    assert.equal(sessions[0].freeSeatingAssigned, 0); assert.equal(sessions[1].freeSeatingAssigned, 4);
    await repository.assignGroup({ ...request, sessionId: 'orch2' }, actor);
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[1].freeSeatingAssigned, 4);
});

test('ORCHESTRA: later purchases leave confirmed places intact and require the additional count', async () => {
    const f = fixture(); ensemble(f);
    const firstId = await purchase(f, 3);
    const repository = repo(f);
    const first = await repository.assignGroup(request, actor);
    await repository.markNotified(first.id, first.assignment.revision, firstId);
    const secondId = await purchase(f, 2);
    const before = await repository.readGroup('APCS2026', 'winner');
    assert.equal(before.quantity, 9); assert.equal(before.assignment.quantity, 7);
    assert.ok(!before.assignment.bookingIds.includes(secondId));
    const after = await repository.assignGroup(request, actor);
    assert.equal(after.assignment.quantity, 9);
    assert.equal(after.assignment.notifiedBookingIds.length, 0);
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[0].freeSeatingAssigned, 9);
    await repository.markNotified(after.id, first.assignment.revision, firstId);
    assert.equal((await repository.readGroup('APCS2026', 'winner')).assignment.notifiedBookingIds.length, 0, 'Stale email acknowledgement cannot confirm a newer assignment');
});

test('ORCHESTRA: distinct winners share transactional session quota', async () => {
    const f = fixture();
    await purchase(f, 3); await repo(f).assignGroup(request, actor);
    f.seed('Registrants2025/winner2', { eventId: 'APCS2026', performers: [{}], finalAward: 'Gold' });
    f.records.get('sessionAssignments/APCS2026').assignments['V1_2026-11-01_09:00-10:00'].push({ registrantId: 'winner2' });
    await purchase(f, 6, true, { registrantId: 'winner2' });
    await assert.rejects(repo(f).assignGroup({ ...request, registrantId: 'winner2' }, actor), /whole group/);
    assert.equal(f.records.get('events/APCS2026').orchestraSessions[0].freeSeatingAssigned, 4);
});

test('ORCHESTRA: legacy allocations are preserved and block accidental duplicate assignment', async () => {
    const f = fixture(); await purchase(f, 2);
    f.seed('publicBookings/legacy', { eventId: 'APCS2026', registrantId: 'winner', paymentStatus: 'PAID', complimentaryTickets: 3, orchestraSessionId: 'orch' });
    await assert.rejects(repo(f).assignGroup(request, actor), /legacy/);
    assert.equal(f.records.get('publicBookings/legacy').complimentaryTickets, 3);
});

test('ORCHESTRA: forged retired products and seat selections fail before invoicing', async () => {
    for (const extra of [{ orchestraSessionId: 'orch' }, { orchestraSelectedSeatIds: ['free-seat'] }, { addOnIds: ['allegro_masterclass'] }, { addOnIds: ['seat_selection'] }, { tickets: [{ id: 'masterclass', quantity: 1 }] }]) {
        const f = fixture();
        assert.ok((await f.book({ registrantId: 'winner', ...extra })).error);
        assert.equal(f.invoices.length, 0);
    }
    const f = fixture();
    const event = f.records.get('events/APCS2026');
    event.venues[0].sessions['2026-11-01'].push('19:00-20:00');
    for (const extra of [{ selectedSeatIds: ['seat'] }, { addOnIds: ['seat_selection_performer'] }, { tickets: [{ id: 'lento', quantity: 1 }] }]) {
        assert.ok((await f.book({ session: '19:00-20:00', ...extra })).error);
    }
});

test('ORCHESTRA: Presto has no new Masterclass benefit or invoice line', async () => {
    const f = fixture(); const id = await purchase(f, 2, false);
    assert.equal(f.records.get(`publicBookings/${id}`).freeMasterclassCount, 0);
    assert.ok(!JSON.stringify(f.invoices).includes('Free Master'));
    assert.equal(f.records.get(`publicBookings/${id}`).venueName, 'Hall 1');
});

test('ORCHESTRA: settings reject quota below assignments and deletion of active sessions', async () => {
    const f = fixture(); await purchase(f, 3); await repo(f).assignGroup(request, actor);
    const event = f.records.get('events/APCS2026'); event.venues[0].sessions['2026-11-01'].push('19:00-20:00');
    const repository = repo(f);
    await assert.rejects(repository.saveSession({ eventId: 'APCS2026', session: { ...event.orchestraSessions[0], complimentaryQuota: 3 } }), /quota/);
    await assert.rejects(repository.saveSession({ eventId: 'APCS2026', deleteSessionId: 'orch' }), /cannot be deleted/);
    const saved = await repository.saveSession({ eventId: 'APCS2026', session: { ...event.orchestraSessions[0], complimentaryQuota: 5 } });
    assert.equal(saved.freeSeatingAssigned, 4);
    assert.equal(saved.complimentaryQuota, 5);
    assert.equal([...f.records.keys()].filter(key => key.startsWith('seats')).length, 0);
});

test('ORCHESTRA: settings cannot convert a competition with performer assignments', async () => {
    const f = fixture();
    await assert.rejects(repo(f).saveSession({ eventId: 'APCS2026', session: { venue: 'V1', date: '2026-11-01', time: '09:00-10:00', complimentaryQuota: 5 } }), /competition performers/);
});

test('ORCHESTRA: public free seating retains tier and overall capacity without numbered seats', async () => {
    const f = fixture(); const event = f.records.get('events/APCS2026');
    event.venues[0].seatConfig.push({ row: 'C', seatCount: 5, areaType: 'allegro' });
    event.ticketTiers.push({ id: 'allegro', name: 'Allegro', venuePrices: { V1: 100000 } });
    event.venues[0].sessions['2026-11-01'].push('19:00-20:00');
    const first = await f.book({ session: '19:00-20:00', tickets: [{ id: 'presto', quantity: 10 }, { id: 'allegro', quantity: 5 }] });
    assert.ifError(first.error);
    const booking = f.records.get(`publicBookings/${first.result.bookingId}`);
    assert.equal(booking.selectedSeatIds.length, 0); assert.equal(booking.seatingMode, 'free');
    assert.ok((await f.book({ session: '19:00-20:00' })).error);
    await assert.rejects(repo(f).saveSession({ eventId: 'APCS2026', session: { ...event.orchestraSessions[0], complimentaryQuota: 11 } }), /capacity/);
});

test('ORCHESTRA: email shows pending or named venue/session, group count and escaped names', () => {
    const { attendanceHtml, assignmentEmail } = require('../src/services/OrchestraEmailDetails');
    const booking = { id: 'b1', ticketingVersion: 2, registrantId: 'winner', orchestraAttendanceTickets: 3, tickets: [{ quantity: 3 }], buyerName: '<script>', registrantName: 'Ensemble' };
    assert.match(attendanceHtml(booking, null), /assignment pending/);
    const assignment = { bookingIds: ['b1'], venueName: 'Titan Theatre', date: '2026-11-15', time: '15:30-17:30', paidTicketCount: 5, performerCount: 4, quantity: 9 };
    const html = assignmentEmail(booking, assignment);
    assert.match(html, /Titan Theatre/); assert.match(html, /2026-11-15/); assert.match(html, /9 attendees/); assert.match(html, /&lt;script&gt;/);
    assert.match(html, /<!DOCTYPE html>/);
    assert.match(html, /class="email-container"/);
    assert.match(html, /alt="APCS Logo"/);
    assert.match(html, /class="footer"/);
    assert.match(html, new RegExp(`&copy; ${new Date().getFullYear()} APCS Music`));
    assert.doesNotMatch(html, /Orkestra|Pesanan|Penampil|Tunjukkan|Tempat duduk/);
    assert.match(html, /Assignment reference: event/);
    assert.match(attendanceHtml({ ...booking, id: 'new-booking' }, assignment), /assignment pending/);
    assert.match(attendanceHtml({ ...booking, seatingMode: 'free' }, null), /No numbered seat/);
});

test('ORCHESTRA: every new admin endpoint enforces whitelist authentication', () => {
    const routes = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    for (const action of ['list', 'assign', 'notify', 'session', 'sessions']) assert.ok(routes.includes(`'/public-ticket/admin/orchestra/${action}', requireTicketingAdmin,`));
    for (const action of ['release-booking', 'mark-manual-paid', 'resend-manual-instructions']) {
        assert.ok(routes.includes(`'/public-ticket/admin/${action}', requireTicketingAdmin,`));
    }
});

test('ORCHESTRA: paginated discovery still counts all paid purchases for each visible winner', async () => {
    const f = fixture(); ensemble(f); await purchase(f, 3); await purchase(f, 2);
    for (let i = 0; i < 26; i++) f.seed(`publicBookings/public-${i}`, { eventId: 'APCS2026', paymentStatus: 'PAID', tickets: [{ quantity: 1 }] });
    const first = await repo(f).listGroups({ eventId: 'APCS2026' });
    assert.equal(first.groups.length, 1); assert.equal(first.groups[0].quantity, 9); assert.ok(first.nextCursor);
    const second = await repo(f).listGroups({ eventId: 'APCS2026', cursor: first.nextCursor });
    assert.equal(second.nextCursor, null);
});

test('ORCHESTRA: overview separates paid attendance, pending holds and legacy quota', async () => {
    const f = fixture(); await purchase(f, 2); await repo(f).assignGroup(request, actor);
    const event = f.records.get('events/APCS2026'); event.venues[0].sessions['2026-11-01'].push('19:00-20:00');
    const paid = await f.book({ session: '19:00-20:00', tickets: [{ id: 'presto', quantity: 2 }] });
    assert.ifError(paid.error);
    await f.repo.handlePublicTicketWebhookPaid(paid.result.bookingId, { invoice: { id: `invoice-${paid.result.bookingId}`, total_amount: 300000 } });
    assert.ifError((await f.book({ session: '19:00-20:00' })).error);
    const overview = await repo(f).sessionOverview({ eventId: 'APCS2026' });
    assert.equal(overview.orchestraSessions[0].confirmedAttendance, 5);
    assert.equal(overview.orchestraSessions[0].paidPublicCount, 2);
    assert.equal(overview.orchestraSessions[0].heldPublicCount, 1);
});

test('ORCHESTRA: notification failure keeps assignment and retry sends only missing emails', async () => {
    const f = fixture(); const firstId = await purchase(f, 2); const secondId = await purchase(f, 1);
    const repository = repo(f); const sent = []; let failEmail = true;
    const controllerContext = { module: { exports: {} }, require: name => {
        if (name.endsWith('/OrchestraAssignmentRepository')) return repository;
        if (name.endsWith('/firebase-init')) return { db: f.db };
        if (name.endsWith('/EmailService')) return { sendOrchestraAssignmentEmail: async booking => {
            if (booking.id === secondId && failEmail) throw new Error('SMTP unavailable');
            sent.push(booking.id);
        } };
        throw new Error(`Unexpected dependency: ${name}`);
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/controllers/OrchestraAssignmentController.js'), 'utf8'), controllerContext);
    const controller = controllerContext.module.exports;
    let response; const res = { json: value => { response = value; } }; const next = error => { throw error; };
    await controller.assign({ body: request, ticketingAdmin: actor }, res, next);
    assert.equal(response.assignment.quantity, 4); assert.equal(response.failedNotifications.length, 1);
    assert.deepEqual(sent, [firstId]);
    failEmail = false;
    await controller.notify({ body: request }, res, next);
    assert.equal(response.failedNotifications.length, 0); assert.deepEqual(sent, [firstId, secondId]);
    await controller.notify({ body: request }, res, next);
    assert.deepEqual(sent, [firstId, secondId], 'Successful deliveries are not re-sent by Retry email');
});

test('ORCHESTRA: notification lease blocks simultaneous sends and reassignment while sending', async () => {
    const f = fixture(); const id = await purchase(f, 1); const repository = repo(f);
    const group = await repository.assignGroup(request, actor);
    const token = await repository.claimNotification(group.id, group.assignment.revision, id);
    assert.ok(token);
    await assert.rejects(repository.claimNotification(group.id, group.assignment.revision, id), /already being sent/);
    await assert.rejects(repository.assignGroup(request, actor), /emails are being sent/);
    await repository.markNotified(group.id, group.assignment.revision, id, token);
    assert.equal(await repository.claimNotification(group.id, group.assignment.revision, id), null);
});

test('ORCHESTRA: actual payment email resolves the booking event and preserves its saved venue', async () => {
    const f = fixture(); f.seed('events/APCS2027', { venues: [{ id: 'V1', label: 'Wrong venue' }] });
    f.seed('systemSettings/global', { currentEventId: 'APCS2027' });
    const source = fs.readFileSync(path.join(__dirname, '../src/services/EmailService.js'), 'utf8');
    const start = source.indexOf('async function sendPublicBookingConfirmationEmail(');
    const end = source.indexOf('async function sendJuryDeadlineReminderEmail(', start);
    const details = require('../src/services/OrchestraEmailDetails'); let templateData;
    const emailContext = { require: () => ({ db: f.db }), Intl, escapeTicketHtml: details.escapeHtml, attendanceHtml: details.attendanceHtml,
        getTemplate: (_, data) => { templateData = data; return 'html'; }, transporter: { sendMail: async () => {} }, logger: { info: () => {} } };
    vm.runInNewContext(source.slice(start, end), emailContext);
    const booking = { id: 'email-test', eventId: 'APCS2026', venue: 'V1', tickets: [{ name: 'Presto', quantity: 1 }], totalAmount: 150000 };
    await emailContext.sendPublicBookingConfirmationEmail(booking);
    assert.equal(templateData.venueName, 'Hall 1');
    await emailContext.sendPublicBookingConfirmationEmail({ ...booking, venueName: 'Behring Theatre', ticketingVersion: 2, registrantId: 'winner', orchestraAttendanceTickets: 1 });
    assert.equal(templateData.venueName, 'Behring Theatre'); assert.match(templateData.attendanceDetails, /assignment pending/);
});
