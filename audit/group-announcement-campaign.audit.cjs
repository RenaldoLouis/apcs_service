const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCampaignService, recipientsHash, hash, LEASE_MS } = require('../src/services/GroupAnnouncementCampaignService');
const { announcementMessage, resolveArtifact, TEST_ONLY_SHA256 } = require('../src/services/GroupAnnouncementEmailService');
const config = require('../src/configs/groupAnnouncementEmailConfig');
const { memoryDb } = require('./helpers/group-email-memory-db.cjs');

function fixture(count = 2, transport) {
    const memory = memoryDb();
    let clock = 1000000;
    let sequence = 0;
    const recipients = Array.from({ length: count }, (_, index) => ({ key: `R${String(index).padStart(5, '0')}:person@example.com`,
        registrantId: `R${index}`, name: `Performer ${index}`, email: `person${index}@example.com`, groups: ['Main Hall'] }));
    const source = { recipients, skipped: [] };
    const artifact = { attachment: { filename: 'Approved-2026.pdf', content: Buffer.from('%PDF-fixture'), contentType: 'application/pdf' },
        revision: hash(['approved-2026']), sha256: hash(['fixture-bytes']), approvedForBulk: true };
    const messages = [];
    const options = { db: memory.db, now: () => clock, uuid: () => `attempt-${++sequence}`, pause: async () => { clock += 1100; },
        workerEnabled: true, resolveArtifact: () => artifact, readRecipients: async () => structuredClone(source), renderMessage: announcementMessage,
        sendMail: async mail => { messages.push(mail); return transport ? transport(mail) : { accepted: [mail.to], rejected: [] }; } };
    const service = createCampaignService(options);
    const input = () => ({ eventId: 'APCS2026', revision: artifact.revision, expectedRecipientsHash: recipientsHash(source.recipients), confirmed: true });
    const actor = { uid: 'staff', email: 'staff@example.com' };
    const start = async () => { await service.recordDummy('APCS2026', artifact, actor); return service.start(input(), actor); };
    return { ...memory, service, options, input, start, actor, artifact, source, messages, advance: ms => { clock += ms; } };
}

async function completedFixture(transport) {
    const f = fixture(2);
    const campaign = await f.start();
    await f.service.processOne(campaign.id);
    f.advance(1100);
    await f.service.processOne(campaign.id);
    f.messages.length = 0;
    if (transport) f.service = createCampaignService({ ...f.options, sendMail: async mail => {
        f.messages.push(mail); return transport(mail);
    } });
    f.resendInput = { eventId: 'APCS2026', revision: f.artifact.revision,
        recipientKey: f.source.recipients[0].key, requestId: '12345678-1234-4123-8123-123456789abc', confirmed: true };
    f.campaign = campaign;
    return f;
}

test('individual resend sends only the selected saved contact and preserves the original campaign and deliveries', async () => {
    const f = await completedFixture();
    const original = structuredClone(f.records);
    f.source.recipients[0].email = 'later-edit@example.com';
    const result = await f.service.resend({ ...f.resendInput, email: 'injected@example.com', recipients: f.source.recipients }, f.actor);
    assert.equal(result.accepted, true);
    assert.equal(result.recipientEmail, 'person0@example.com');
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].to, 'person0@example.com');
    assert.match(f.messages[0].text, /Dear Performer 0,/);
    assert.equal(f.messages[0].attachments[0].filename, f.artifact.attachment.filename);
    for (const [key, data] of original) assert.deepEqual(f.records.get(key), data);
    assert.equal([...f.records.keys()].filter(key => !original.has(key)).length, 2);
});

test('one-time address override sends one personalized copy without persisting the entered address', async () => {
    const f = await completedFixture();
    const original = structuredClone(f.records);
    const result = await f.service.resend({ ...f.resendInput, recipientEmail: '  alternate@example.com  ' }, f.actor);
    assert.equal(result.accepted, true);
    assert.equal(result.recipientEmail, 'alternate@example.com');
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].to, 'alternate@example.com');
    assert.match(f.messages[0].text, /Dear Performer 0,/);
    assert.equal(f.messages[0].attachments[0].filename, f.artifact.attachment.filename);
    for (const [key, data] of original) assert.deepEqual(f.records.get(key), data);
    assert.ok(!JSON.stringify([...f.records]).includes('alternate@example.com'));
    const attempt = f.records.get(`groupAnnouncementCampaigns/${f.campaign.id}/resends/${f.resendInput.requestId}`);
    assert.equal(attempt.email, 'person0@example.com');
    assert.equal(attempt.recipientEmailHash, hash('alternate@example.com'));
});

