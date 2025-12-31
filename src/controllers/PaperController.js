const paperService = require('../services/PaperService.js');
const { validationResult } = require('express-validator');
const { logger } = require('../utils/Logger.js');
const { db, admin } = require('../configs/firebase-init');

async function createInvoice(req, res, next) {
    try {
        const data = await paperService.createInvoice(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function handlePaperWebhook(req, res, next) {
    try {
        const payload = req.body;
        console.log("payload", payload)
        // Log the incoming webhook for debugging
        console.log("Received Payment Webhook:", JSON.stringify(payload, null, 2));

        const payloadData = payload.data

        // 1. Validate the Payment Status
        // Based on your example: payload.invoice.status === 'paid'
        const isPaid = payloadData.invoice && payloadData.invoice.status.toLowerCase() === 'paid';

        if (isPaid) {
            // 2. Extract Firebase ID
            // In your createInvoice function, you set the number as: `INV-${externalId}`
            // Example payload.invoice.number: "INV-7d9f8g7df8g7"
            const invoiceNumber = payloadData.invoice.number;
            console.log("invoiceNumber", invoiceNumber)
            // Remove the prefix to get the raw Firebase ID
            const firebaseId = invoiceNumber.replace('INV-', '');

            if (firebaseId) {
                console.log(`Processing successful payment for Registrant ID: ${firebaseId}`);

                // 3. Update Firebase
                const docRef = db.collection('Registrants2025').doc(firebaseId);

                // Double check if doc exists before updating
                const docSnap = await docRef.get();
                if (docSnap.exists) {
                    await docRef.update({
                        paymentStatus: 'PAID',
                        paidAt: new Date(),
                        amountPaid: payloadData.invoice.total_amount,
                        paymentMethod: payloadData.payment_info?.method || 'paper_id',
                        paymentDetails: payloadData // Save full log for audit trail
                    });
                    logger.info(`payment status updated successfully for ${firebaseId}`)
                    console.log(`✅ Firebase updated successfully for ${firebaseId}`);
                } else {
                    logger.error(`⚠️ Registrant document ${firebaseId} not found!`);
                    console.warn(`⚠️ Registrant document ${firebaseId} not found!`);
                }
            }
        } else {
            console.log("Webhook received but status is not 'paid', ignoring.");
        }

        // Always return 200 to Paper.id so they know you received it
        res.status(200).json({ status: 'OK' });

    } catch (error) {
        console.error("Webhook Processing Error:", error);
        // Return 200 even on error to prevent Paper.id from retrying indefinitely
        res.status(200).json({ status: 'Error handled' });
    }
};

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
    createInvoice,
    handlePaperWebhook,
    checkPaymentStatus
};