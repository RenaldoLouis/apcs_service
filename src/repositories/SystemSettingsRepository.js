const { db } = require('../configs/firebase-init');
const { logger } = require('../utils/Logger');

const getGlobalSettings = async (_body, callback) => {
    try {
        const docRef = db.collection('systemSettings').doc('global');
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return callback(null, { currentEventId: 'APCS2026' });
        }

        callback(null, docSnap.data());
    } catch (error) {
        logger.error(`getGlobalSettings failed: ${error.message}`);
        callback(error);
    }
};

const updateGlobalSettings = async (body, callback) => {
    try {
        const updatePayload = {};

        // Support currentEventId
        if (body.currentEventId) {
            updatePayload.currentEventId = body.currentEventId;
        }

        // Support ticketEligibility (date-based schedule)
        if (body.ticketEligibility !== undefined) {
            updatePayload.ticketEligibility = body.ticketEligibility;
        }

        // Support juryDeadlines (per competition category, ISO-8601 strings)
        // e.g. { "Piano Solo": "2026-06-15T23:59:00+07:00", "Violin Solo": "2026-06-20T23:59:00+07:00" }
        if (body.juryDeadlines !== undefined) {
            updatePayload.juryDeadlines = body.juryDeadlines;
        }

        // Support usdToIdrRate (exchange rate for international invoices)
        if (body.usdToIdrRate !== undefined) {
            updatePayload.usdToIdrRate = body.usdToIdrRate;
        }

        // Support isRegistrationEnabled
        if (body.isRegistrationEnabled !== undefined) {
            updatePayload.isRegistrationEnabled = body.isRegistrationEnabled;
        }

        if (Object.keys(updatePayload).length === 0) {
            return callback(new Error('No valid fields to update.'));
        }

        const docRef = db.collection('systemSettings').doc('global');
        await docRef.set(updatePayload, { merge: true });

        callback(null, { success: true, ...updatePayload });
    } catch (error) {
        logger.error(`updateGlobalSettings failed: ${error.message}`);
        callback(error);
    }
};

module.exports = {
    getGlobalSettings,
    updateGlobalSettings,
};
