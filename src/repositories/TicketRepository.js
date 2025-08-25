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
        const seatSelectionToken = jwt.sign(tokenPayload, "2Wh8w90fkoAyN4gYP7lLjkTGXujxQw59", { expiresIn: '7d' });

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


module.exports = {
    verifyTicket,
    saveSeatBookProfileInfo
}