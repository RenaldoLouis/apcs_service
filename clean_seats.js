const { db } = require('./src/configs/firebase-init.js');

async function run() {
  const q = await db.collection('seatsAPCS2026').get();
  
  // Group by sessionId + row + number
  const grouped = {};
  
  q.forEach(doc => {
    const seat = doc.data();
    const key = `${seat.sessionId}_${seat.row}_${seat.number}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ id: doc.id, ...seat });
  });

  const toDelete = [];
  
  for (const key in grouped) {
    const seats = grouped[key];
    if (seats.length > 1) {
      // Find the "best" one to keep. 
      // Prefer ones that are NOT available (if any)
      // Otherwise prefer the one with venueId prefix.
      let best = seats[0];
      let hasBooked = false;
      
      for (const s of seats) {
        if (s.status !== 'available') {
          best = s;
          hasBooked = true;
          break;
        }
      }
      
      if (!hasBooked) {
        // If all are available, pick the one that has the venue prefix
        best = seats.find(s => s.id.includes(s.venueId)) || seats[0];
      }
      
      // Delete all others
      for (const s of seats) {
        if (s.id !== best.id) {
          toDelete.push(s.id);
        }
      }
    }
  }

  console.log(`Found ${toDelete.length} duplicate seats to delete.`);
  
  // Batch delete (max 499 per batch)
  const batchSize = 400;
  for (let i = 0; i < toDelete.length; i += batchSize) {
      const batch = db.batch();
      const chunk = toDelete.slice(i, i + batchSize);
      chunk.forEach(id => {
          batch.delete(db.collection('seatsAPCS2026').doc(id));
      });
      await batch.commit();
      console.log(`Committed batch of ${chunk.length} deletes.`);
  }

  console.log("Deleted duplicates.");
}
run().then(() => process.exit(0)).catch(console.error);