test('alternate address validation rejects lists, headers, malformed addresses and nonstrings before writes or SMTP', async () => {
    const f = await completedFixture();
    const before = structuredClone(f.records);
    for (const recipientEmail of ['', ' ', 'bad', 'a@example.com,b@example.com', 'a@example.com;b@example.com',
        'Person <a@example.com>', 'a@example.com\r\nBcc: b@example.com', 'a\u0000@example.com', 'a..b@example.com',
        'a@-example.com', 'a@example..com', `${'a'.repeat(65)}@example.com`, ['a@example.com'], null, 1]) {
        await assert.rejects(f.service.resend({ ...f.resendInput, recipientEmail }, f.actor), /one valid email/);
    }
    assert.deepEqual(f.records, before);
    assert.equal(f.messages.length, 0);
});

test('alternate resend request IDs bind the entered address and retain the row cooldown across address changes', async () => {
    const f = await completedFixture();
    const input = { ...f.resendInput, recipientEmail: 'alternate@example.com' };
    await f.service.resend(input, f.actor);
    await createCampaignService(f.options).resend(input, f.actor);
    assert.equal(f.messages.length, 1);
    await assert.rejects(f.service.resend({ ...input, recipientEmail: 'other@example.com' }, f.actor), /different email address/);
    await assert.rejects(f.service.resend(f.resendInput, f.actor), /different email address/);
    await assert.rejects(f.service.resend({ ...input, requestId: '42345678-1234-4123-8123-123456789abc',
        recipientEmail: 'other@example.com' }, f.actor), /three minutes/);
    assert.equal(f.messages.length, 1);
});

test('existing resend receipts without an email fingerprint cannot be replayed as an alternate-address success', async () => {
    const f = await completedFixture();
    await f.service.resend(f.resendInput, f.actor);
    delete f.records.get(`groupAnnouncementCampaigns/${f.campaign.id}/resends/${f.resendInput.requestId}`).recipientEmailHash;
    assert.equal((await f.service.resend(f.resendInput, f.actor)).accepted, true);
    await assert.rejects(f.service.resend({ ...f.resendInput, recipientEmail: 'alternate@example.com' }, f.actor), /different email address/);
    assert.equal(f.messages.length, 1);
});

test('an alternate send with a wrong-address acknowledgement or transport error stays uncertain without retry', async () => {
    for (const transport of [async () => ({ accepted: ['person0@example.com'], rejected: [] }),
        async () => { throw new Error('Connection lost'); }]) {
        const f = await completedFixture(transport);
        const input = { ...f.resendInput, recipientEmail: 'alternate@example.com' };
        assert.equal((await f.service.resend(input, f.actor)).status, 'uncertain');
        f.advance(LEASE_MS + 1);
        assert.equal((await createCampaignService(f.options).resend(input, f.actor)).status, 'uncertain');
        assert.equal(f.messages.length, 1);
        assert.ok(!JSON.stringify([...f.records]).includes('alternate@example.com'));
    }
});

test('resend requires explicit staff confirmation, valid event/version, an enabled runtime and saved recipient', async () => {
    const f = await completedFixture();
    for (const input of [{ ...f.resendInput, confirmed: false }, { ...f.resendInput, eventId: 'APCS2025' },
        { ...f.resendInput, requestId: 'bad' }, { ...f.resendInput, revision: 'bad' }]) {
        await assert.rejects(f.service.resend(input, f.actor), /Confirm one/);
    }
    await assert.rejects(f.service.resend(f.resendInput, null), /signed-in staff/);
    await assert.rejects(createCampaignService({ ...f.options, workerEnabled: false }).resend(f.resendInput, f.actor), /not enabled/);
    await assert.rejects(f.service.resend({ ...f.resendInput, recipientKey: 'not-in-snapshot' }, f.actor), /saved campaign/);
    f.artifact.approvedForBulk = false;
    await assert.rejects(f.service.resend(f.resendInput, f.actor), /approved email\/PDF changed/);
    f.artifact.approvedForBulk = true;
    await assert.rejects(f.service.resend({ ...f.resendInput, revision: hash('another-version') }, f.actor), /changed/);
    assert.equal(f.messages.length, 0);
});

