const { db } = require('./src/configs/firebase-init.js');
async function run() {
  const q = await db.collection('seatsPublicBooking2025').get();
  q.forEach(doc => {
    if (doc.data().status !== 'available') {
        console.log("Seat", doc.id, "Status:", doc.data().status, doc.data().assignedTo, doc.data().lockedBy);
    }
  });
}
run().then(() => process.exit(0)).catch(console.error);
