const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

async function run() {
  const snapshot = await db.collection('publicBookings').orderBy('createdAt', 'desc').limit(5).get();
  snapshot.forEach(doc => {
      console.log(doc.id, doc.data().selectedSeatIds, doc.data().userName, doc.data().paymentStatus);
  });
  process.exit();
}
run();
