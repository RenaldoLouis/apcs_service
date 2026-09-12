/**
 * reset_test_occupancy.js
 * 
 * Developer utility script to safely reset test seat occupancy, locks,
 * bookings, and complimentary quota counters for testing purposes.
 * 
 * Usage:
 *   # Dry run (safe inspection - shows what would be changed without modifying data):
 *   node reset_test_occupancy.js
 * 
 *   # Dry run for a specific event:
 *   node reset_test_occupancy.js --event=APCS2026
 * 
 *   # Dry run for a specific session:
 *   node reset_test_occupancy.js --event=APCS2026 --session=2026-07-01_08:00-09:00
 * 
 *   # Execute cleanup (actually resets seats and deletes test bookings):
 *   node reset_test_occupancy.js --confirm
 *   node reset_test_occupancy.js --event=APCS2026 --confirm
 *   node reset_test_occupancy.js --event=APCS2026 --session=2026-07-01_08:00-09:00 --confirm
 * 
 *   # Reset seats but preserve publicBookings documents:
 *   node reset_test_occupancy.js --confirm --keep-bookings
 */

const { db, admin } = require('./src/configs/firebase-init.js');

// Helper to parse CLI arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        eventId: null,
        session: null,
        venue: null,
        confirm: false,
        keepBookings: false,
    };

    args.forEach(arg => {
        if (arg === '--confirm') {
            options.confirm = true;
        } else if (arg === '--keep-bookings') {
            options.keepBookings = true;
        } else if (arg.startsWith('--event=')) {
            options.eventId = arg.split('=')[1].trim();
        } else if (arg.startsWith('--session=')) {
            options.session = arg.split('=')[1].trim();
        } else if (arg.startsWith('--venue=')) {
            options.venue = arg.split('=')[1].trim();
        }
    });

    return options;
}

async function getActiveEventId() {
    try {
        const sysDoc = await db.collection('systemSettings').doc('global').get();
        if (sysDoc.exists && sysDoc.data().currentEventId) {
            return sysDoc.data().currentEventId;
        }
    } catch (e) {
        // Fallback
    }
    return 'APCS2026';
}

