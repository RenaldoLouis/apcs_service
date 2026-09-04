const { logger } = require('../utils/Logger');
const axios = require('axios');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');
const dayjs = require('dayjs');
const { db, admin } = require('../configs/firebase-init');
const emailService = require('../services/EmailService'); // Adjust path as needed

const createJury = async (body, callback) => {
    const { email, password, name, category, eventId } = body;

    if (!email || !password || !name || !category || !eventId) {
        // Assuming AppError is defined in your scope
        return callback(new AppError(
            `Missing required fields: email, password, name, category, or eventId`,
            400
        ));
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
            competitionCategory: category,
            eventId: eventId
        });

        // 3. Create a Document in 'users' collection
        await db.collection('users').doc(userRecord.uid).set({
            uid: userRecord.uid,
            name: name,
            email: email,
            role: 'jury',
            competitionCategory: category,
            eventId: eventId,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        logger.info(`Successfully created new Jury: ${email}`);

        // 4. Send Email Notification with Credentials
        // We do this asynchronously so we don't block the response if email takes a second
        try {
            await emailService.sendEmailJuryAccountCreationFunc({
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
        return callback(new AppError(
            `Failed to create jury: ${error.message}`,
            500
        ));
    }
}

const updateJury = async (body, callback) => {
    const { uid, name, category, eventId } = body;

    if (!uid || !name || !category || !eventId) {
        return callback(new AppError(`Missing required fields: uid, name, category, or eventId`, 400));
    }

    try {
        // 1. Update Firebase Auth Profile
        await admin.auth().updateUser(uid, {
            displayName: name,
        });

        // 2. Update Custom Claims
        await admin.auth().setCustomUserClaims(uid, {
            role: 'jury',
            competitionCategory: category,
            eventId: eventId
        });

        // 3. Update Firestore Document
        await db.collection('users').doc(uid).update({
            name: name,
            competitionCategory: category,
            eventId: eventId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        logger.info(`Successfully updated Jury: ${uid}`);
        return callback(null, { message: 'Jury updated successfully' });

    } catch (error) {
        console.error('Error updating jury:', error);
        logger.error(`Fail update jury: ${error.message}`);
        return callback(new AppError(`Failed to update jury: ${error.message}`, 500));
    }
}

const deleteJury = async (body, callback) => {
    const { uid } = body;

    if (!uid) {
        return callback(new AppError(`Missing required field: uid`, 400));
    }

    try {
        // 1. Check if they have already scored students
        const scoresSnapshot = await db.collection('JuryScores2025').where('juryUserId', '==', uid).limit(1).get();
        if (!scoresSnapshot.empty) {
            return callback(new AppError('Cannot delete this jury member because they have already submitted scores.', 400));
        }

        // 2. Delete from Firebase Auth
        try {
            await admin.auth().deleteUser(uid);
        } catch (authErr) {
            if (authErr.code === 'auth/user-not-found') {
                logger.warn(`[DELETE-JURY] Auth user not found for ${uid}, proceeding to delete Firestore document.`);
            } else {
                throw authErr;
            }
        }

        // 3. Delete from Firestore
        await db.collection('users').doc(uid).delete();

        logger.info(`Successfully deleted Jury: ${uid}`);
        return callback(null, { message: 'Jury deleted successfully' });

    } catch (error) {
        console.error('Error deleting jury:', error);
        logger.error(`Fail delete jury: ${error.message}`);
        return callback(new AppError(`Failed to delete jury: ${error.message}`, 500));
    }
}

module.exports = {
    createJury,
    updateJury,
    deleteJury
}