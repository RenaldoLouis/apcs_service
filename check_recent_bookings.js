const { db } = require('./src/configs/firebase-init.js');

async function run() {
  const snapshot = await db.collection('publicBookings').orderBy('createdAt', 'desc').limit(5).get();
  snapshot.forEach(doc => {
      console.log(doc.id, doc.data().selectedSeatIds, doc.data().userName, doc.data().paymentStatus);
  });
  process.exit();
}
run();
