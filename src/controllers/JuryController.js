const JuryService = require('../services/JuryService.js');
const { validationResult } = require('express-validator');
const { logger } = require('../utils/Logger.js');
const { db, admin } = require('../configs/firebase-init');

async function createJury(req, res, next) {
    try {
        const data = await JuryService.createJury(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}
async function checkPaymentStatus(req, res, next) {
    try {
        const { id } = req.params;

        if (!id) return res.status(400).json({ message: "ID required" });

        const docRef = db.collection('Registrants2025').doc(id);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ message: "Not found" });
        }

        const data = docSnap.data();

        // ONLY return the status. Do not return PII (Name, Email, etc).
        return res.status(200).json({
            paymentStatus: data.paymentStatus
        });

    } catch (error) {
        console.error("Check Status Error:", error);
        return res.status(500).json({ error: "Server Error" });
    }
};

module.exports = {
    createJury,
    checkPaymentStatus
};