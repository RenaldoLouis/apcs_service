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