test('resend refuses unfinished campaigns and missing exact-version dummy approval', async () => {
    const f = await completedFixture();
    const ref = `groupAnnouncementCampaigns/${f.campaign.id}`;
    const original = structuredClone(f.records.get(ref));
    for (const change of [{ status: 'running' }, { cursor: 1 }, { runnable: true }, { inFlight: {} }]) {
        f.records.set(ref, { ...original, ...change });
        await assert.rejects(f.service.resend(f.resendInput, f.actor), /finish before resending/);
    }
    f.records.set(ref, { ...original, dummyTest: null });
    await assert.rejects(f.service.resend(f.resendInput, f.actor), /successful dummy/);
    assert.equal(f.messages.length, 0);
});

test('duplicate resend requests including after restart never issue another SMTP send', async () => {
    const f = await completedFixture();
    const results = await Promise.all([f.service.resend(f.resendInput, f.actor), f.service.resend(f.resendInput, f.actor)]);
    assert.ok(results.every(result => ['sending', 'accepted'].includes(result.status)));
    f.advance(LEASE_MS + 1);
    const result = await createCampaignService(f.options).resend(f.resendInput, f.actor);
    assert.equal(result.status, 'accepted');
    assert.equal(f.messages.length, 1);
    await assert.rejects(f.service.resend({ ...f.resendInput, recipientKey: f.source.recipients[1].key }, f.actor), /another recipient/);
});

test('another staff request for the same row is blocked during the cooldown but a different row is independent', async () => {
    const f = await completedFixture();
    await f.service.resend(f.resendInput, f.actor);
    const other = { ...f.resendInput, requestId: '22345678-1234-4123-8123-123456789abc' };
    await assert.rejects(createCampaignService(f.options).resend(other, { uid: 'other-staff' }), /three minutes/);
    await f.service.resend({ ...other, requestId: '32345678-1234-4123-8123-123456789abc', recipientKey: f.source.recipients[1].key }, f.actor);
    assert.deepEqual(f.messages.map(mail => mail.to), ['person0@example.com', 'person1@example.com']);
    f.advance(LEASE_MS + 1);
    await f.service.resend(other, f.actor);
    assert.equal(f.messages.length, 3);
    await f.service.resend(f.resendInput, f.actor);
    assert.equal(f.messages.length, 3, 'Even an older request stays idempotent after a newer manual resend');
});

test('rejected and ambiguous individual resends are recorded without retrying or requeuing the bulk campaign', async () => {
    for (const [transport, expected] of [[async mail => ({ accepted: [], rejected: [mail.to] }), 'failed'],
        [async () => { throw new Error('Connection lost after acceptance'); }, 'uncertain']]) {
        const f = await completedFixture(transport);
        assert.equal((await f.service.resend(f.resendInput, f.actor)).status, expected);
        f.advance(LEASE_MS + 1);
        assert.equal((await f.service.resend(f.resendInput, f.actor)).status, expected);
        await f.service.processDue();
        assert.equal(f.messages.length, 1);
        assert.equal((await f.service.status(f.resendInput)).accepted, 2);
    }
});

test('a failed reservation sends nothing; a failed result save never repeats an uncertain SMTP attempt', async () => {
    const f = await completedFixture();
    f.db.commitHook = () => { throw new Error('Reservation unavailable'); };
    await assert.rejects(f.service.resend(f.resendInput, f.actor), /Reservation unavailable/);
    assert.equal(f.messages.length, 0);
    f.db.commitHook = writes => {
        if (writes.some(write => write.data.status === 'accepted')) throw new Error('Result save unavailable');
    };
    await assert.rejects(f.service.resend(f.resendInput, f.actor), /Result save unavailable/);
    assert.equal(f.messages.length, 1);
    f.db.commitHook = null;
    f.advance(LEASE_MS + 1);
    assert.equal((await createCampaignService(f.options).resend(f.resendInput, f.actor)).status, 'sending');
    assert.equal(f.messages.length, 1);
});

