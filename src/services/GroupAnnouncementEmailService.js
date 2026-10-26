const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');
const { getTemplate } = require('./EmailTemplateService');
const { escapeHtml } = require('./OrchestraEmailDetails');
const config = require('../configs/groupAnnouncementEmailConfig');
const { createHash } = require('node:crypto');
const { createCampaignService, recipientsHash, hash } = require('./GroupAnnouncementCampaignService');

const PDF_FILENAME = 'Program Notes - Fixed.pdf';
const DUMMY_EMAIL = 'renaldolouis555@gmail.com';
const TEST_ONLY_SHA256 = 'ac63e77c69d9c3b43bf56f4b5fc93a4488addf45c8d5afb657dd75984f36e94c';
const validEmail = value => typeof value === 'string' && value.length <= 254
    && /^[^\s@<>,;\x00-\x1f]+@[^\s@<>,;\x00-\x1f]+\.[^\s@<>,;\x00-\x1f]+$/.test(value);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,199}$/.test(value);
const performerName = performer => String(performer?.fullName
    || `${performer?.firstName || ''} ${performer?.lastName || ''}`.trim()).trim();
const emptyAttendanceSummary = () => ({ total: 0, attending: 0, notAttending: 0, notImported: 0, unavailable: 0 });
const countAttendance = (summary, registration) => {
    summary.total += 1;
    const key = !registration ? 'unavailable' : registration.willAttend === true ? 'attending'
        : registration.willAttend === false ? 'notAttending' : 'notImported';
    summary[key] += 1;
};

function announcementMessage(name) {
    const subject = 'APCS The Sound of Asia 2026 – Finale Orchestra Rundown';
    const paragraphs = [name ? `Dear ${name},` : 'Hello,', 'Thank you for confirming your participation in the APCS Stage!',
        'Please find attached the rundown for APCS The Sound of Asia 2026 – Finale Orchestra, taking place on 14–15 November 2026 at Titan Center, Bintaro.',
        'We look forward to welcoming you and celebrating your achievements at the APCS Gala Concert 2026!',
        'Best regards,\nAPCS Team'];
    return { subject, text: paragraphs.join('\n\n'), html: getTemplate('brandedMessage', {
        title: escapeHtml(subject),
        content: (name ? `<p>Dear <strong>${escapeHtml(name)}</strong>,</p>` : '<p>Hello,</p>')
            + paragraphs.slice(1).map(value => {
                const html = escapeHtml(value).replace(/\n/g, '<br>')
                    .replace('14–15 November 2026', '<strong>14–15 November 2026</strong>')
                    .replace('Titan Center, Bintaro', '<strong>Titan Center, Bintaro</strong>')
                    .replace('APCS Team', '<strong>APCS Team</strong>');
                return `<p>${html}</p>`;
            }).join(''),
    }) };
}

function resolveArtifact() {
    const approved = config.clientAttachment;
    const filename = approved?.filename || PDF_FILENAME;
    if (typeof filename !== 'string' || path.basename(filename) !== filename || !/\.pdf$/i.test(filename)
        || /[\x00-\x1f]/.test(filename)) throw new AppError('The configured PDF filename is invalid.', 503);
    let content;
    try { content = fs.readFileSync(path.join(__dirname, 'attachments', filename)); }
    catch (_) { throw new AppError('The configured program notes PDF is unavailable.', 503); }
    if (content.length > 8 * 1024 * 1024 || content.subarray(0, 5).toString() !== '%PDF-'
        || !content.subarray(-2048).toString().includes('%%EOF')) throw new AppError('The configured program notes PDF is invalid or exceeds 8 MB.', 503);
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (approved && (!/^[a-f0-9]{64}$/.test(approved.sha256 || '') || approved.sha256 !== sha256 || sha256 === TEST_ONLY_SHA256)) {
        throw new AppError('The client PDF checksum is invalid or still identifies the test-only 2025 document.', 503);
    }
    const approvedForBulk = Boolean(approved);
    const attachment = { filename, content, contentType: 'application/pdf' };
    return { attachment, sha256, approvedForBulk,
        revision: hash({ template: announcementMessage('[Performer Name]'), filename, sha256, approvedForBulk }) };
}

