const { db } = require('./src/config/firebase');

async function test() {
    console.log("Checking for locked seats in APCS2026...");
    const snap = await db.collection('seatsAPCS2026').where('status', '==', 'locked').get();
    console.log(`Found ${snap.size} locked seats.`);
    
    console.log("Checking for reserved seats in APCS2026...");
    const snap2 = await db.collection('seatsAPCS2026').where('status', '==', 'reserved').get();
    console.log(`Found ${snap2.size} reserved seats.`);

    console.log("Checking for booked seats in APCS2026...");
    const snap3 = await db.collection('seatsAPCS2026').where('status', '==', 'booked').get();
    console.log(`Found ${snap3.size} booked seats.`);

    process.exit(0);
}
test();
