const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { createService } = require('../src/services/ScoringResultEmailService');
const content = require('../src/services/ScoringResultEmailContent');

function fixture(sendMail, readDelayMs = 0) {
    const records = new Map([
        ['events/APCS2026', { videoPenaltyConfig: null }],
        ['Registrants2025/R1', { eventId: 'APCS2026', competitionCategory: 'Piano', finalAward: 'Sapphire', averageScore: 99, videoPenaltyConfigRevision: null,
            name: 'Parent Name', email: 'parent@example.com',
            performers: [{ fullName: 'Alice Example', email: 'alice@example.com' },
                { firstName: 'Bob', lastName: 'Example', email: 'bob@example.com' }] }],
        ['JuryScores2025/S1', { registrantId: 'R1', competitionCategory: 'Piano', score: 99, isFinalized: true }],
    ]);
    const snapshot = key => ({ exists: records.has(key), data: () => records.get(key) });
    const pause = () => readDelayMs ? new Promise(resolve => setTimeout(resolve, readDelayMs)) : Promise.resolve();
    const query = (collection, field, value) => ({ get: async () => { await pause(); return { docs: [...records]
        .filter(([key, data]) => key.startsWith(collection + '/') && data[field] === value)
        .map(([key]) => snapshot(key)) }; } });
    let lock = Promise.resolve();
    const db = {
        collection: name => ({
            doc: id => ({ key: `${name}/${id}`, get: async () => { await pause(); return snapshot(`${name}/${id}`); } }),
            where: (field, op, value) => query(name, field, value),
        }),
        runTransaction: operation => {
            const run = lock.then(async () => {
                const writes = [];
                const transaction = {
                    get: ref => {
                        assert.equal(writes.length, 0, 'Firestore reads must precede writes');
                        return ref.get();
                    },
                    set: (ref, data) => writes.push(() => records.set(ref.key, data)),
                    update: (ref, data) => writes.push(() => records.set(ref.key, { ...records.get(ref.key), ...data })),
                };
                const result = await operation(transaction);
                writes.forEach(write => write());
                return result;
            });
            lock = run.catch(() => {});
            return run;
        },
    };
    const messages = [];
    const service = createService({ db, sendMail: async message => {
        messages.push(message);
        return sendMail ? sendMail(message) : { accepted: [message.to], messageId: 'smtp-1' };
    } });
    const preview = (kind = 'winner') => service.preview({ eventId: 'APCS2026', kind, registrantIds: ['R1'] });
    const payload = recipient => ({ eventId: 'APCS2026', kind: recipient.award === 'Fail' ? 'nonQualifier' : 'winner',
        registrantId: recipient.registrantId, performerIndex: recipient.performerIndex, snapshot: recipient.snapshot,
        dates: { confirmationDeadline: '12 October 2026', rundownReleaseDate: '19 October 2026' },
        attachment: { filename: `${recipient.name}.pdf`, base64: content.dummyPdf('nonQualifier').content.toString('base64') } });
    const send = async (index = 0, kind = 'winner') => service.send(payload((await preview(kind)).recipients[index]), { email: 'admin@example.com' });
    return { records, messages, service, preview, payload, send };
}

test('RESULT EMAILS: preview does not serialize Firestore latency across registrations', async () => {
    const f = fixture(undefined, 120);
    const ids = ['R1'];
    for (let index = 2; index <= 15; index += 1) {
        const id = `R${index}`;
        ids.push(id);
        f.records.set(`Registrants2025/${id}`, { ...f.records.get('Registrants2025/R1'),
            performers: [{ fullName: `Performer ${index}`, email: `performer${index}@example.com` }] });
        f.records.set(`JuryScores2025/S${index}`, { registrantId: id,
            competitionCategory: 'Piano', score: 99, isFinalized: true });
    }
    const started = performance.now();
    const result = await f.service.preview({ eventId: 'APCS2026', kind: 'winner', registrantIds: ids });
    const elapsed = performance.now() - started;
    assert.equal(result.recipients.length, 16);
    assert.deepEqual(result.recipients.map(recipient => recipient.name),
        ['Alice Example', 'Bob Example', ...Array.from({ length: 14 }, (_, index) => `Performer ${index + 2}`)]);
    assert.ok(elapsed < 4000, `Preview took ${Math.round(elapsed)} ms with mocked 120 ms reads`);
});

