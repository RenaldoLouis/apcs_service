const admin = require('firebase-admin');

// IMPORTANT: Load the service account key
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

// Get a reference to the Firestore database
const db = admin.firestore();

// Export the database reference to be used in other files
module.exports = { db, admin };