function createService({ db, sendMail, resolveArtifact: artifactResolver = resolveArtifact, workerEnabled = false, ...dependencies }) {
    async function eventFor(eventId) {
        if (!validId(eventId)) throw new AppError('Select a valid event.', 400);
        if (eventId !== 'APCS2026') throw new AppError('This finale orchestra announcement is only for APCS2026.', 400);
        const event = await db.collection('events').doc(eventId).get();
        if (!event.exists) throw new AppError('Event not found.', 404);
        return event.data();
    }

    async function readRecipients({ eventId }) {
        const event = await eventFor(eventId);
        const state = event.competitionScheduleState;
        const status = state?.status || 'legacy';
        const recipients = [];
        const skipped = [];
        const attendanceSummary = emptyAttendanceSummary();
        // Only persisted public performance assignments qualify. Draft/attendance membership never does.
        if ((!state || ['published', 'ready'].includes(status)) && !state?.resetInProgress) {
            const saved = await db.collection('sessionAssignments').doc(eventId).get();
            const assignments = saved.data()?.assignments || {};
            const attendanceOnly = new Set(saved.data()?.attendanceOnlyRegistrantIds || []);
            const members = new Map();
            for (const venue of event.venues || []) {
                for (const [date, times] of Object.entries(venue.sessions || {})) {
                    for (const time of times) {
                        const key = `${venue.id}_${date}_${time}`;
                        for (const entry of assignments[key] || []) {
                            if (!validId(entry.registrantId) || attendanceOnly.has(entry.registrantId)) continue;
                            const existing = members.get(entry.registrantId) || { entries: [], groups: [] };
                            existing.entries.push(entry);
                            existing.groups.push(`${venue.label || venue.id} / ${date} / ${time} WIB`);
                            members.set(entry.registrantId, existing);
                        }
                    }
                }
            }
            const entries = [...members];
            for (let index = 0; index < entries.length; index += 6) {
                const rows = await Promise.all(entries.slice(index, index + 6).map(async ([registrantId, member]) => {
                    const snapshot = await db.collection('Registrants2025').doc(registrantId).get();
                    const registration = snapshot.data();
                    const source = registration?.eventId || 'APCS2025';
                    const allowed = source === eventId || (eventId === 'APCS2026' && source === 'APCS2025'
                        && member.entries.every(entry => entry.sourceEventId === source));
                    countAttendance(attendanceSummary, snapshot.exists && allowed ? registration : null);
                    if (!snapshot.exists || !allowed) return { skipped: [{ registrantId, reason: 'Missing registration or source event mismatch.' }] };
                    const contacts = new Map();
                    const invalid = [];
                    for (const [performerIndex, performer] of (registration.performers || []).entries()) {
                        const name = performerName(performer);
                        const email = typeof performer?.email === 'string' ? performer.email.trim() : '';
                        if (!name || !validEmail(email)) {
                            invalid.push({ registrantId, reason: `Performer ${performerIndex + 1} is missing a name or valid email.` });
                            continue;
                        }
                        const normalized = email.toLowerCase();
                        const contact = contacts.get(normalized) || { key: `${registrantId}:${normalized}`, registrantId,
                            email, names: [], groups: [...new Set(member.groups)] };
                        contact.names.push(name);
                        contacts.set(normalized, contact);
                    }
                    if (!(registration.performers || []).length) invalid.push({ registrantId, reason: 'No performer contacts.' });
                    return { recipients: [...contacts.values()].map(row => ({ ...row, name: [...new Set(row.names)].join(', ') })), skipped: invalid };
                }));
                for (const row of rows) { recipients.push(...(row.recipients || [])); skipped.push(...(row.skipped || [])); }
            }
        }
        return { eventId, status, recipients, skipped, attendanceSummary };
    }

    async function currentAttendanceForSnapshot(eventId, recipients) {
        const summary = emptyAttendanceSummary();
        const ids = [...new Set(recipients.map(recipient => recipient.registrantId))];
        for (let index = 0; index < ids.length; index += 6) {
            const registrations = await Promise.all(ids.slice(index, index + 6).map(async id => {
                if (!validId(id)) return null;
                const snapshot = await db.collection('Registrants2025').doc(id).get();
                const registration = snapshot.data();
                const source = registration?.eventId || 'APCS2025';
                return snapshot.exists && (source === eventId || (eventId === 'APCS2026' && source === 'APCS2025'))
                    ? registration : null;
            }));
            registrations.forEach(registration => countAttendance(summary, registration));
        }
        return summary;
    }

    const campaigns = createCampaignService({ db, sendMail, resolveArtifact: artifactResolver, readRecipients,
        renderMessage: announcementMessage, workerEnabled, ...dependencies });

    async function preview({ eventId }) {
        if (!validId(eventId)) throw new AppError('Select a valid event.', 400);
        if (eventId !== 'APCS2026') throw new AppError('This finale orchestra announcement is only for APCS2026.', 400);
        const artifact = artifactResolver();
        const current = await campaigns.status({ eventId, revision: artifact.revision });
        const latest = await campaigns.latest(eventId);
        const source = current.total ? { eventId, status: 'saved campaign',
            recipients: await campaigns.snapshotRecipients(current.id), skipped: [] } : await readRecipients({ eventId });
        if (current.total) source.attendanceSummary = await currentAttendanceForSnapshot(eventId, source.recipients);
        const dummyAccepted = current.dummyTest?.revision === artifact.revision;
        const otherActive = latest && latest.id !== current.id && latest.total > latest.processed;
        const bulkEnabled = workerEnabled && artifact.approvedForBulk && dummyAccepted && !otherActive
            && (!current.total || current.status === 'blocked') && source.recipients.length > 0 && !source.skipped.length;
        return { ...source, draft: false, bulkEnabled, workerEnabled, dummyAccepted, resendRecipientOverrideEnabled: true,
            sendToAddressEnabled: true, generalMessage: announcementMessage(), revision: artifact.revision,
            recipientsHash: recipientsHash(source.recipients), campaign: latest || current, currentCampaign: current,
            recipientSource: current.total ? 'saved_campaign' : 'published_assignments', dummyEmail: DUMMY_EMAIL,
            message: announcementMessage('Alex Example'),
            attachment: { filename: artifact.attachment.filename, available: true, testOnly: !artifact.approvedForBulk,
                warning: artifact.approvedForBulk ? null : 'This supplied PDF contains the 2025 event at Jakarta Intercultural School. It is restricted to dummy testing.',
                sha256: artifact.sha256, base64: artifact.attachment.content.toString('base64') } };
    }

    async function test({ eventId }, actor) {
        await eventFor(eventId);
        const artifact = artifactResolver();
        // Tests use fictional personalization and never look up or send to registrant contacts.
        const result = await sendMail({ from: '"APCS Music" <hello@apcsmusic.com>', to: DUMMY_EMAIL,
            ...announcementMessage('Alex Example'), attachments: [artifact.attachment] });
        if (!result?.accepted?.some(email => String(email).toLowerCase() === DUMMY_EMAIL) || result.rejected?.length) {
            throw new AppError('Test delivery was not confirmed. Check the mailbox/provider before retrying.', 502);
        }
        const campaign = await campaigns.recordDummy(eventId, artifact, actor);
        return { eventId, recipientEmail: DUMMY_EMAIL, accepted: true, revision: artifact.revision, campaign };
    }

    return { preview, test, send: campaigns.start, resend: campaigns.resend, sendToAddress: campaigns.sendToAddress,
        status: campaigns.status, processDue: campaigns.processDue, campaigns };
}

module.exports = { createService, announcementMessage, resolveArtifact, DUMMY_EMAIL, TEST_ONLY_SHA256 };
