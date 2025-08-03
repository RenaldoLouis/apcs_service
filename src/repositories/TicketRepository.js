const pool = require('../configs/DbConfig');
const { logger } = require('../utils/Logger');
const { db, admin } = require('../configs/firebase-init');
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

const verifyTicket = async (params, res) => {
    const { token } = req.body;

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


module.exports = {
    verifyTicket
}