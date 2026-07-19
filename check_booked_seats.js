const { db } = require('./src/configs/firebase-init.js');
async function run() {
  const q = await db.collection('seatsPublicBooking2025').where('status', '==', 'booked').get();
  q.forEach(doc => {
    console.log("Booked seat", doc.id, doc.data().assignedTo);
  });
}
run().then(() => process.exit(0)).catch(console.error);
