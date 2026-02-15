const paperService = require('../services/PaperService.js');
const { validationResult } = require('express-validator');
const { logger } = require('../utils/Logger.js');
const { db, admin } = require('../configs/firebase-init');
const emailService = require('../services/EmailService');

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
        // Log the incoming webhook for debugging
        console.log("Received Payment Webhook:", JSON.stringify(payload, null, 2));

        const payloadData = payload.data

        // 1. Validate the Payment Status
        // Based on your example: payload.invoice.status === 'paid'
        const isPaid = payloadData.invoice && payloadData.invoice.status.toLowerCase() === 'paid';

        if (isPaid) {
            // 2. Extract Firebase ID
            // In your createInvoice function, you set the number as: `${externalId}`
            // Example payload.invoice.number: "7d9f8g7df8g7"
            const invoiceNumber = payloadData.invoice.number;
            console.log("invoiceNumber", invoiceNumber)
            // Remove the prefix to get the raw Firebase ID
            // const firebaseId = invoiceNumber.replace('INV-', '');
            const firebaseId = invoiceNumber;

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

                    const docData = docSnap.data();
                    const performers = docData.performers || [];

                    // Format the price (e.g., 100000 -> "Rp 100.000")
                    const formattedPrice = new Intl.NumberFormat('id-ID', {
                        style: 'currency',
                        currency: 'IDR',
                        minimumFractionDigits: 0
                    }).format(docData.amountToPay || payloadData.invoice.total_amount);

                    // Group performers by email (Logic ported from your FE)
                    const emailGroups = performers.reduce((acc, performer) => {
                        const email = performer.email;

                        if (!acc[email]) {
                            acc[email] = {
                                email: email,
                                names: [],
                                competitionCategory: docData.competitionCategory,
                                instrumentCategory: docData.instrumentCategory,
                                price: formattedPrice
                            };
                        }

                        // Add performer name to the group
                        // Handle cases where fullName might be missing
                        const fullName = performer.fullName || `${performer.firstName} ${performer.lastName}`;
                        acc[email].names.push(fullName);

                        return acc;
                    }, {});

                    // Convert to array and format names string
                    const dataEmailList = Object.values(emailGroups).map(group => ({
                        email: group.email,
                        name: group.names.join(' and '), // e.g., "Susi and Budi"
                        competitionCategory: group.competitionCategory,
                        instrumentCategory: group.instrumentCategory,
                        price: group.price
                    }));

                    // --- 5. SEND EMAILS ---
                    logger.info(`Sending confirmation emails for ${dataEmailList.length} groups...`);

                    // Iterate and send emails individually (since we are in the backend)
                    for (const emailData of dataEmailList) {
                        try {
                            // A. Send Confirmation Email to User
                            // Ensure 'sendEmailFunc' is exported in your EmailService module
                            await emailService.sendEmailFunc(emailData);
                            logger.info(`✅ Confirmation email sent to ${emailData.email}`);

                            // B. Send Notification Email to APCS Admin
                            await emailService.sendEmailNotifyApcs(emailData);
                            logger.info(`✅ Admin notification sent for ${emailData.name}`);

                        } catch (emailError) {
                            // Log error but don't fail the webhook response
                            logger.error(`❌ Failed to send email for ${emailData.email}: ${emailError.message}`);
                        }
                    }

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