test('bulk requires staff confirmation, an enabled worker, an approved artifact and an exact successful dummy receipt', async () => {
    const f = fixture();
    await assert.rejects(f.service.start(f.input(), null), /signed-in staff/);
    await assert.rejects(f.service.start({ ...f.input(), confirmed: false }, f.actor), /Confirm/);
    const disabled = createCampaignService({ ...f.options, workerEnabled: false });
    await assert.rejects(disabled.start(f.input(), f.actor), /not enabled/);
    f.artifact.approvedForBulk = false;
    await assert.rejects(f.service.start({ ...f.input(), approvedForBulk: true }, f.actor), /dummy testing only/);
    f.artifact.approvedForBulk = true;
    await assert.rejects(f.service.start({ ...f.input(), dummyAccepted: true }, f.actor), /successful dummy/);
    await f.service.recordDummy('APCS2026', f.artifact, f.actor);
    await assert.rejects(f.service.start({ ...f.input(), revision: hash('old-version') }, f.actor), /Email or PDF changed/);
    assert.equal(f.messages.length, 0);
});

test('contact errors, empty and stale rosters prevent any campaign snapshot', async () => {
    const f = fixture();
    await f.service.recordDummy('APCS2026', f.artifact, f.actor);
    f.source.skipped.push({ reason: 'Missing email' });
    await assert.rejects(f.service.start(f.input(), f.actor), /every contact issue/);
    f.source.skipped = [];
    await assert.rejects(f.service.start({ ...f.input(), expectedRecipientsHash: 'stale' }, f.actor), /recipients changed/);
    f.source.recipients = [];
    await assert.rejects(f.service.start(f.input(), f.actor), /no eligible/);
    assert.equal(f.messages.length, 0);
});

test('snapshot and pointer commit atomically in chunks, with no SMTP in the start request', async () => {
    const f = fixture(230);
    const campaign = await f.start();
    assert.equal(campaign.status, 'queued');
    assert.equal(campaign.total, 230);
    assert.equal([...f.records.keys()].filter(key => key.includes('/chunks/')).length, 3);
    assert.equal(f.records.get('groupAnnouncementCampaigns/APCS2026').latestCampaignId, campaign.id);
    assert.equal(f.messages.length, 0);
    assert.deepEqual(await f.service.snapshotRecipients(campaign.id), f.source.recipients);
});

test('transaction failure cannot leave a partially enqueued campaign; unchanged retry succeeds', async () => {
    const f = fixture(205);
    await f.service.recordDummy('APCS2026', f.artifact, f.actor);
    f.db.commitHook = writes => { if (writes.some(write => write.ref.key.includes('/chunks/'))) throw new Error('commit failed'); };
    await assert.rejects(f.service.start(f.input(), f.actor), /commit failed/);
    assert.equal([...f.records.keys()].filter(key => key.includes('/chunks/')).length, 0);
    assert.equal(f.records.has('groupAnnouncementCampaigns/APCS2026'), false);
    f.db.commitHook = null;
    assert.equal((await f.service.start(f.input(), f.actor)).total, 205);
});

test('duplicate starts, lost acknowledgement retries and another browser reuse one immutable campaign', async () => {
    const f = fixture();
    await f.service.recordDummy('APCS2026', f.artifact, f.actor);
    const [first, second] = await Promise.all([f.service.start(f.input(), f.actor), f.service.start(f.input(), { uid: 'other-staff' })]);
    assert.equal(first.id, second.id);
    f.source.recipients[0].email = 'changed@example.com';
    assert.equal((await f.service.start(f.input(), f.actor)).id, first.id);
    assert.equal((await f.service.snapshotRecipients(first.id))[0].email, 'person0@example.com');
    assert.equal(f.messages.length, 0);
});

test('another email version cannot start while an earlier campaign has pending recipients', async () => {
    const f = fixture();
    await f.start();
    f.artifact.revision = hash('new-version');
    await f.service.recordDummy('APCS2026', f.artifact, f.actor);
    await assert.rejects(f.service.start(f.input(), f.actor), /existing campaign/);
});

