const { db } = require('./src/configs/firebase-init.js');
async function run() {
  const q = await db.collection('seatsPublicBooking2025')
    .where('sessionId', '==', '2026-07-03_10:00-11:00')
    .where('row', '==', 'C')
    .get();
  const seats = [];
  q.forEach(doc => seats.push({ id: doc.id, ...doc.data() }));
  console.log("Total C seats:", seats.length);
  const c1s = seats.filter(s => s.number === 1);
  console.log("C1 seats:");
  console.log(JSON.stringify(c1s, null, 2));
}
run().then(() => process.exit(0)).catch(console.error);
