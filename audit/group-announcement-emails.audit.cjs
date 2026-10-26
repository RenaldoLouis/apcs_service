const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createService, announcementMessage, DUMMY_EMAIL } = require('../src/services/GroupAnnouncementEmailService');
const { memoryDb } = require('./helpers/group-email-memory-db.cjs');

function fixture(status = 'published', send, options = {}) {
    const slot = 'V_2026-11-14_10:00-11:00';
    const records = new Map([
        ['events/APCS2026', { competitionScheduleState: { status }, venues: [
            { id: 'V', label: 'Main Hall', sessions: { '2026-11-14': ['10:00-11:00'] } },
        ] }],
        ['sessionAssignments/APCS2026', { assignments: { [slot]: [
            { registrantId: 'R1', sourceEventId: 'APCS2026' },
            { registrantId: 'R1', sourceEventId: 'APCS2026' },
            { registrantId: 'R2', sourceEventId: 'APCS2026' },
        ], old_slot: [{ registrantId: 'UNASSIGNED' }] } }],
        ['Registrants2025/R1', { eventId: 'APCS2026', email: 'parent@example.com', performers: [
            { fullName: 'Alice', email: 'shared@example.com' }, { fullName: 'Bob', email: 'SHARED@example.com' },
            { fullName: 'Carol', email: 'carol@example.com' },
        ] }],
        ['Registrants2025/R2', { eventId: 'APCS2026', performers: [{ fullName: 'Dan', email: 'shared@example.com' }] }],
    ]);
    const { reads, db } = memoryDb(records);
    const messages = [];
    const service = createService({ db, sendMail: async mail => {
        messages.push(mail);
        return send ? send(mail) : { accepted: [mail.to], rejected: [] };
    }, ...options });
    return { db, records, reads, messages, service, slot };
}

test('preview uses saved published membership and current performer contacts, without sending or writes', async () => {
    const f = fixture();
    const result = await f.service.preview({ eventId: 'APCS2026', recipients: [{ email: 'injected@example.com' }] });
    assert.equal(result.resendRecipientOverrideEnabled, true);
    assert.equal(result.recipients.length, 3);
    assert.equal(result.recipients[0].name, 'Alice, Bob');
    assert.equal(result.recipients[2].name, 'Dan');
    assert.ok(result.recipients[0].groups[0].includes('WIB'));
    assert.equal(f.reads.filter(key => key === 'Registrants2025/R1').length, 1);
    assert.ok(!f.reads.includes('Registrants2025/UNASSIGNED'));
    assert.equal(result.bulkEnabled, false);
    assert.equal(f.messages.length, 0);
});

test('attendance totals count each grouped registration once, without filtering recipients or changing data', async () => {
    const f = fixture();
    f.records.get('Registrants2025/R1').willAttend = false;
    f.records.get('Registrants2025/R2').willAttend = true;
    const before = structuredClone(f.records);
    const result = await f.service.preview({ eventId: 'APCS2026' });
    assert.deepEqual(result.attendanceSummary, { total: 2, attending: 1, notAttending: 1, notImported: 0, unavailable: 0 });
    assert.equal(result.recipients.length, 3);
    assert.equal(f.reads.filter(key => key === 'Registrants2025/R1').length, 1);
    assert.deepEqual(f.records, before);
    f.records.get('Registrants2025/R1').willAttend = true;
    const refreshed = await f.service.preview({ eventId: 'APCS2026' });
    assert.equal(refreshed.attendanceSummary.notAttending, 0);
    assert.equal(refreshed.recipientsHash, result.recipientsHash);
});

test('unknown attendance and unavailable registrations are separate from explicitly not attending', async () => {
    const f = fixture();
    f.records.get('Registrants2025/R1').willAttend = 'false';
    let result = await f.service.preview({ eventId: 'APCS2026' });
    assert.deepEqual(result.attendanceSummary, { total: 2, attending: 0, notAttending: 0, notImported: 2, unavailable: 0 });
    f.records.delete('Registrants2025/R2');
    result = await f.service.preview({ eventId: 'APCS2026' });
    assert.deepEqual(result.attendanceSummary, { total: 2, attending: 0, notAttending: 0, notImported: 1, unavailable: 1 });
});

