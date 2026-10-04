const { randomUUID } = require('node:crypto');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');
const content = require('./ScoringResultEmailContent');

const FROM = '"APCS Music" <hello@apcsmusic.com>';
const WINNING_AWARDS = ['Silver', 'Gold', 'Diamond', 'Sapphire'];
const PREVIEW_READ_CONCURRENCY = 6;

async function mapPreviewReads(items, mapper) {
    const results = [];
    for (let index = 0; index < items.length; index += PREVIEW_READ_CONCURRENCY) {
        results.push(...await Promise.all(items.slice(index, index + PREVIEW_READ_CONCURRENCY).map(mapper)));
    }
    return results;
}

function createService({ db, sendMail, now = Date.now, uuid = randomUUID }) {
    const deliveryRef = (eventId, registrantId, performerIndex, kind) => db.collection('scoringResultEmailDeliveries')
        .doc(content.hash(JSON.stringify([eventId, registrantId, performerIndex, kind])));
    const read = (ref, transaction) => transaction ? transaction.get(ref) : ref.get();

    function validateRequest(input) {
        content.validateKind(input.kind);
        if (input.eventId !== 'APCS2026') throw new AppError('These templates are only for APCS2026.', 400);
    }

    async function getRecipients(eventId, registrantId, kind, transaction) {
        if (typeof registrantId !== 'string' || !registrantId || registrantId.includes('/') || registrantId.length > 200) {
            throw new AppError('Invalid registration ID.', 400);
        }
        const registrantSnapshot = await read(db.collection('Registrants2025').doc(registrantId), transaction);
        if (!registrantSnapshot.exists || registrantSnapshot.data().eventId !== eventId) {
            throw new AppError('Registration does not belong to the selected event.', 400);
        }
        const registrant = registrantSnapshot.data();
        const eventSnapshot = await read(db.collection('events').doc(eventId), transaction);
        if (!eventSnapshot.exists) throw new AppError('Event configuration was not found.', 400);
        const scoresSnapshot = await read(db.collection('JuryScores2025').where('registrantId', '==', registrantId), transaction);
        // Legacy scores do not carry eventId; registration identity remains authoritative.
        const scores = scoresSnapshot.docs.map(doc => doc.data());
        if (!scores.length || scores.some(score => score.isFinalized !== true
            || (score.eventId && score.eventId !== eventId)
            || (score.competitionCategory && score.competitionCategory !== registrant.competitionCategory))) {
            throw new AppError('Every jury result must be finalized for this registration.', 409);
        }
        // Email uses the persisted output of the existing Sync Awards flow.
        const award = registrant.finalAward;
        if (![...WINNING_AWARDS, 'Fail'].includes(award)
            || typeof registrant.averageScore !== 'number' || !Number.isFinite(registrant.averageScore)) {
            throw new AppError('Saved scoring results are missing or invalid. Run Sync Awards and refresh Scoring Recap.', 409);
        }
        const revision = Number(eventSnapshot.data().videoPenaltyConfig?.revision) || null;
        if ((Number(registrant.videoPenaltyConfigRevision) || null) !== revision) {
            throw new AppError('Saved results use an outdated rule revision. Run Sync Awards and refresh Scoring Recap.', 409);
        }
        if (kind === 'winner' ? !WINNING_AWARDS.includes(award) : award !== 'Fail') {
            throw new AppError('The current result no longer belongs to this campaign. Refresh the preview.', 409);
        }
        if (!Array.isArray(registrant.performers) || !registrant.performers.length) {
            throw new AppError('This registration has no performer records.', 400);
        }
        return registrant.performers.map((performer, performerIndex) => {
            const name = content.performerName(performer);
            const email = typeof performer?.email === 'string' ? performer.email.trim() : '';
            const recipient = { registrantId, performerIndex, name, email, award };
            return { ...recipient, performanceCategory: registrant.PerformanceCategory, problem: !name ? 'Missing performer name'
                : !content.validEmail(email) ? 'Missing or invalid performer email' : '',
            snapshot: content.hash(JSON.stringify({ ...recipient, score: registrant.averageScore,
                revision: registrant.videoPenaltyConfigRevision ?? null })) };
        });
    }

    async function preview(input) {
        validateRequest(input);
        if (!Array.isArray(input.registrantIds) || !input.registrantIds.length || input.registrantIds.length > 40
            || new Set(input.registrantIds).size !== input.registrantIds.length) {
            throw new AppError('Preview between 1 and 40 distinct registrations per request.', 400);
        }
        const groups = await mapPreviewReads(input.registrantIds, async registrantId => {
            const group = await getRecipients(input.eventId, registrantId, input.kind);
            return mapPreviewReads(group, async recipient => {
                const delivery = await deliveryRef(input.eventId, registrantId, recipient.performerIndex, input.kind).get();
                return { ...recipient, deliveryStatus: delivery.exists ? delivery.data().status : 'pending' };
            });
        });
        return { recipients: groups.flat() };
    }

    async function send(input, actor) {
        validateRequest(input);
        content.validateDates(input.kind, input.dates);
        if (!Number.isInteger(input.performerIndex) || input.performerIndex < 0) {
            throw new AppError('Invalid performer selection.', 400);
        }
        // Validate PDF before reserving a delivery. Re-check its name with the current performer below.
        const attachment = content.decodePdf(input.attachment);
        const certificate = input.kind === 'nonQualifier'
            ? content.decodePdf(input.certificateAttachment) : null;
        if (certificate?.content.equals(attachment.content)) {
            throw new AppError('Choose a distinct E-certificate and comment sheet PDF.', 400);
        }
        const ref = deliveryRef(input.eventId, input.registrantId, input.performerIndex, input.kind);
        const attemptId = uuid();
        const reservation = await db.runTransaction(async transaction => {
            const recipients = await getRecipients(input.eventId, input.registrantId, input.kind, transaction);
            const recipient = recipients[input.performerIndex];
            if (!recipient || recipient.problem) throw new AppError(recipient?.problem || 'Performer was not found.', 400);
            if (recipient.snapshot !== input.snapshot) throw new AppError('The performer or result changed. Refresh the preview.', 409);
            if (input.kind === 'nonQualifier') {
                if (input.manualAttachmentSelection !== true
                    && recipients.filter(item => content.normalizeName(item.name) === content.normalizeName(recipient.name)).length !== 1) {
                    throw new AppError('Duplicate performer names prevent automatic PDF matching.', 400);
                }
                if (!content.matchesPerformerPdf(attachment.filename, recipient.name, recipient.performanceCategory)) {
                    throw new AppError('The comment sheet PDF filename does not match this performer.', 400);
                }
                if (!content.matchesPerformerPdf(certificate.filename, recipient.name, recipient.performanceCategory)) {
                    throw new AppError('The E-certificate PDF filename does not match this performer.', 400);
                }
            }
            const previous = await transaction.get(ref);
            const status = previous.exists ? previous.data().status : null;
            if (status === 'sent') return { skipped: true, status: 'alreadySent' };
            if (['sending', 'uncertain'].includes(status)) return { skipped: true, status: 'uncertain' };
            const message = content.template(input.kind, recipient, input.dates);
            transaction.set(ref, {
                eventId: input.eventId, registrantId: input.registrantId, performerIndex: input.performerIndex,
                kind: input.kind, name: recipient.name, email: recipient.email, award: recipient.award,
                snapshot: recipient.snapshot, status: 'sending', attemptId, actor: actor.email,
                startedAt: now(), attachmentFilename: attachment.filename,
                attachmentSha256: content.hash(attachment.content), contentSha256: content.hash(message.text),
                ...(certificate ? { certificateFilename: certificate.filename,
                    certificateSha256: content.hash(certificate.content) } : {}),
            });
            return { recipient, message };
        });
        if (reservation.skipped) return { status: reservation.status };

        async function finish(status, extra = {}) {
            await db.runTransaction(async transaction => {
                const current = await transaction.get(ref);
                if (current.data()?.attemptId !== attemptId) throw new Error('Delivery attempt changed.');
                transaction.update(ref, { status, finishedAt: now(), ...extra });
            });
        }
        let info;
        try {
            const attachments = certificate ? [
                { ...certificate, filename: `${reservation.recipient.name} - E-Certificate.pdf` },
                { ...attachment, filename: `${reservation.recipient.name} - Comment Sheet.pdf` },
            ] : [attachment];
            info = await sendMail({ from: FROM, to: reservation.recipient.email,
                ...reservation.message, attachments });
            const accepted = (info?.accepted || []).map(email => String(email).toLowerCase());
            if (!accepted.includes(reservation.recipient.email.toLowerCase())) {
                await finish('failed', { failure: 'Recipient was not accepted by SMTP.' });
                return { status: 'failed', message: 'Recipient was not accepted by SMTP.' };
            }
        } catch (error) {
            // Network failures can occur after acceptance: do not automatically retry those.
            const definiteFailure = ['EAUTH', 'EENVELOPE'].includes(error.code)
                || Number(error.responseCode) >= 400;
            const status = definiteFailure ? 'failed' : 'uncertain';
            await finish(status, { failure: definiteFailure ? 'SMTP rejected this send.' : 'SMTP delivery outcome is uncertain.' });
            return { status, message: definiteFailure ? 'SMTP rejected this send.' : 'Check SMTP delivery before retrying.' };
        }
        // Keep acceptance separate from persistence failure so accepted mail is never marked retryable.
        try {
            await finish('sent', { messageId: info.messageId || '' });
        } catch (error) {
            return { status: 'uncertain', message: 'SMTP accepted the email, but delivery tracking could not be saved.' };
        }
        return { status: 'sent' };
    }

    async function test(input) {
        content.validateKind(input.kind);
        const dates = {
            confirmationDeadline: input.dates?.confirmationDeadline || '12 October 2026',
            rundownReleaseDate: input.dates?.rundownReleaseDate || '19 October 2026',
        };
        const attachment = input.kind === 'winner' && input.attachment
            ? content.decodePdf(input.attachment) : content.dummyPdf(input.kind);
        const attachments = input.kind === 'nonQualifier'
            ? [content.dummyPdf('certificate'), attachment] : [attachment];
        const message = content.template(input.kind, { name: 'Alex Example', award: 'Sapphire' }, dates);
        const info = await sendMail({ from: FROM, to: content.TEST_EMAIL, ...message,
            subject: `[TEST] ${message.subject}`, attachments });
        if (!(info?.accepted || []).some(email => String(email).toLowerCase() === content.TEST_EMAIL)) {
            throw new AppError('SMTP did not accept the test recipient.', 502);
        }
        return { status: 'sent', recipient: content.TEST_EMAIL };
    }

    return { preview, send, test };
}

module.exports = { createService };
