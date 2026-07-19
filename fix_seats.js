const { db } = require('./src/configs/firebase-init.js');
async function run() {
  const q = await db.collection('seatsPublicBooking2025').where('status', '==', 'reserved').get();
  const batch = db.batch();
  let count = 0;
  q.forEach(doc => {
    console.log("Fixing seat", doc.id, doc.data().assignedTo);
    batch.update(doc.ref, { status: 'booked' });
    count++;
  });
  if (count > 0) {
      await batch.commit();
      console.log(`Fixed ${count} seats.`);
  } else {
      console.log("No reserved seats found.");
  }
}
run().then(() => process.exit(0)).catch(console.error);