test('a new server instance resumes saved recipients without any browser session or current-roster dependency', async () => {
    const f = fixture();
    const campaign = await f.start();
    f.source.recipients = [];
    const restarted = createCampaignService({ ...f.options, readRecipients: () => { throw new Error('A worker must not read the live roster'); } });
    await restarted.processOne(campaign.id);
    f.advance(1100);
    await restarted.processOne(campaign.id);
    const status = await restarted.status({ eventId: 'APCS2026', revision: f.artifact.revision });
    assert.equal(status.status, 'completed');
    assert.equal(status.accepted, 2);
    assert.equal(status.processed, 2);
    assert.deepEqual(f.messages.map(mail => mail.to), ['person0@example.com', 'person1@example.com']);
    assert.ok(f.messages.every(mail => mail.attachments.length === 1 && /Dear Performer/.test(mail.text)));
    assert.equal((await restarted.processOne(campaign.id)).idle, true);
});

test('concurrent workers lease one recipient once and preserve a stable message identifier', async () => {
    let release;
    const f = fixture(1, mail => new Promise(resolve => { release = () => resolve({ accepted: [mail.to], rejected: [] }); }));
    const campaign = await f.start();
    const first = f.service.processOne(campaign.id);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const other = createCampaignService(f.options);
    assert.equal((await other.processOne(campaign.id)).idle, true);
    assert.equal(f.messages.length, 1);
    assert.match(f.messages[0].messageId, new RegExp(campaign.id));
    release(); await first;
    assert.equal((await other.status({ eventId: 'APCS2026', revision: f.artifact.revision })).accepted, 1);
});

test('persistent throttling prevents an immediate next send across different worker instances', async () => {
    const f = fixture();
    const campaign = await f.start();
    await f.service.processOne(campaign.id);
    assert.equal((await createCampaignService(f.options).processOne(campaign.id)).idle, true);
    assert.equal(f.messages.length, 1);
    f.advance(1100);
    await f.service.processOne(campaign.id);
    assert.equal(f.messages.length, 2);
});

test('ambiguous SMTP failures are recorded as uncertain and never automatically retried; pending recipients continue', async () => {
    let count = 0;
    const f = fixture(2, mail => { if (++count === 1) throw new Error('Connection lost after DATA'); return { accepted: [mail.to], rejected: [] }; });
    const campaign = await f.start();
    await f.service.processOne(campaign.id);
    f.advance(1100); await f.service.processOne(campaign.id);
    const status = await f.service.status({ eventId: 'APCS2026', revision: f.artifact.revision });
    assert.equal(status.status, 'completed_with_issues');
    assert.equal(status.uncertain, 1); assert.equal(status.accepted, 1);
    assert.equal(status.issues[0].email, 'person0@example.com');
    f.advance(LEASE_MS); await f.service.processOne(campaign.id);
    assert.equal(f.messages.length, 2);
});

test('explicit SMTP rejection is recorded once without blocking the rest of the campaign', async () => {
    const f = fixture(1, mail => ({ accepted: [], rejected: [mail.to] }));
    const campaign = await f.start();
    await f.service.processOne(campaign.id);
    const status = await f.service.status({ eventId: 'APCS2026', revision: f.artifact.revision });
    assert.equal(status.failed, 1); assert.equal(status.status, 'completed_with_issues');
    assert.equal((await f.service.processOne(campaign.id)).idle, true);
});

test('a crash after SMTP acceptance but before saving the result recovers as uncertain without resending', async () => {
    const f = fixture(1);
    const campaign = await f.start();
    f.db.commitHook = writes => { if (writes.some(write => write.data.status === 'accepted')) throw new Error('Database unavailable after SMTP'); };
    await assert.rejects(f.service.processOne(campaign.id), /Database unavailable/);
    assert.equal(f.messages.length, 1);
    f.db.commitHook = null;
    f.advance(LEASE_MS + 1);
    assert.equal((await createCampaignService(f.options).processOne(campaign.id)).recovered, true);
    const status = await f.service.status({ eventId: 'APCS2026', revision: f.artifact.revision });
    assert.equal(status.uncertain, 1); assert.equal(status.accepted, 0); assert.equal(status.processed, 1);
    await f.service.processOne(campaign.id);
    assert.equal(f.messages.length, 1);
});

