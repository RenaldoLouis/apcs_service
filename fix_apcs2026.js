const { db } = require('./src/configs/firebase-init.js');
async function run() {
  const q = await db.collection('seatsAPCS2026').where('status', '==', 'reserved').get();
  const batch = db.batch();
  let count = 0;
  q.forEach(doc => {
    const data = doc.data();
    if (data.assignedTo && data.assignedTo.name) {
        console.log("Fixing seat", doc.id);
        batch.update(doc.ref, { 
            status: 'booked',
            assignedTo: {
                userName: data.assignedTo.name,
                userEmail: data.assignedTo.email,
                registrantName: ''
            }
        });
        count++;
    }
  });
  if (count > 0) {
      await batch.commit();
      console.log(`Fixed ${count} seats.`);
  } else {
      console.log("No reserved seats found.");
  }
}
run().then(() => process.exit(0)).catch(console.error);
