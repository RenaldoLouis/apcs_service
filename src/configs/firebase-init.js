const admin = require('firebase-admin');

if (process.env.APCS_FIRESTORE_MODE && process.env.APCS_FIRESTORE_MODE !== 'emulator') {
    throw new Error('Unknown Firestore mode.');
}
if (process.env.APCS_FIRESTORE_MODE === 'emulator') {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('Firestore emulator mode is unavailable in production.');
    }
    if (process.env.FIRESTORE_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8081') {
        throw new Error('Unexpected Firestore emulator host.');
    }
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8081';
} else if (process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST requires APCS_FIRESTORE_MODE=emulator.');
}

// IMPORTANT: Load the service account key
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// Get a reference to the Firestore database
const db = admin.firestore();

// Export the database reference to be used in other files
module.exports = { db, admin };
