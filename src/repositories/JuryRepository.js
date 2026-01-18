const { logger } = require('../utils/Logger');
const axios = require('axios');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');
const dayjs = require('dayjs');
const { db, admin } = require('../configs/firebase-init');

const createJury = async (body, callback) => {
    const { email, password, name, category } = body;

    if (!email || !password || !name || !category) {
        throw new AppError(
            `Failed to create jury: ${error.message}`,
            error.$metadata?.httpStatusCode || 500
        );
    }

    try {
        // 1. Create User in Firebase Authentication
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            displayName: name,
        });

        // 2. Set Custom Claims (This is what makes them a Jury securely)
        await admin.auth().setCustomUserClaims(userRecord.uid, {
            role: 'jury',
            competitionCategory: category
        });

        // 3. Create a Document in 'users' collection for extra profile data
        // This is useful for listing users in the Admin Dashboard UI later
        await db.collection('users').doc(userRecord.uid).set({
            uid: userRecord.uid,
            name: name,
            email: email,
            role: 'jury',
            competitionCategory: category,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`Successfully created new Jury: ${email}`);
        return callback(null, {
            message: 'Jury created successfully',
            uid: userRecord.uid
        });

    } catch (error) {
        console.error('Error creating new user:', error);
        logger.info(`fail create jury: ${error.message}}`);
    }
}

module.exports = {
    createJury
}