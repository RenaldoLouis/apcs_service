const pool = require('../configs/DbConfig');
const { logger } = require('../utils/Logger');
const { db, admin } = require('../configs/firebase-init');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

const verifyTicket = async (req, res) => {
    const { token } = req;

    if (!token) {
        return res.status(400).json({ message: 'No ticket token provided.' });
    }

    try {
        // 1. Verify the JWT signature (this part doesn't change)
        const payload = jwt.verify(token, JWT_SECRET);
        const { registrantId } = payload;

        // 2. Get the registrant document using the Admin SDK syntax
        const docRef = db.collection('Registrants2025').doc(registrantId);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ message: 'Registrant not found.' });
        }

        const registrant = docSnap.data();

        // 3. Check if the ticket has already been used (this part doesn't change)
        if (registrant.checkedIn) {
            return res.status(409).json({
                message: `Already checked in at ${new Date(registrant.checkedInAt.seconds * 1000).toLocaleTimeString()}`
            });
        }

        // 4. Update the document using the Admin SDK syntax
        await docRef.update({
            checkedIn: true,
            // Use the Admin SDK's serverTimestamp
            checkedInAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // 5. Send a success response (this part doesn't change)
        const performerName = registrant.performers[0]?.firstName || registrant.name;
        res.status(200).json({
            success: true,
            message: `Check-in successful for ${performerName}.`,
            name: performerName
        });

    } catch (error) {
        console.error("Verification failed:", error);
        res.status(401).json({ message: 'Invalid or expired ticket.' });
    }
};

const saveSeatBookProfileInfo = async (req, callback) => {
    // We'll get the payload from the request body
    const { eventId, userId, userEmail } = req;

    // Basic validation
    if (!eventId || !userId || !userEmail) {
        return callback(null, "results.rows[0]");
    }

    try {
        // 1. Prepare the data to be saved to Firestore
        const dataToSave = {
            ...req,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            seatSelectionToken: null, // Initialize token field
        };

        // 2. Save the data to a new document in the 'seatBook2025' collection
        // .add() automatically generates a unique ID for the new document
        const docRef = await db.collection('seatBook2025').add(dataToSave);
        console.log(`New booking saved with ID: ${docRef.id}`);

        // 3. Generate a secure token for the user to select their seat later
        const tokenPayload = {
            userId: userId,             // The ID of the registrant
            bookingId: docRef.id,       // The ID of this specific booking document
            eventId: eventId,
        };

        // The token will be valid for 7 days, giving the user time to pay and select a seat
        const seatSelectionToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '7d' });

        console.log("seatSelectionToken", seatSelectionToken)
        // 4. (Optional but recommended) Save the generated token back to the booking document for reference
        await docRef.update({
            seatSelectionToken: seatSelectionToken
        });

        // 5. Send a success response back to the frontend, including the new ID and token
        const returnData = {
            message: 'Booking profile saved successfully.',
            bookingId: docRef.id,
            seatSelectionToken: seatSelectionToken,
        }
        callback(null, returnData);

    } catch (error) {
        console.error("Failed to save booking profile:", error);
        res.status(500).json({ message: 'An error occurred while saving the booking.' });
    }
};

const verifySeatSelectionToken = async (req, callback) => { // Using req, res for standard Express
    const { token } = req;

    if (!token) {
        callback(null, 'Token not provided.');
    }

    try {
        // 1. Verify the JWT is valid and signed by us
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        const { bookingId, eventId } = payload;

        // 2. Fetch the corresponding booking from Firestore
        const bookingRef = db.collection('seatBook2025').doc(bookingId);
        const bookingDoc = await bookingRef.get();

        if (!bookingDoc.exists) {
            callback(null, 'Booking not found.');
        }

        const bookingData = bookingDoc.data();

        // 3. Check if seats have already been selected for this booking
        if (bookingData.seatsSelected) {
            callback(null, 'Seats have already been selected for this booking.');
        }

        // --- THIS IS THE KEY CHANGE ---
        // 4. Fetch the seat layout for the SPECIFIC session the user booked.
        // We construct the sessionId from the booking data.
        const sessionId = `${bookingData.date}_${bookingData.session}`;

        const trimmedSessionId = sessionId.replace(/\s+/g, '');
        // Query the main 'seats' collection, filtering by the exact sessionId.
        const seatsSnapshot = await db.collection(`seats${eventId}`).where('sessionId', '==', trimmedSessionId).get();
        const seatLayout = seatsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        // --- END OF CHANGE ---


        // 5. Send the booking and seat data back to the frontend
        const returnData = {
            message: 'Token is valid.',
            bookingData: { id: bookingDoc.id, ...bookingData },
            seatLayout: seatLayout
        }
        callback(null, returnData);

    } catch (error) {
        console.error("Seat selection token verification failed:", error);
        callback(null, 'Link is invalid or has expired.');
    }
};

const confirmSeatSelection = async (req, callback) => {
    const { bookingId, selectedSeatIds } = req;

    if (!bookingId || !selectedSeatIds || selectedSeatIds.length === 0) {
        callback(null, 'error');
    }

    const bookingRef = db.collection('seatBook2025').doc(bookingId);

    try {
        // Use a transaction to ensure no one else takes the seats while we're booking them
        await db.runTransaction(async (transaction) => {
            const bookingDoc = await transaction.get(bookingRef);
            if (!bookingDoc.exists) throw new Error("Booking not found.");
            if (bookingDoc.data().seatsSelected) throw new Error("Seats have already been selected.");

            for (const seatId of selectedSeatIds) {
                const seatRef = db.collection('seats').doc(seatId);
                const seatDoc = await transaction.get(seatRef);
                if (seatDoc.data().status !== 'available') {
                    throw new Error(`Sorry, seat ${seatDoc.data().seatLabel} is no longer available.`);
                }
                // Reserve the seat
                transaction.update(seatRef, { status: 'reserved' });
            }

            // Update the booking to finalize the selection
            transaction.update(bookingRef, {
                seatsSelected: true,
                selectedSeats: selectedSeatIds // Store the selected seat IDs
            });
        });


        callback(null, 'Your seats have been successfully reserved!');

    } catch (error) {
        console.error("Failed to confirm seat selection:", error);
        callback(null, 'An error occurred while reserving your seats.');

    }
};


module.exports = {
    verifyTicket,
    saveSeatBookProfileInfo,
    verifySeatSelectionToken,
    confirmSeatSelection
}