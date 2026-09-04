const admin = require('firebase-admin');
const { Timestamp } = require('firebase-admin/firestore');
const serviceAccount = require('./src/configs/serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function run() {
    try {
        const readTime = Timestamp.fromDate(new Date('2026-09-03T21:00:00.000Z'));
        // Try readOnly transaction
        await db.runTransaction(async (t) => {
            const snap = await t.get(db.collection('JuryScores2025').where('score', '==', 92));
            console.log("Success! Found:", snap.size);
        }, { readOnly: true, readTime: readTime });
    } catch (err) {
        console.error("Error:", err);
    }
}
run();