for (const [score, award] of [[80, 'Silver'], [87, 'Gold'], [93, 'Diamond'], [99, 'Sapphire']]) {
    test(`RESULT EMAILS: finalized ${award} gets actual award and only one shared PDF`, async () => {
        const f = fixture();
        Object.assign(f.records.get('Registrants2025/R1'), { finalAward: award, averageScore: score });
        assert.equal((await f.preview()).recipients[0].award, award);
        assert.equal((await f.send()).status, 'sent');
        assert.match(f.messages[0].text, new RegExp(`${award.toUpperCase()} WINNER`));
        assert.equal(f.messages[0].attachments.length, 1);
        assert.equal(f.messages[0].subject, 'APCS Gala Concert 2026 – Performance Invitation');
        assert.match(f.messages[0].html, /class="email-container"/);
        assert.match(f.messages[0].html, /Dear <strong>Alice Example<\/strong>,/);
        assert.match(f.messages[0].html, /Dear <strong>Alice Example<\/strong>,<\/p>\s*<p>Congratulations!<\/p>/);
        assert.match(f.messages[0].html, new RegExp(`<strong>${award.toUpperCase()} WINNER</strong>`));
        assert.match(f.messages[0].html, /<strong>APCS Gala Concert The Sound of Asia 2026<\/strong>/);
        assert.doesNotMatch(f.messages[0].html, /<h1[^>]*>Performance invitation<\/h1>|APCS GALA CONCERT 2026/);
        assert.match(f.messages[0].html, /EVENT DETAILS/);
        assert.match(f.messages[0].html, /<strong>Date:<\/strong><br>14–15 November 2026/);
        assert.match(f.messages[0].html, /<strong>attached PDF<\/strong>/);
        assert.match(f.messages[0].html, /<strong>no later than 12 October 2026<\/strong>/);
        assert.match(f.messages[0].html, /<strong>no changes to the attendance confirmation or performer substitution will be permitted<\/strong>/);
        assert.match(f.messages[0].html, /<strong>final performance rundown<\/strong> will be shared on <strong>19 October 2026<\/strong>/);
        assert.match(f.messages[0].html, /href="https:\/\/wa\.me\/6282213002686"[^>]*><strong>\+62 822-1300-2686<\/strong><\/a>/);
        assert.match(f.messages[0].html, /<strong>APCS Team<\/strong>/);
        assert.match(f.messages[0].text, /officially invited to perform/);
        assert.match(f.messages[0].text, /^Dear Alice Example,\n\nCongratulations!\n\nYou have been awarded/);
    });
}

test('RESULT EMAILS: every ensemble performer gets their own address and greeting', async () => {
    const f = fixture();
    await f.send(0); await f.send(1);
    assert.deepEqual(f.messages.map(message => message.to), ['alice@example.com', 'bob@example.com']);
    assert.match(f.messages[0].text, /^Dear Alice Example,/);
    assert.match(f.messages[1].text, /^Dear Bob Example,/);
    assert.ok(!f.messages.some(message => message.to === 'parent@example.com'));
});