test('attendance includes valid invited guests, with unsupported sources marked unavailable', async () => {
    const f = fixture();
    f.records.get('Registrants2025/R2').eventId = 'APCS2025';
    f.records.get('Registrants2025/R2').willAttend = false;
    f.records.get('sessionAssignments/APCS2026').assignments[f.slot][2].sourceEventId = 'APCS2025';
    assert.equal((await f.service.preview({ eventId: 'APCS2026' })).attendanceSummary.notAttending, 1);
    f.records.get('Registrants2025/R2').eventId = 'OTHER';
    const result = await f.service.preview({ eventId: 'APCS2026' });
    assert.equal(result.attendanceSummary.unavailable, 1);
    assert.equal(result.attendanceSummary.notAttending, 0);
});

for (const status of ['draft', 'resetting', 'unknown']) test(`${status} schedule has no eligible published recipients`, async () => {
    const f = fixture(status);
    const result = await f.service.preview({ eventId: 'APCS2026' });
    assert.deepEqual(result.recipients, []);
    assert.ok(f.reads.every(key => !key.startsWith('Registrants2025/')));
});

test('ready schedule remains eligible; reset in progress excludes all contacts', async () => {
    const f = fixture('ready');
    assert.equal((await f.service.preview({ eventId: 'APCS2026' })).recipients.length, 3);
    f.records.get('events/APCS2026').competitionScheduleState.resetInProgress = true;
    assert.equal((await f.service.preview({ eventId: 'APCS2026' })).recipients.length, 0);
});

test('attendance-only exclusion markers override inconsistent saved performance entries', async () => {
    const f = fixture();
    f.records.get('sessionAssignments/APCS2026').attendanceOnlyRegistrantIds = ['R2'];
    const result = await f.service.preview({ eventId: 'APCS2026' });
    assert.equal(result.recipients.length, 2);
    assert.ok(!f.reads.includes('Registrants2025/R2'));
});

test('missing registration, invalid contacts and unsupported source event are reported without parent fallback', async () => {
    const f = fixture();
    f.records.delete('Registrants2025/R2');
    f.records.get('Registrants2025/R1').performers = [{ fullName: 'Alice', email: 'bad\r\nBcc:other@example.com' }];
    let result = await f.service.preview({ eventId: 'APCS2026' });
    assert.equal(result.recipients.length, 0);
    assert.equal(result.skipped.length, 2);
    f.records.get('Registrants2025/R1').eventId = 'OTHER';
    result = await f.service.preview({ eventId: 'APCS2026' });
    assert.match(result.skipped[0].reason, /source event mismatch/);
});

test('APCS2025 guests require explicit saved projection provenance for APCS2026', async () => {
    const f = fixture();
    f.records.get('Registrants2025/R2').eventId = 'APCS2025';
    assert.equal((await f.service.preview({ eventId: 'APCS2026' })).recipients.length, 2);
    f.records.get('sessionAssignments/APCS2026').assignments[f.slot][2].sourceEventId = 'APCS2025';
    assert.equal((await f.service.preview({ eventId: 'APCS2026' })).recipients.length, 3);
});

test('legacy published session assignments remain supported', async () => {
    const f = fixture();
    delete f.records.get('events/APCS2026').competitionScheduleState;
    assert.equal((await f.service.preview({ eventId: 'APCS2026' })).recipients.length, 3);
});

test('dummy uses only the fixed owner mailbox, ignores injected recipients and attaches exactly the supplied PDF', async () => {
    const f = fixture('draft');
    const response = await f.service.test({ eventId: 'APCS2026', recipientEmail: 'staff@example.com' });
    assert.equal(response.accepted, true);
    assert.ok(f.reads.every(key => !key.startsWith('Registrants2025/')));
    const mail = f.messages[0];
    assert.equal(mail.to, 'renaldolouis555@gmail.com');
    assert.equal(response.recipientEmail, DUMMY_EMAIL);
    assert.match(mail.html, /Dear <strong>Alex Example<\/strong>,/);
    assert.match(mail.html, /apcs_logo_white_background_black/);
    assert.match(mail.html, /class="footer"/);
    assert.equal(mail.subject, 'APCS The Sound of Asia 2026 – Finale Orchestra Rundown');
    assert.equal(mail.attachments.length, 1);
    assert.equal(mail.attachments[0].content.subarray(0, 5).toString(), '%PDF-');
    assert.equal(mail.attachments[0].filename, 'RUNDOWN APCS THE SOUND OF ASIA 2026 - FINALE ORCHESTRA.pdf');
    assert.deepEqual(mail.attachments[0].content,
        fs.readFileSync(path.join(__dirname, '../src/services/attachments/RUNDOWN APCS THE SOUND OF ASIA 2026 - FINALE ORCHESTRA.pdf')));
});

