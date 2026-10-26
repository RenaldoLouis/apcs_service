const { createHash, randomUUID } = require('node:crypto');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');

const COLLECTION = 'groupAnnouncementCampaigns';
const CHUNK_SIZE = 100;
const LEASE_MS = 180000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const campaignId = (eventId, revision) => hash([eventId, revision]);
const recipientsHash = recipients => hash([...recipients].sort((a, b) => a.key.localeCompare(b.key)));
const ordinalId = value => String(value).padStart(6, '0');
const isSingleRecipientEmail = value => {
    if (typeof value !== 'string' || value.length > 254) return false;
    const parts = value.split('@');
    if (parts.length !== 2) return false;
    const [local, domain] = parts;
    if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')
        || !/^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.\-]+$/.test(local)) return false;
    const labels = domain.split('.');
    return labels.length >= 2 && labels.every(label => label.length <= 63
        && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label));
};

function createCampaignService({ db, resolveArtifact, readRecipients, renderMessage, sendMail,
    workerEnabled = false, now = Date.now, uuid = randomUUID, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const refFor = id => db.collection(COLLECTION).doc(id);
    const view = (id, data = {}) => ({ id, eventId: data.eventId || 'APCS2026', revision: data.revision || null,
        status: data.status || 'not_started', total: data.total || 0, processed: data.cursor || 0,
        accepted: data.accepted || 0, failed: data.failed || 0, uncertain: data.uncertain || 0,
        issues: data.issues || [], reason: data.reason || null, dummyTest: data.dummyTest || null });

    async function latest(eventId) {
        const pointer = (await refFor(eventId).get()).data();
        if (!pointer?.latestCampaignId) return null;
        const snapshot = await refFor(pointer.latestCampaignId).get();
        return snapshot.exists ? view(snapshot.id, snapshot.data()) : null;
    }

    async function snapshotRecipients(id) {
        const chunks = await refFor(id).collection('chunks').get();
        return chunks.docs.sort((a, b) => a.id.localeCompare(b.id)).flatMap(chunk => chunk.data().recipients);
    }

    async function status({ eventId, revision }) {
        if (eventId !== 'APCS2026') throw new AppError('Invalid campaign event.', 400);
        if (revision === undefined) return latest(eventId);
        if (!/^[a-f0-9]{64}$/.test(revision || '')) throw new AppError('Invalid campaign version.', 400);
        const id = campaignId(eventId, revision);
        const snapshot = await refFor(id).get();
        return view(id, snapshot.data());
    }

    async function recordDummy(eventId, artifact, actor) {
        const id = campaignId(eventId, artifact.revision);
        const ref = refFor(id);
        await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);
            transaction.set(ref, { eventId, revision: artifact.revision,
                ...(!snapshot.exists ? { status: 'tested', runnable: false } : {}),
                dummyTest: { revision: artifact.revision, acceptedAt: now(), recipientEmail: 'renaldolouis555@gmail.com',
                    approvedForBulk: artifact.approvedForBulk, actorUid: actor?.uid || null }, updatedAt: now() }, { merge: true });
        });
        return status({ eventId, revision: artifact.revision });
    }

    async function start(input, actor) {
        const { eventId, revision, expectedRecipientsHash, confirmed } = input;
        if (!actor?.uid || eventId !== 'APCS2026' || confirmed !== true) throw new AppError('Confirm this APCS2026 campaign as signed-in staff.', 400);
        if (!workerEnabled) throw new AppError('The background email worker is not enabled on this server.', 409);
        const artifact = resolveArtifact();
        if (!artifact.approvedForBulk) throw new AppError('The current PDF is approved for dummy testing only. Install the final client PDF first.', 409);
        if (revision !== artifact.revision) throw new AppError('Email or PDF changed. Refresh and send a new dummy test.', 409);
        const id = campaignId(eventId, revision);
        const ref = refFor(id);
        const existing = await ref.get();
        // Stable identity makes a lost response, double click or second browser reuse this campaign.
        if (existing.data()?.total) {
            if (existing.data().status === 'blocked') {
                if (expectedRecipientsHash !== existing.data().recipientsHash) throw new AppError('Refresh to review the saved campaign recipients before resuming.', 409);
                await db.runTransaction(async transaction => {
                    const current = (await transaction.get(ref)).data();
                    if (current?.status === 'blocked') transaction.update(ref, { status: 'queued', runnable: true, reason: null, updatedAt: now() });
                });
            }
            return status({ eventId, revision });
        }
        const source = await readRecipients({ eventId });
        const recipients = [...source.recipients].sort((a, b) => a.key.localeCompare(b.key));
        if (source.skipped.length) throw new AppError('Resolve every contact issue before starting this campaign.', 409);
        if (!recipients.length) throw new AppError('There are no eligible published competition contacts.', 409);
        if (recipientsHash(recipients) !== expectedRecipientsHash) throw new AppError('Published recipients changed. Refresh and review the new list.', 409);
        if (recipients.length > 10000 || Buffer.byteLength(JSON.stringify(recipients)) > 8 * 1024 * 1024) {
            throw new AppError('This campaign exceeds the supported snapshot size. Contact the administrator before sending.', 400);
        }
        const chunks = [];
        for (let index = 0; index < recipients.length; index += CHUNK_SIZE) {
            const rows = recipients.slice(index, index + CHUNK_SIZE);
            if (Buffer.byteLength(JSON.stringify(rows)) > 700000) throw new AppError('Recipient details exceed the snapshot size limit.', 400);
            chunks.push(rows);
        }
        await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);
            const previous = snapshot.data() || {};
            const pointerRef = refFor(eventId);
            const pointer = (await transaction.get(pointerRef)).data();
            if (pointer?.latestCampaignId && pointer.latestCampaignId !== id) {
                const active = (await transaction.get(refFor(pointer.latestCampaignId))).data();
                if (active?.total && active.cursor < active.total) throw new AppError('Finish or review the existing campaign before starting a different email version.', 409);
            }
            if (previous.total) {
                if (previous.status === 'blocked') transaction.update(ref, { status: 'queued', runnable: true, reason: null, updatedAt: now() });
                return;
            }
            if (previous.dummyTest?.revision !== revision || previous.dummyTest.approvedForBulk !== true) {
                throw new AppError('Send a successful dummy test of this exact client PDF and email before bulk delivery.', 409);
            }
            transaction.set(ref, { ...previous, eventId, revision, status: 'queued', runnable: true,
                total: recipients.length, cursor: 0, accepted: 0, failed: 0, uncertain: 0, issues: [],
                inFlight: null, nextAttemptAt: 0, recipientsHash: expectedRecipientsHash,
                attachment: { filename: artifact.attachment.filename, sha256: artifact.sha256 },
                createdAt: now(), updatedAt: now(), createdByUid: actor.uid });
            transaction.set(pointerRef, { kind: 'event_pointer', latestCampaignId: id, runnable: false, updatedAt: now() });
            chunks.forEach((rows, index) => transaction.set(ref.collection('chunks').doc(ordinalId(index)), { recipients: rows }));
        });
        return status({ eventId, revision });
    }

    async function block(ref, revision, reason) {
        await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);
            const data = snapshot.data();
            if (data?.revision === revision && data.runnable && !data.inFlight) {
                transaction.update(ref, { status: 'blocked', runnable: false, reason, updatedAt: now() });
            }
        });
    }

    async function sendSingle({ eventId, revision, recipientKey, requestId, confirmed, recipientEmail }, actor, general = false) {
        if (!actor?.uid || eventId !== 'APCS2026' || confirmed !== true
            || !/^[a-f0-9]{64}$/.test(revision || '') || (!general && typeof recipientKey !== 'string')
            || !/^[a-f0-9-]{36}$/i.test(requestId || '')) {
            throw new AppError('Confirm one email recipient as signed-in staff.', 400);
        }
        if (!workerEnabled) throw new AppError('Client email delivery is not enabled on this server.', 409);
        const artifact = resolveArtifact();
        if (!artifact.approvedForBulk || artifact.revision !== revision) {
            throw new AppError('The approved email/PDF changed. Refresh before resending.', 409);
        }
        const id = campaignId(eventId, revision);
        const ref = refFor(id);
        // Personalized resends resolve the saved row. General sends require only one validated address.
        const recipient = general ? null : (await snapshotRecipients(id)).find(row => row.key === recipientKey);
        if (!general && !recipient) throw new AppError('Select a recipient from the saved campaign.', 404);
        const targetEmail = !general && recipientEmail === undefined ? recipient.email
            : typeof recipientEmail === 'string' ? recipientEmail.trim() : '';
        if (!isSingleRecipientEmail(targetEmail)) throw new AppError('Enter one valid email address.', 400);
        const recipientEmailHash = hash(targetEmail.toLowerCase());
        if (general) recipientKey = `general:${recipientEmailHash}`;
        const attemptRef = ref.collection('resends').doc(requestId);
        const lockRef = ref.collection('resends').doc(`recipient_${hash(recipientKey)}`);
        const resultView = data => ({ eventId, revision, recipientKey, requestId, recipientEmail: targetEmail,
            status: data.status, accepted: data.status === 'accepted' });
        const claim = await db.runTransaction(async transaction => {
            const campaign = (await transaction.get(ref)).data();
            const existing = (await transaction.get(attemptRef)).data();
            const lock = (await transaction.get(lockRef)).data();
            const pointer = general ? (await transaction.get(refFor(eventId))).data() : null;
            const otherCampaign = pointer?.latestCampaignId && pointer.latestCampaignId !== id
                ? (await transaction.get(refFor(pointer.latestCampaignId))).data() : null;
            if (existing) {
                if (existing.recipientKey !== recipientKey) throw new AppError('This resend request belongs to another recipient.', 409);
                if ((existing.recipientEmailHash || (recipient ? hash(recipient.email.toLowerCase()) : null)) !== recipientEmailHash) {
                    throw new AppError('This resend request belongs to a different email address. Check its delivery before starting another resend.', 409);
                }
                return { existing };
            }
            const campaignReady = general
                ? ['tested', 'completed', 'completed_with_issues'].includes(campaign?.status)
                    && !(otherCampaign?.total > (otherCampaign?.cursor || 0))
                : campaign?.total > 0 && campaign.cursor === campaign.total
                    && ['completed', 'completed_with_issues'].includes(campaign.status);
            if (!campaignReady || campaign.inFlight || campaign.runnable) {
                throw new AppError('Wait for the saved campaign to finish before resending individually.', 409);
            }
            if (campaign.dummyTest?.revision !== revision || campaign.dummyTest.approvedForBulk !== true) {
                throw new AppError('A successful dummy test of this exact client email/PDF is required.', 409);
            }
            if (lock?.leaseUntil > now()) {
                throw new AppError('A resend was recently started for this recipient. Check delivery and wait three minutes before another resend.', 409);
            }
            const attempt = { recipientKey, requestId,
                ...(general ? { kind: 'general' } : { registrantId: recipient.registrantId, name: recipient.name, email: recipient.email }),
                recipientEmailHash, status: 'sending', actorUid: actor.uid, startedAt: now(),
                attachment: { filename: artifact.attachment.filename, sha256: artifact.sha256 } };
            transaction.set(attemptRef, attempt);
            transaction.set(lockRef, { recipientKey, requestId, leaseUntil: now() + LEASE_MS });
            return { attempt };
        });
        // A repeated HTTP request can only read its original outcome, even after a server restart.
        if (claim.existing) return resultView(claim.existing);
        let outcome = 'uncertain';
        try {
            const result = await sendMail({ from: '"APCS Music" <hello@apcsmusic.com>', to: targetEmail,
                ...renderMessage(general ? undefined : recipient.name), attachments: [artifact.attachment],
                messageId: `<apcs-group-resend-${id}-${requestId}@apcsmusic.com>` });
            if (result?.accepted?.some(email => String(email).toLowerCase() === targetEmail.toLowerCase())
                && !result.rejected?.length) outcome = 'accepted';
            else if (result?.rejected?.length && !result.accepted?.length) outcome = 'failed';
        } catch (_) { /* SMTP may have accepted the message. Never automatically retry. */ }
        await db.runTransaction(async transaction => {
            const current = (await transaction.get(attemptRef)).data();
            if (current?.status === 'sending') transaction.update(attemptRef, { status: outcome, finishedAt: now() });
        });
        return resultView({ status: outcome });
    }

    const resend = (input, actor) => sendSingle(input, actor);
    const sendToAddress = (input, actor) => sendSingle(input, actor, true);

    async function processOne(id) {
        if (!workerEnabled) return { idle: true };
        const ref = refFor(id);
        const before = (await ref.get()).data();
        if (!before?.runnable) return { idle: true };
        let artifact;
        try { artifact = resolveArtifact(); } catch (_) { /* Keep the durable campaign paused if its file is unavailable. */ }
        if (!artifact?.approvedForBulk || artifact.revision !== before.revision) {
            // An expired send still needs recovery before pausing for a changed artifact.
            if (!before.inFlight) {
                await block(ref, before.revision, 'The exact approved email/PDF version is unavailable. Restore it before resuming.');
                return { blocked: true };
            }
        }
        const claim = await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);
            const data = snapshot.data();
            if (!data?.runnable || data.nextAttemptAt > now()) return null;
            if (data.inFlight) {
                if (data.inFlight.leaseUntil > now()) return null;
                const flight = data.inFlight;
                const next = data.cursor + 1;
                const issue = { email: flight.email, name: flight.name, status: 'uncertain',
                    reason: 'Worker stopped before its send result was saved. Check the provider before any resend.' };
                transaction.set(ref.collection('deliveries').doc(ordinalId(data.cursor)), {
                    ...flight, status: 'uncertain', finishedAt: now(), reason: issue.reason }, { merge: true });
                transaction.update(ref, { cursor: next, uncertain: data.uncertain + 1,
                    issues: [...data.issues, issue].slice(-20), inFlight: null, nextAttemptAt: now() + 1000,
                    status: next === data.total ? 'completed_with_issues' : 'queued', runnable: next < data.total, updatedAt: now() });
                return { recovered: true };
            }
            if (!artifact?.approvedForBulk || artifact.revision !== data.revision) return null;
            const chunk = await transaction.get(ref.collection('chunks').doc(ordinalId(Math.floor(data.cursor / CHUNK_SIZE))));
            const recipient = chunk.data()?.recipients?.[data.cursor % CHUNK_SIZE];
            if (!recipient) throw new Error('Campaign snapshot is incomplete.');
            const flight = { ordinal: data.cursor, email: recipient.email, name: recipient.name,
                attemptId: uuid(), startedAt: now(), leaseUntil: now() + LEASE_MS };
            transaction.set(ref.collection('deliveries').doc(ordinalId(data.cursor)), { ...recipient, ...flight, status: 'sending' });
            transaction.update(ref, { status: 'running', inFlight: flight, updatedAt: now() });
            return { flight, recipient, revision: data.revision };
        });
        if (!claim) return { idle: true };
        if (claim.recovered) return { recovered: true };
        let outcome = 'uncertain';
        let reason = 'SMTP outcome is uncertain. Check the provider before any resend.';
        try {
            const result = await sendMail({ from: '"APCS Music" <hello@apcsmusic.com>', to: claim.recipient.email,
                ...renderMessage(claim.recipient.name), attachments: [artifact.attachment],
                messageId: `<apcs-group-${id}-${claim.flight.ordinal}@apcsmusic.com>` });
            if (result?.accepted?.some(email => String(email).toLowerCase() === claim.recipient.email.toLowerCase())
                && !result.rejected?.length) { outcome = 'accepted'; reason = null; }
            else if (result?.rejected?.length && !result.accepted?.length) {
                outcome = 'failed'; reason = 'The mail server rejected this address.';
            }
        } catch (_) { /* A transport error can follow acceptance; never retry it automatically. */ }
        const saved = await db.runTransaction(async transaction => {
            const snapshot = await transaction.get(ref);
            const data = snapshot.data();
            if (data?.inFlight?.attemptId !== claim.flight.attemptId || data.cursor !== claim.flight.ordinal) return false;
            const next = data.cursor + 1;
            const issues = reason ? [...data.issues, { email: claim.recipient.email, name: claim.recipient.name, status: outcome, reason }].slice(-20) : data.issues;
            const failed = data.failed + (outcome === 'failed' ? 1 : 0);
            const uncertain = data.uncertain + (outcome === 'uncertain' ? 1 : 0);
            transaction.update(ref.collection('deliveries').doc(ordinalId(data.cursor)), { status: outcome, reason, finishedAt: now() });
            transaction.update(ref, { cursor: next, [outcome]: data[outcome] + 1, issues,
                inFlight: null, nextAttemptAt: now() + 1000, runnable: next < data.total,
                status: next === data.total ? (failed || uncertain ? 'completed_with_issues' : 'completed') : 'queued', updatedAt: now() });
            return true;
        });
        return { attempted: true, saved, outcome };
    }

    async function processDue() {
        if (!workerEnabled) return;
        const snapshot = await db.collection(COLLECTION).where('runnable', '==', true).limit(5).get();
        for (const campaign of snapshot.docs) {
            for (let index = 0; index < 10; index += 1) {
                const result = await processOne(campaign.id);
                if (result.idle || result.blocked) break;
                await pause(1100);
            }
        }
    }
    return { status, latest, snapshotRecipients, recordDummy, start, resend, sendToAddress, processOne, processDue, workerEnabled };
}

module.exports = { createCampaignService, recipientsHash, campaignId, hash, LEASE_MS };