test('RESULT EMAILS: fail gets one matched PDF and no certificate promise', async () => {
    const f = fixture();
    Object.assign(f.records.get('Registrants2025/R1'), { finalAward: 'Fail', averageScore: 70 });
    assert.equal((await f.send(0, 'nonQualifier')).status, 'sent');
    assert.equal(f.messages[0].attachments.length, 1);
    assert.match(f.messages[0].text, /did not qualify/);
    assert.match(f.messages[0].text, /e-comment sheet attached/);
    assert.doesNotMatch(f.messages[0].text, /e-certificate/);
    assert.match(f.messages[0].html, /class="email-container"/);
    assert.match(f.messages[0].html, /Dear <strong>Alice Example<\/strong>,/);
    assert.match(f.messages[0].html, /border-left:4px solid #c79b45/);
    assert.match(f.messages[0].html, /Your e-comment sheet/);
    assert.match(f.messages[0].html, /Best regards,<br><strong>APCS Team<\/strong>/);
});

test('RESULT EMAILS: backend ignores supplied destination/award and rejects stale identities', async () => {
    const f = fixture();
    const payload = f.payload((await f.preview()).recipients[0]);
    await f.service.send({ ...payload, to: 'outsider@example.com', award: 'Fail' }, { email: 'admin@example.com' });
    assert.equal(f.messages[0].to, 'alice@example.com');
    assert.match(f.messages[0].text, /SAPPHIRE WINNER/);
    f.records.get('Registrants2025/R1').performers[0].email = 'changed@example.com';
    await assert.rejects(f.service.send(payload, { email: 'admin@example.com' }), /changed/);
});

test('RESULT EMAILS: unfinished, missing, wrong-event, invalid and wrong-kind results are blocked', async () => {
    for (const mutation of [
        f => { f.records.get('JuryScores2025/S1').isFinalized = false; },
        f => { f.records.delete('JuryScores2025/S1'); },
        f => { f.records.get('Registrants2025/R1').eventId = 'APCS2025'; },
        f => { f.records.get('JuryScores2025/S1').eventId = 'APCS2025'; },
        f => { f.records.get('Registrants2025/R1').finalAward = 'N/A'; },
        f => { delete f.records.get('Registrants2025/R1').averageScore; },
        f => { f.records.get('Registrants2025/R1').averageScore = null; },
        f => { Object.assign(f.records.get('Registrants2025/R1'), { finalAward: 'Fail', averageScore: 70 }); },
    ]) {
        const f = fixture(); mutation(f);
        await assert.rejects(f.preview());
        assert.equal(f.messages.length, 0);
    }
});

test('RESULT EMAILS: uses saved results without duplicating jury or penalty calculations', async () => {
    const f = fixture();
    const registration = f.records.get('Registrants2025/R1');
    Object.assign(registration, { penaltyScore: 50, videoDuration: 999, finalAward: 'Gold', averageScore: 90 });
    f.records.get('JuryScores2025/S1').score = 70;
    assert.equal((await f.preview()).recipients[0].award, 'Gold');
    await assert.rejects(f.preview('nonQualifier'));
});

test('RESULT EMAILS: changed saved scores invalidate preview and outdated rule revision blocks sends', async () => {
    const f = fixture();
    const input = f.payload((await f.preview()).recipients[0]);
    f.records.get('Registrants2025/R1').averageScore = 99.5;
    await assert.rejects(f.service.send(input, { email: 'admin@example.com' }), /changed/);
    f.records.get('events/APCS2026').videoPenaltyConfig = { revision: 2 };
    await assert.rejects(f.preview(), /Sync Awards/);
    assert.equal(f.messages.length, 0);
});

test('RESULT EMAILS: missing performer email never falls back to registration contact', async () => {
    const f = fixture();
    f.records.get('Registrants2025/R1').performers[0].email = '';
    assert.match((await f.preview()).recipients[0].problem, /email/);
    await assert.rejects(f.send(), /email/);
    assert.equal(f.messages.length, 0);
});

test('RESULT EMAILS: wrong comment-sheet name and duplicate performer names are rejected', async () => {
    const f = fixture(); Object.assign(f.records.get('Registrants2025/R1'), { finalAward: 'Fail', averageScore: 70 });
    const input = f.payload((await f.preview('nonQualifier')).recipients[0]);
    input.attachment.filename = 'Bob Example.pdf';
    await assert.rejects(f.service.send(input, { email: 'admin@example.com' }), /match/);
    f.records.get('Registrants2025/R1').performers[1].fullName = 'Alice Example';
    await assert.rejects(f.send(0, 'nonQualifier'), /Duplicate/);
    assert.equal(f.messages.length, 0);
});

test('RESULT EMAILS: manual PDF selection sends only the chosen duplicate-name performer', async () => {
    const f = fixture();
    Object.assign(f.records.get('Registrants2025/R1'), { finalAward: 'Fail', averageScore: 70 });
    f.records.get('Registrants2025/R1').performers[1].fullName = 'Alice Example';
    const recipient = (await f.preview('nonQualifier')).recipients[0];
    const input = { ...f.payload(recipient), manualAttachmentSelection: true };
    input.attachment.filename = 'Wrong Name.pdf';
    await assert.rejects(f.service.send(input, { email: 'admin@example.com' }), /match/);
    input.attachment.filename = 'Alice Example.pdf';
    assert.equal((await f.service.send(input, { email: 'admin@example.com' })).status, 'sent');
    assert.deepEqual(f.messages.map(message => message.to), ['alice@example.com']);
    assert.equal((await f.service.send(input, { email: 'admin@example.com' })).status, 'alreadySent');
    const preview = await f.preview('nonQualifier');
    assert.deepEqual(preview.recipients.map(item => item.deliveryStatus), ['sent', 'pending']);
});

test('RESULT EMAILS: overlapping sends and successful retries cannot send twice', async () => {
    const f = fixture();
    const input = f.payload((await f.preview()).recipients[0]);
    const outcomes = await Promise.all([f.service.send(input, { email: 'admin@example.com' }),
        f.service.send(input, { email: 'admin@example.com' })]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'sent').length, 1);
    assert.equal(f.messages.length, 1);
    assert.equal((await f.send()).status, 'alreadySent');
    assert.equal((await f.preview()).recipients[0].deliveryStatus, 'sent');
});

test('RESULT EMAILS: rejected recipients remain retryable without duplicating successful performers', async () => {
    let rejected = true;
    const f = fixture(message => {
        if (message.to === 'bob@example.com' && rejected) {
            const error = new Error('Rejected'); error.responseCode = 550; throw error;
        }
        return { accepted: [message.to] };
    });
    assert.equal((await f.send(0)).status, 'sent');
    assert.equal((await f.send(1)).status, 'failed');
    rejected = false;
    assert.equal((await f.send(0)).status, 'alreadySent');
    assert.equal((await f.send(1)).status, 'sent');
    assert.equal(f.messages.filter(message => message.to === 'alice@example.com').length, 1);
});