async function run() {
    const options = parseArgs();
    const eventId = options.eventId || await getActiveEventId();

    console.log('====================================================');
    console.log('       APCS SEAT OCCUPANCY RESET SCRIPT');
    console.log('====================================================');
    console.log(`Event ID     : ${eventId}`);
    console.log(`Session Filter: ${options.session || '(All Sessions)'}`);
    console.log(`Venue Filter  : ${options.venue || '(All Venues)'}`);
    console.log(`Mode         : ${options.confirm ? '🚨 LIVE EXECUTION (--confirm provided)' : '🔍 DRY RUN (safe inspection)'}`);
    console.log(`Keep Bookings: ${options.keepBookings ? 'YES' : 'NO (test bookings will be deleted)'}`);
    console.log('----------------------------------------------------\n');

    const seatsCollectionName = `seats${eventId}`;
    const seatsRef = db.collection(seatsCollectionName);

    // 1. Fetch non-available seats
    console.log(`1. Scanning ${seatsCollectionName} for booked / locked / reserved seats...`);
    const seatsSnapshot = await seatsRef.get();
    
    const seatsToReset = [];
    seatsSnapshot.forEach(doc => {
        const data = doc.data();
        if (data.status && data.status !== 'available') {
            if (options.session && data.sessionId !== options.session) return;
            if (options.venue && data.venueId !== options.venue) return;
            seatsToReset.push({ id: doc.id, ref: doc.ref, data });
        }
    });

    console.log(`   Found ${seatsToReset.length} seat(s) to reset.`);
    if (seatsToReset.length > 0) {
        console.log('   Seats to reset:');
        seatsToReset.forEach(s => {
            const who = s.data.assignedTo?.userName || s.data.assignedTo?.registrantName || s.data.lockedBy?.userName || 'N/A';
            console.log(`    - [${s.data.status.toUpperCase()}] ${s.id} (Seat ${s.data.seatLabel || s.id}) -> Booked/Locked by: ${who}`);
        });
    }

    // 2. Fetch public bookings
    console.log(`\n2. Scanning publicBookings for event ${eventId}...`);
    const bookingsSnapshot = await db.collection('publicBookings').where('eventId', '==', eventId).get();
    const bookingsToClean = [];
    bookingsSnapshot.forEach(doc => {
        const data = doc.data();
        if (options.session) {
            const hasSession = data.session === options.session || 
                (data.selectedSeatIds || []).some(id => id.includes(options.session));
            if (!hasSession) return;
        }
        bookingsToClean.push({ id: doc.id, ref: doc.ref, data });
    });

    console.log(`   Found ${bookingsToClean.length} public booking(s).`);
    if (bookingsToClean.length > 0) {
        console.log('   Bookings found:');
        bookingsToClean.forEach(b => {
            console.log(`    - Booking ID: ${b.id} | Buyer: ${b.data.userName} (${b.data.userEmail}) | Status: ${b.data.paymentStatus} | Seats: ${(b.data.selectedSeatIds || []).length}`);
        });
    }

    // 3. Inspect orchestraSessions complimentaryClaimed
    console.log(`\n3. Checking orchestraSessions in events/${eventId}...`);
    const eventDocRef = db.collection('events').doc(eventId);
    const eventDoc = await eventDocRef.get();
    let orchestraSessionsToUpdate = null;

    if (eventDoc.exists) {
        const eventData = eventDoc.data();
        const orchestraSessions = eventData.orchestraSessions || [];
        let hasClaimed = false;

        const updatedOrchestraSessions = orchestraSessions.map(os => {
            if (options.session) {
                const sId = `${os.date}_${os.time}`;
                if (sId !== options.session) return os;
            }
            if (options.venue && os.venue !== options.venue) return os;

            if (os.complimentaryClaimed && os.complimentaryClaimed > 0) {
                hasClaimed = true;
                console.log(`    - Orchestra Session ${os.date} ${os.time} (venue: ${os.venue}): complimentaryClaimed = ${os.complimentaryClaimed} -> will reset to 0`);
                return { ...os, complimentaryClaimed: 0 };
            }
            return os;
        });

        if (hasClaimed) {
            orchestraSessionsToUpdate = updatedOrchestraSessions;
        } else {
            console.log('    No complimentary claims recorded on orchestra sessions.');
        }
    }

    // 4. Inspect related tracking collections
    console.log(`\n4. Checking related tracking collections (ticketSeatOwnership, ticketCapacity, winnerOrchestraClaims)...`);
    
    // Seat ownership
    const ownershipSnap = await db.collection('ticketSeatOwnership').get();
    const ownershipToClean = [];
    ownershipSnap.forEach(doc => {
        if (doc.id.startsWith(`${eventId}|`) || doc.data().eventId === eventId) {
            if (options.session && !doc.id.includes(options.session)) return;
            ownershipToClean.push(doc.ref);
        }
    });

    // Ticket capacity
    const capacitySnap = await db.collection('ticketCapacity').get();
    const capacityToClean = [];
    capacitySnap.forEach(doc => {
        if (doc.id.startsWith(`${eventId}_`) || doc.id.startsWith(encodeURIComponent(eventId))) {
            if (options.session && !doc.id.includes(options.session)) return;
            capacityToClean.push(doc.ref);
        }
    });

    // Winner claims
    const claimsSnap = await db.collection('winnerOrchestraClaims').get();
    const claimsToClean = [];
    claimsSnap.forEach(doc => {
        if (doc.id.startsWith(`${eventId}_`) || doc.id.startsWith(encodeURIComponent(eventId))) {
            claimsToClean.push(doc.ref);
        }
    });

    console.log(`    - ticketSeatOwnership: ${ownershipToClean.length} records found`);
    console.log(`    - ticketCapacity     : ${capacityToClean.length} records found`);
    console.log(`    - winnerOrchestraClaims: ${claimsToClean.length} records found`);

    // Decision block
    console.log('\n----------------------------------------------------');
    if (!options.confirm) {
        console.log('ℹ️  DRY RUN FINISHED. No changes were made to Firestore.');
        console.log('To apply these changes and reset occupancy, run with --confirm:');
        
        let cmd = 'node reset_test_occupancy.js --confirm';
        if (options.eventId) cmd += ` --event=${options.eventId}`;
        if (options.session) cmd += ` --session=${options.session}`;
        if (options.venue) cmd += ` --venue=${options.venue}`;
        if (options.keepBookings) cmd += ' --keep-bookings';

        console.log(`\n    ${cmd}\n`);
        process.exit(0);
    }

    // 5. LIVE EXECUTION
    console.log('🚀 COMMITTING CHANGES TO FIRESTORE...');

    // A. Reset Seats in Batches
    if (seatsToReset.length > 0) {
        const batchSize = 400;
        for (let i = 0; i < seatsToReset.length; i += batchSize) {
            const batch = db.batch();
            const chunk = seatsToReset.slice(i, i + batchSize);
            chunk.forEach(s => {
                batch.update(s.ref, {
                    status: 'available',
                    assignedTo: admin.firestore.FieldValue.delete(),
                    bookingId: admin.firestore.FieldValue.delete(),
                    lockedBy: admin.firestore.FieldValue.delete(),
                    lockedByBookingId: admin.firestore.FieldValue.delete(),
                    lockedAt: admin.firestore.FieldValue.delete()
                });
            });
            await batch.commit();
            console.log(`   ✓ Reset ${chunk.length} seat(s) to 'available' (Batch ${Math.floor(i / batchSize) + 1})`);
        }
    }

    // B. Clean Public Bookings (unless --keep-bookings)
    if (!options.keepBookings && bookingsToClean.length > 0) {
        const batchSize = 400;
        for (let i = 0; i < bookingsToClean.length; i += batchSize) {
            const batch = db.batch();
            const chunk = bookingsToClean.slice(i, i + batchSize);
            chunk.forEach(b => {
                batch.delete(b.ref);
            });
            await batch.commit();
            console.log(`   ✓ Deleted ${chunk.length} test public booking(s) (Batch ${Math.floor(i / batchSize) + 1})`);
        }
    }

    // C. Reset orchestra complimentary claimed in event doc
    if (orchestraSessionsToUpdate) {
        await eventDocRef.update({
            orchestraSessions: orchestraSessionsToUpdate
        });
        console.log(`   ✓ Reset complimentaryClaimed counters in events/${eventId}`);
    }

    // D. Clean tracking collections
    const trackingRefsToDelete = [
        ...ownershipToClean,
        ...capacityToClean,
        ...claimsToClean
    ];
    if (trackingRefsToDelete.length > 0) {
        const batchSize = 400;
        for (let i = 0; i < trackingRefsToDelete.length; i += batchSize) {
            const batch = db.batch();
            const chunk = trackingRefsToDelete.slice(i, i + batchSize);
            chunk.forEach(ref => batch.delete(ref));
            await batch.commit();
            console.log(`   ✓ Cleaned ${chunk.length} tracking records`);
        }
    }

    console.log('\n🎉 SUCCESS: Seat occupancy and test booking data reset successfully!');
    console.log('You can now refresh the Seat Occupancy page in your browser to verify that occupancy is back to 0%.');
    process.exit(0);
}

run().catch(err => {
    console.error('\n❌ Error executing seat reset script:', err);
    process.exit(1);
});
