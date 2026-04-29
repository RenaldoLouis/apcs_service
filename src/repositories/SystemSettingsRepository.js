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
        const { currentEventId } = body;
        if (!currentEventId) {
            return callback(new Error('currentEventId is required.'));
        }

        const docRef = db.collection('systemSettings').doc('global');
        await docRef.set({ currentEventId }, { merge: true });

        callback(null, { success: true, currentEventId });
    } catch (error) {
        logger.error(`updateGlobalSettings failed: ${error.message}`);
        callback(error);
    }
};

module.exports = {
    getGlobalSettings,
    updateGlobalSettings,
};