test('RESULT EMAILS: uncertain SMTP outcome is preserved and blocks automatic resend', async () => {
    const f = fixture(() => { const error = new Error('Connection lost'); error.code = 'ETIMEDOUT'; throw error; });
    assert.equal((await f.send()).status, 'uncertain');
    assert.equal((await f.send()).status, 'uncertain');
    assert.equal(f.messages.length, 1);
});

test('RESULT EMAILS: SMTP acceptance followed by tracking failure stays blocked from resend', async () => {
    const f = fixture();
    const set = f.records.set.bind(f.records);
    f.records.set = (key, value) => {
        if (value.status === 'sent') throw new Error('Firestore unavailable after SMTP acceptance');
        return set(key, value);
    };
    assert.equal((await f.send()).status, 'uncertain');
    assert.equal((await f.preview()).recipients[0].deliveryStatus, 'sending');
    assert.equal((await f.send()).status, 'uncertain');
    assert.equal(f.messages.length, 1);
});

test('RESULT EMAILS: a nonaccepted SMTP recipient is recorded as failed, never sent', async () => {
    const f = fixture(() => ({ accepted: [], rejected: ['alice@example.com'] }));
    assert.equal((await f.send()).status, 'failed');
    assert.equal((await f.preview()).recipients[0].deliveryStatus, 'failed');
});

test('RESULT EMAILS: invalid PDF, payload size, filename path and missing dates fail before SMTP', async () => {
    const f = fixture();
    const input = f.payload((await f.preview()).recipients[0]);
    for (const patch of [
        { dates: { confirmationDeadline: '[Confirmation Deadline]', rundownReleaseDate: '7 November' } },
        { dates: {} },
        { attachment: { filename: 'bad.pdf', base64: Buffer.from('not a PDF').toString('base64') } },
        { attachment: { ...input.attachment, filename: '../Alice.pdf' } },
        { attachment: { filename: 'too-large.pdf', base64: 'A'.repeat(6000000) } },
        { eventId: 'APCS2025' },
    ]) await assert.rejects(f.service.send({ ...input, ...patch }, { email: 'admin@example.com' }));
    assert.equal(f.messages.length, 0);
});

for (const kind of ['winner', 'nonQualifier']) {
    test(`RESULT EMAILS: ${kind} dummy test is fixed to Gmail with fictional data and exactly one PDF`, async () => {
        const f = fixture();
        await f.service.test({ kind, to: 'real-client@example.com', name: 'Real Student' });
        assert.equal(f.messages[0].to, content.TEST_EMAIL);
        assert.match(f.messages[0].subject, /^\[TEST\]/);
        assert.match(f.messages[0].text, /Dear Alex Example,/);
        if (kind === 'winner') {
            assert.match(f.messages[0].text, /no later than 12 October 2026/);
            assert.match(f.messages[0].text, /shared on 19 October 2026/);
        }
        assert.match(f.messages[0].html, /alt="APCS Logo"/);
        assert.match(f.messages[0].html, /font-family: -apple-system, BlinkMacSystemFont/);
        assert.match(f.messages[0].html, /class="footer"/);
        assert.match(f.messages[0].html, new RegExp(`&copy; ${new Date().getFullYear()} APCS Music`));
        assert.equal(f.messages[0].attachments.length, 1);
        assert.match(f.messages[0].attachments[0].content.toString(), /DUMMY/);
        assert.equal([...f.records.keys()].filter(key => key.startsWith('scoringResultEmailDeliveries/')).length, 0);
    });
}

test('RESULT EMAILS: templates escape HTML in names and dates', () => {
    const result = content.template('winner', { name: '<img src=x>', award: 'Gold' },
        { confirmationDeadline: '<script>x</script>', rundownReleaseDate: '7 November' });
    assert.doesNotMatch(result.html, /<img src=x|<script/);
    assert.match(result.html, /&lt;img/);
    assert.match(result.html, /&lt;script&gt;x&lt;\/script&gt;/);
});

test('RESULT EMAILS: route authenticates before parsing PDFs and rules exclude backend delivery records', () => {
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/ScoringResultEmailRoute.js'), 'utf8');
    assert.ok(route.indexOf('router.use(requireTicketingAdmin)') < route.indexOf('router.use(express.json'));
    const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    assert.ok(index.indexOf("app.use('/api/v1/apcs/scoring-result-emails'") < index.indexOf('app.use(bodyParser.json'));
    const rules = fs.readFileSync(path.join(__dirname, '../../apcs_web/firestore.rules'), 'utf8');
    assert.match(rules, /collection != 'scoringResultEmailDeliveries'/);
});