test('invalid or wrong-year events and SMTP rejection do not report successful delivery', async () => {
    const f = fixture();
    await assert.rejects(f.service.preview({ eventId: '../APCS2026' }), /valid event/);
    await assert.rejects(f.service.preview({ eventId: 'APCS2025' }), /only for APCS2026/);
    f.records.delete('events/APCS2026');
    await assert.rejects(f.service.preview({ eventId: 'APCS2026' }), /Event not found/);
    assert.equal(f.messages.length, 0);
    const rejected = fixture('published', () => ({ accepted: [], rejected: ['staff@example.com'] }));
    await assert.rejects(rejected.service.test({ eventId: 'APCS2026', recipientEmail: 'staff@example.com' }), /not confirmed/);
    const failed = fixture('published', () => { throw new Error('SMTP failure'); });
    await assert.rejects(failed.service.test({ eventId: 'APCS2026', recipientEmail: 'staff@example.com' }), /SMTP failure/);
});

test('the new approved rundown still requires its own dummy receipt despite forged client approval fields', async () => {
    const f = fixture('published', null, { workerEnabled: true });
    const { hash } = require('../src/services/GroupAnnouncementCampaignService');
    const { TEST_ONLY_SHA256 } = require('../src/services/GroupAnnouncementEmailService');
    const oldRevision = hash({ template: announcementMessage('[Performer Name]'), filename: 'Program Notes - Fixed.pdf',
        sha256: TEST_ONLY_SHA256, approvedForBulk: false });
    await f.service.campaigns.recordDummy('APCS2026', { revision: oldRevision, approvedForBulk: false }, { uid: 'staff' });
    const preview = await f.service.preview({ eventId: 'APCS2026' });
    assert.notEqual(preview.revision, oldRevision);
    assert.equal(preview.attachment.testOnly, false);
    assert.equal(preview.dummyAccepted, false);
    assert.equal(preview.bulkEnabled, false);
    await assert.rejects(f.service.send({ eventId: 'APCS2026', confirmed: true, bulkEnabled: true,
        revision: preview.revision, expectedRecipientsHash: preview.recipientsHash,
        approvedForBulk: true, dummyAccepted: true }, { uid: 'staff' }), /successful dummy/);
    assert.equal(f.messages.length, 0);
});

test('template preserves exact requested text and APCS branding while escaping personalization', () => {
    const message = announcementMessage('[Performer Name]');
    assert.equal(message.text, 'Dear [Performer Name],\n\nThank you for confirming your participation in the APCS Stage!\n\nPlease find attached the rundown for APCS The Sound of Asia 2026 – Finale Orchestra, taking place on 14–15 November 2026 at Titan Center, Bintaro.\n\nWe look forward to welcoming you and celebrating your achievements at the APCS Gala Concert 2026!\n\nBest regards,\nAPCS Team');
    assert.match(announcementMessage('<script>').html, /Dear <strong>&lt;script&gt;<\/strong>,/);
    assert.ok(message.html.includes('<strong>14–15 November 2026</strong> at <strong>Titan Center, Bintaro</strong>.'));
    assert.ok(message.html.includes('Best regards,<br><strong>APCS Team</strong>'));
    assert.match(message.html, /apcs_logo_white_background_black/);
    assert.match(message.html, /class="footer"/);
});

test('route requires existing staff authorization for every operation', () => {
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    assert.match(route, /'resend', 'sendToAddress'/);
    assert.match(route, /router.post\(`\/group-announcement-emails\/\$\{operation\}`, requireTicketingAdmin, GroupAnnouncementEmailController\[operation\]\)/);
});

test('general preview and service send use Hello while personalized dummy and bulk content stay unchanged', async () => {
    const f = approvedFixture();
    const preview = await f.service.preview({ eventId: 'APCS2026' });
    assert.equal(preview.sendToAddressEnabled, true);
    assert.match(preview.generalMessage.text, /^Hello,\n\n/);
    assert.match(preview.generalMessage.html, /<p>Hello,<\/p>/);
    assert.match(preview.message.text, /^Dear Alex Example,/);
    await f.service.test({ eventId: 'APCS2026' }, { uid: 'staff' });
    const result = await f.service.sendToAddress({ eventId: 'APCS2026', revision: preview.revision,
        recipientEmail: 'guest@example.com', requestId: '12345678-1234-4123-8123-123456789abc', confirmed: true }, { uid: 'staff' });
    assert.equal(result.accepted, true);
    assert.equal(f.messages.length, 2);
    assert.equal(f.messages[1].html, preview.generalMessage.html);
    assert.equal(f.messages[1].text, preview.generalMessage.text);
    assert.deepEqual(f.messages[1].attachments, f.messages[0].attachments);
    const current = await f.service.status({ eventId: 'APCS2026', revision: preview.revision });
    assert.equal(current.total, 0);
});

