const { db } = require('../configs/firebase-init');
const { logger } = require('../utils/Logger');
const { sendJuryDeadlineReminderEmail } = require('../services/EmailService');

const REMINDER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const startJuryDeadlineReminder = () => {
    setInterval(async () => {
        try {
            const settingsDoc = await db.collection('systemSettings').doc('global').get();
            if (!settingsDoc.exists) return;

            const settings = settingsDoc.data();
            const currentEventId = settings.currentEventId || 'APCS2026';
            const juryDeadlines = settings.juryDeadlines || {};
            const remindersSent = settings.juryDeadlineReminderSent || {};

            const now = new Date();
            let updatedRemindersSent = false;
            const newRemindersSent = { ...remindersSent };

            for (const [category, deadlineStr] of Object.entries(juryDeadlines)) {
                if (!deadlineStr) continue;

                const deadline = new Date(deadlineStr);
                const diffMs = deadline - now;
                const hoursLeft = diffMs / (1000 * 60 * 60);

                let reminderType = null;
                let flagKey = null;
                let timeRemainingText = '';

                // Determine the reminder window
                if (hoursLeft > 0 && hoursLeft <= 24) {
                    reminderType = '24h';
                    timeRemainingText = 'less than 24 hours';
                    flagKey = `${category}_${deadline.getTime()}_24h`;
                    // Backward compatibility: also check the old flag format
                    const oldFlagKey = `${category}_${deadline.getTime()}`;
                    if (newRemindersSent[flagKey] || newRemindersSent[oldFlagKey]) {
                        continue;
                    }
                } else if (hoursLeft > 24 && hoursLeft <= 72) {
                    reminderType = '3d';
                    timeRemainingText = '3 days';
                    flagKey = `${category}_${deadline.getTime()}_3d`;
                    if (newRemindersSent[flagKey]) continue;
                } else if (hoursLeft > 72 && hoursLeft <= 168) {
                    reminderType = '1w';
                    timeRemainingText = '1 week';
                    flagKey = `${category}_${deadline.getTime()}_1w`;
                    if (newRemindersSent[flagKey]) continue;
                } else {
                    continue; // outside of any reminder window
                }

                logger.info(`[JURY-REMINDER] ${timeRemainingText} deadline approaching for ${category}. Processing reminders...`);

                    // 1. Get all jury members for this category
                    const jurySnap = await db.collection('users')
                        .where('role', '==', 'jury')
                        .where('competitionCategory', '==', category)
                        .get();

                    if (jurySnap.empty) {
                        logger.info(`[JURY-REMINDER] No jury members found for ${category}.`);
                        // Still mark as sent so we don't keep querying
                        newRemindersSent[flagKey] = true;
                        updatedRemindersSent = true;
                        continue;
                    }

                    // 2. Get all registrants for this category
                    const registrantsSnap = await db.collection('Registrants2025')
                        .where('eventId', '==', currentEventId)
                        .where('competitionCategory', '==', category)
                        .get();

                    const allRegistrants = registrantsSnap.docs.map(doc => ({
                        id: doc.id,
                        ...doc.data()
                    }));

                    let emailsSent = 0;

                    // 3. Process each jury member
                    for (const juryDoc of jurySnap.docs) {
                        const jury = juryDoc.data();
                        if (!jury.email || !jury.name) continue;

                        const juryName = jury.name.trim().toLowerCase();

                        // Calculate total eligible registrants for THIS jury
                        const eligibleRegistrants = allRegistrants.filter(reg => {
                            const isPaid = reg.paymentStatus === 'PAID' || 
                                (reg.invoiceStatus && reg.invoiceStatus.toLowerCase() === 'paid');
                                
                            const regTeacherName = (reg.teacherName || '').trim().toLowerCase();
                            const regTeacher = (reg.teacher || '').trim().toLowerCase();
                            
                            const isOwnStudent = juryName && (
                                (regTeacherName && regTeacherName === juryName) || 
                                (regTeacher && regTeacher === juryName)
                            );
                            
                            return isPaid && !isOwnStudent;
                        });

                        const totalCount = eligibleRegistrants.length;
                        if (totalCount === 0) continue;

                        // Calculate scored registrants
                        const scoresSnap = await db.collection('JuryScores2025')
                            .where('juryUserId', '==', jury.uid)
                            .get();
                        
                        // Count valid scores for eligible registrants
                        const scoredRegistrantIds = new Set();
                        scoresSnap.docs.forEach(doc => {
                            const data = doc.data();
                            if (data.score !== undefined) {
                                scoredRegistrantIds.add(data.registrantId);
                            }
                        });

                        const assessedCount = eligibleRegistrants.filter(r => scoredRegistrantIds.has(r.id)).length;
                        const pendingCount = totalCount - assessedCount;

                        if (pendingCount > 0) {
                            try {
                                const formattedDeadline = deadline.toLocaleString('id-ID', {
                                    timeZone: 'Asia/Jakarta',
                                    day: 'numeric', month: 'long', year: 'numeric',
                                    hour: '2-digit', minute: '2-digit'
                                }) + ' WIB';

                                await sendJuryDeadlineReminderEmail({
                                    to: jury.email,
                                    name: jury.name,
                                    category: jury.competitionCategory,
                                    pendingCount,
                                    totalCount,
                                    deadline: formattedDeadline,
                                    eventId: currentEventId,
                                    timeRemainingText
                                });
                                emailsSent++;
                                
                                // Small delay to avoid rate limits
                                await new Promise(resolve => setTimeout(resolve, 500));
                            } catch (err) {
                                logger.error(`[JURY-REMINDER] Failed to send email to ${jury.email}: ${err.message}`);
                            }
                        }
                    }

                    logger.info(`[JURY-REMINDER] Finished ${category} (${timeRemainingText}). Sent ${emailsSent} reminder emails.`);
                    
                    // Mark this category's deadline as processed
                    newRemindersSent[flagKey] = true;
                    updatedRemindersSent = true;
            }

            // Save updated flags back to Firestore if changed
            if (updatedRemindersSent) {
                // Keep the object size manageable by removing old flags optionally,
                // but for now just merging is fine.
                await db.collection('systemSettings').doc('global').set({
                    juryDeadlineReminderSent: newRemindersSent
                }, { merge: true });
            }

        } catch (error) {
            logger.error(`[JURY-REMINDER] Error in deadline reminder job: ${error.message}`);
        }
    }, REMINDER_INTERVAL_MS);

    logger.info(`[JURY-REMINDER] Jury deadline reminder job started (runs every ${REMINDER_INTERVAL_MS / 1000}s)`);
};

module.exports = {
    startJuryDeadlineReminder
};