test('late results from an expired worker cannot overwrite recovery or advance the cursor twice', async () => {
    let release;
    const f = fixture(1, mail => new Promise(resolve => { release = () => resolve({ accepted: [mail.to], rejected: [] }); }));
    const campaign = await f.start();
    const first = f.service.processOne(campaign.id);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    f.advance(LEASE_MS + 1);
    assert.equal((await createCampaignService(f.options).processOne(campaign.id)).recovered, true);
    release();
    assert.equal((await first).saved, false);
    const status = await f.service.status({ eventId: 'APCS2026', revision: f.artifact.revision });
    assert.equal(status.processed, 1); assert.equal(status.uncertain, 1); assert.equal(status.accepted, 0);
});

test('missing or changed content pauses pending delivery; restoring the exact version resumes its saved snapshot', async () => {
    const f = fixture();
    const campaign = await f.start();
    const revision = f.artifact.revision;
    f.artifact.revision = hash('changed');
    assert.equal((await f.service.processOne(campaign.id)).blocked, true);
    assert.equal(f.messages.length, 0);
    f.artifact.revision = revision;
    assert.equal((await f.service.start(f.input(), f.actor)).status, 'queued');
    await f.service.processOne(campaign.id);
    assert.equal(f.messages.length, 1);
});

test('background scan only processes explicitly runnable campaigns and maintains progress across batches', async () => {
    const f = fixture(12);
    const campaign = await f.start();
    await f.service.processDue();
    assert.equal(f.messages.length, 10);
    await createCampaignService(f.options).processDue();
    assert.equal(f.messages.length, 12);
    assert.equal((await f.service.latest('APCS2026')).status, 'completed');
    assert.equal((await f.service.snapshotRecipients(campaign.id)).length, 12);
});

test('known 2025 PDF cannot be relabelled as an approved client attachment even with its correct hash', () => {
    const configuredAttachment = config.clientAttachment;
    assert.equal(resolveArtifact().approvedForBulk, true);
    try {
        config.clientAttachment = { filename: 'Program Notes - Fixed.pdf', sha256: TEST_ONLY_SHA256 };
        assert.throws(resolveArtifact, /test-only 2025 document/);
    } finally { config.clientAttachment = configuredAttachment; }
});

test('general rundown sends without selecting or starting a registrant campaign and keeps only destination hash', async () => {
    const f = fixture();
    await f.service.recordDummy('APCS2026', f.artifact, f.actor);
    const before = structuredClone(f.records);
    const input = { eventId: 'APCS2026', revision: f.artifact.revision, confirmed: true,
        requestId: '12345678-1234-4123-8123-123456789abc', recipientEmail: '  guest@example.com  ',
        recipientKey: f.source.recipients[0].key, name: 'Injected Name' };
    const [result, duplicate] = await Promise.all([f.service.sendToAddress(input, f.actor), f.service.sendToAddress(input, f.actor)]);
    assert.equal(result.accepted, true);
    assert.ok(['sending', 'accepted'].includes(duplicate.status));
    assert.equal(result.recipientEmail, 'guest@example.com');
    assert.equal(f.messages.length, 1);
    assert.equal(f.messages[0].to, 'guest@example.com');
    assert.match(f.messages[0].text, /^Hello,\n\n/);
    assert.match(f.messages[0].html, /<p>Hello,<\/p>/);
    assert.ok(!f.messages[0].text.includes('Injected Name'));
    assert.deepEqual(f.messages[0].attachments, [f.artifact.attachment]);
    for (const [key, data] of before) assert.deepEqual(f.records.get(key), data);
    assert.equal([...f.records.keys()].filter(key => !before.has(key)).length, 2);
    assert.ok(!JSON.stringify([...f.records]).includes('guest@example.com'));
    assert.ok(!f.reads.some(key => key.startsWith('Registrants2025/') || key.startsWith('sessionAssignments/')));
    const recreated = createCampaignService(f.options);
    assert.equal((await recreated.sendToAddress(input, f.actor)).accepted, true);
    assert.equal(f.messages.length, 1);
    await assert.rejects(recreated.sendToAddress({ ...input, recipientEmail: 'other@example.com' }, f.actor));
    await assert.rejects(recreated.sendToAddress({ ...input, requestId: '22345678-1234-4123-8123-123456789abc' }, f.actor), /three minutes/);
});