function approvedFixture() {
    const { hash } = require('../src/services/GroupAnnouncementCampaignService');
    return fixture('published', null, { workerEnabled: true, resolveArtifact: () => ({
        revision: hash('approved-email-fixture'), sha256: hash('approved-pdf-fixture'), approvedForBulk: true,
        attachment: { filename: 'Final-2026-fixture.pdf', content: Buffer.from('%PDF-fixture'), contentType: 'application/pdf' },
    }) });
}

test('full service unlocks only after a saved same-version dummy and enqueues without sending clients in the request', async () => {
    const f = approvedFixture();
    assert.equal((await f.service.preview({ eventId: 'APCS2026' })).bulkEnabled, false);
    await f.service.test({ eventId: 'APCS2026' }, { uid: 'staff' });
    const preview = await f.service.preview({ eventId: 'APCS2026' });
    assert.equal(preview.bulkEnabled, true);
    const queued = await f.service.send({ eventId: 'APCS2026', revision: preview.revision,
        expectedRecipientsHash: preview.recipientsHash, confirmed: true }, { uid: 'staff' });
    assert.equal(queued.total, 3); assert.equal(queued.status, 'queued');
    assert.deepEqual(f.messages.map(mail => mail.to), [DUMMY_EMAIL]);
    f.reads.length = 0;
    f.records.delete('Registrants2025/R1');
    const reopened = await f.service.preview({ eventId: 'APCS2026' });
    assert.equal(reopened.recipientSource, 'saved_campaign');
    assert.equal(reopened.recipients.length, 3);
    assert.deepEqual(reopened.attendanceSummary, { total: 2, attending: 0, notAttending: 0, notImported: 1, unavailable: 1 });
    assert.equal(f.reads.filter(key => key.startsWith('Registrants2025/')).length, 2);
});

test('saved campaign attendance refreshes current flags without changing frozen recipients or delivery state', async () => {
    const f = approvedFixture();
    await f.service.test({ eventId: 'APCS2026' }, { uid: 'staff' });
    const preview = await f.service.preview({ eventId: 'APCS2026' });
    await f.service.send({ eventId: 'APCS2026', revision: preview.revision,
        expectedRecipientsHash: preview.recipientsHash, confirmed: true }, { uid: 'staff' });
    f.records.get('Registrants2025/R1').willAttend = false;
    f.records.get('Registrants2025/R1').performers[0].email = 'changed@example.com';
    f.records.get('Registrants2025/R2').willAttend = true;
    const before = structuredClone(f.records);
    const reopened = await f.service.preview({ eventId: 'APCS2026' });
    assert.deepEqual(reopened.attendanceSummary, { total: 2, attending: 1, notAttending: 1, notImported: 0, unavailable: 0 });
    assert.deepEqual(reopened.recipients, [...preview.recipients].sort((a, b) => a.key.localeCompare(b.key)));
    assert.deepEqual(f.records, before);
});

test('SMTP acceptance without a durable dummy receipt cannot unlock bulk or cause an automatic dummy resend', async () => {
    const f = approvedFixture();
    f.db.commitHook = writes => { if (writes.some(write => write.data.dummyTest)) throw new Error('Receipt persistence failed'); };
    await assert.rejects(f.service.test({ eventId: 'APCS2026' }, { uid: 'staff' }), /Receipt persistence failed/);
    f.db.commitHook = null;
    const preview = await f.service.preview({ eventId: 'APCS2026' });
    assert.equal(preview.dummyAccepted, false); assert.equal(preview.bulkEnabled, false);
    assert.equal(f.messages.length, 1);
});

test('a provider acknowledgement for another address never records a successful owner dummy', async () => {
    const f = fixture('draft', () => ({ accepted: ['another@example.com'], rejected: [] }));
    await assert.rejects(f.service.test({ eventId: 'APCS2026' }, { uid: 'staff' }), /not confirmed/);
    assert.deepEqual(f.messages.map(mail => mail.to), [DUMMY_EMAIL]);
    assert.ok(![...f.records.keys()].some(key => key.startsWith('groupAnnouncementCampaigns/')));
});
