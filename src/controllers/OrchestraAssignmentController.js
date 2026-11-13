const repository = require('../repositories/OrchestraAssignmentRepository');
const emailService = require('../services/EmailService');
const { db } = require('../configs/firebase-init');
const { createOrchestraSessionImporter } = require('../services/OrchestraSessionImport');
const sessionImporter = createOrchestraSessionImporter(repository);

async function notifyGroup(group) {
    const assignment = group.assignment;
    if (!assignment) throw Object.assign(new Error('Save an assignment before sending notifications.'), { statusCode: 409, isOperational: true });
    const failures = [];
    for (const booking of group.bookings.filter(item => assignment.bookingIds.includes(item.id))) {
        const current = await db.collection('orchestraAssignments').doc(group.id).get();
        if (!current.exists || current.data().revision !== assignment.revision) return { failedNotifications: failures, superseded: true };
        if ((current.data().notifiedBookingIds || []).includes(booking.id)) continue;
        let token;
        try {
            token = await repository.claimNotification(group.id, assignment.revision, booking.id);
            if (!token) continue;
            await emailService.sendOrchestraAssignmentEmail(booking, assignment);
            await repository.markNotified(group.id, assignment.revision, booking.id, token);
        } catch (error) {
            failures.push(booking.id);
            if (token) await repository.releaseNotification(group.id, token);
        }
    }
    return { failedNotifications: failures };
}
const list = async (req, res, next) => {
    try { res.json(await repository.listGroups(req.body)); } catch (error) { next(error); }
};
const assign = async (req, res, next) => {
    try {
        const group = await repository.assignGroup(req.body, req.ticketingAdmin);
        res.json({ assignment: group.assignment, ...await notifyGroup(group) });
    } catch (error) { next(error); }
};
const notify = async (req, res, next) => {
    try {
        const group = await repository.readGroup(req.body.eventId, req.body.registrantId);
        res.json(await notifyGroup(group));
    } catch (error) { next(error); }
};
const saveSession = async (req, res, next) => {
    try { res.json({ session: await repository.saveSession(req.body) }); } catch (error) { next(error); }
};
const sessions = async (req, res, next) => {
    try { res.json(await repository.sessionOverview(req.body)); } catch (error) { next(error); }
};
const sessionTiers = async (req, res, next) => {
    try { res.json(await repository.sessionTierBreakdown(req.body)); } catch (error) { next(error); }
};
const previewImport = async (req, res, next) => {
    try { res.json(await sessionImporter.preview(req.body)); } catch (error) { next(error); }
};
const applyImport = async (req, res, next) => {
    try { res.json(await sessionImporter.apply(req.body, req.ticketingAdmin)); } catch (error) { next(error); }
};
module.exports = { sessions, sessionTiers, list, assign, notify, saveSession, previewImport, applyImport };