test('general send works after bulk completion while preserving the frozen roster and counts', async () => {
    const f = await completedFixture();
    const before = structuredClone(f.records);
    await f.service.sendToAddress({ ...f.resendInput, recipientEmail: 'guest@example.com' }, f.actor);
    assert.match(f.messages[0].text, /^Hello,/);
    for (const [key, data] of before) assert.deepEqual(f.records.get(key), data);
});

test('general send rejects invalid destinations, missing confirmation, actor and wrong event before writes', async () => {
    const f = fixture();
    await f.service.recordDummy('APCS2026', f.artifact, f.actor);
    const input = { ...f.input(), requestId: '12345678-1234-4123-8123-123456789abc', recipientEmail: 'guest@example.com' };
    const before = structuredClone(f.records);
    for (const recipientEmail of [undefined, null, '', 'invalid', 'a@example.com,b@example.com', 'Name <a@example.com>',
        'a@example.com\r\nBcc: b@example.com', 'a..b@example.com', 'a@-example.com', ['a@example.com']]) {
        await assert.rejects(f.service.sendToAddress({ ...input, recipientEmail }, f.actor), /one valid email/);
    }
    for (const patch of [{ confirmed: false }, { eventId: 'APCS2025' }, { requestId: 'invalid' }]) {
        await assert.rejects(f.service.sendToAddress({ ...input, ...patch }, f.actor));
    }
    await assert.rejects(f.service.sendToAddress(input, null));
    assert.deepEqual(f.records, before);
    assert.equal(f.messages.length, 0);
});

test('general send enforces approved exact PDF, durable dummy and enabled delivery', async () => {
    const f = fixture();
    const input = { ...f.input(), requestId: '12345678-1234-4123-8123-123456789abc', recipientEmail: 'guest@example.com' };
    await assert.rejects(f.service.sendToAddress(input, f.actor));
    await f.service.recordDummy('APCS2026', f.artifact, f.actor);
    for (const patch of [{ workerEnabled: false }, { resolveArtifact: () => ({ ...f.artifact, approvedForBulk: false }) },
        { resolveArtifact: () => ({ ...f.artifact, revision: 'f'.repeat(64) }) }]) {
        await assert.rejects(createCampaignService({ ...f.options, ...patch }).sendToAddress(input, f.actor));
    }
    const id = (await f.service.status(input)).id;
    f.records.get(`groupAnnouncementCampaigns/${id}`).dummyTest.approvedForBulk = false;
    await assert.rejects(f.service.sendToAddress(input, f.actor), /dummy/);
    assert.equal(f.messages.length, 0);
});

test('general send blocks active same-version or other-version bulk campaigns', async () => {
    const f = fixture();
    await f.start();
    const input = { ...f.input(), requestId: '12345678-1234-4123-8123-123456789abc', recipientEmail: 'guest@example.com' };
    await assert.rejects(f.service.sendToAddress(input, f.actor), /finish/);
    const id = (await f.service.status(input)).id;
    f.records.get(`groupAnnouncementCampaigns/${id}`).status = 'completed';
    f.records.get(`groupAnnouncementCampaigns/${id}`).runnable = false;
    f.records.get(`groupAnnouncementCampaigns/${id}`).cursor = 2;
    f.records.set('groupAnnouncementCampaigns/APCS2026', { latestCampaignId: 'other' });
    f.records.set('groupAnnouncementCampaigns/other', { total: 2, cursor: 0, status: 'queued' });
    await assert.rejects(f.service.sendToAddress(input, f.actor), /finish/);
    assert.equal(f.messages.length, 0);
});

test('general send records rejection or uncertainty and never automatically sends a repeated request', async () => {
    for (const [transport, expected] of [
        [() => ({ accepted: [], rejected: ['guest@example.com'] }), 'failed'],
        [() => { throw new Error('SMTP response lost'); }, 'uncertain'],
        [() => ({ accepted: ['wrong@example.com'], rejected: [] }), 'uncertain'],
    ]) {
        const f = await completedFixture(transport);
        const input = { ...f.resendInput, recipientEmail: 'guest@example.com' };
        assert.equal((await f.service.sendToAddress(input, f.actor)).status, expected);
        assert.equal((await f.service.sendToAddress(input, f.actor)).accepted, false);
        assert.equal(f.messages.length, 1);
    }
});
