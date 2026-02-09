const { logger } = require('../utils/Logger');
const axios = require('axios');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');
const dayjs = require('dayjs');
const { db, admin } = require('../configs/firebase-init');
const emailService = require('../services/EmailService'); // Adjust path as needed

const createJury = async (body, callback) => {
    const { email, password, name, category } = body;

    if (!email || !password || !name || !category) {
        // Assuming AppError is defined in your scope
        throw new AppError(
            `Missing required fields: email, password, name, or category`,
            400
        );
    }

    try {
        // 1. Create User in Firebase Authentication
        const userRecord = await admin.auth().createUser({
            email: email,
            password: password,
            displayName: name,
        });

        // 2. Set Custom Claims
        await admin.auth().setCustomUserClaims(userRecord.uid, {
            role: 'jury',
            competitionCategory: category
        });

        // 3. Create a Document in 'users' collection
        await db.collection('users').doc(userRecord.uid).set({
            uid: userRecord.uid,
            name: name,
            email: email,
            role: 'jury',
            competitionCategory: category,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`Successfully created new Jury: ${email}`);

        // 4. Send Email Notification with Credentials
        // We do this asynchronously so we don't block the response if email takes a second
        try {
            await emailService.sendEmailJuryAccountCreation({
                name: name,
                email: email,
                password: password,
                competitionCategory: category
            });
        } catch (emailError) {
            // Log error but generally we still want to return success for the account creation
            console.error(`Failed to send email to jury: ${emailError.message}`);
            logger.error(`Failed to send email to jury: ${emailError.message}`);
        }

        return callback(null, {
            message: 'Jury created successfully and email sent',
            uid: userRecord.uid
        });

    } catch (error) {
        console.error('Error creating new user:', error);
        logger.error(`Fail create jury: ${error.message}`);

        // Pass error to callback or throw depending on your architecture
        // return callback(error); 
        // OR
        throw new AppError(
            `Failed to create jury: ${error.message}`,
            500
        );
    }
}

module.exports = {
    createJury
}