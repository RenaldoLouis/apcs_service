const paperService = require('../services/PaperService.js');
const { validationResult } = require('express-validator');
const { logger } = require('../utils/Logger.js');
const { db, admin } = require('../configs/firebase-init');
const emailService = require('../services/EmailService');
const { getVocalChoirDiscount } = require('../utils/discountUtils');

async function createInvoice(req, res, next) {
    try {
        const { externalId, items } = req.body;

        // Security Check: Verify price and apply discount rules on backend if needed
        if (externalId && items && items.length > 0) {
            const docRef = db.collection('Registrants2025').doc(externalId);
            const docSnap = await docRef.get();

            if (docSnap.exists) {
                const registrant = docSnap.data();
                // Verify if Vocal Choir Ensemble discount applies
                const discountPercent = getVocalChoirDiscount(
                    registrant.competitionCategory,
                    registrant.PerformanceCategory,
                    registrant.totalPerformer || 0
                );

                if (discountPercent > 0) {
                    logger.info(`Applying ${discountPercent * 100}% discount for VocalChoir Ensemble ${externalId} with ${registrant.totalPerformer} performers`);
                    // The items are already discounted from the frontend in our current flow,
                    // but this ensures the backend logic is also aware and could enforce it.
                }
            }
        }

        const data = await paperService.createInvoice(req, next)

        // Update Firestore if it is a Registration
        if (externalId) {
            const docRef = db.collection('Registrants2025').doc(externalId);
            const docSnap = await docRef.get();
            if (docSnap.exists && data && data.paymentUrl) {
                await docRef.update({
                    invoiceStatus: "CREATED",
                    paymentUrl: data.paymentUrl,
                    invoiceId: data.invoiceId
                });
            }
        }

        res.status(200).send(data)
    } catch (err) {
        // Update Firestore to indicate invoice generation failed
        const { externalId } = req.body;
        if (externalId) {
            try {
                const docRef = db.collection('Registrants2025').doc(externalId);
                const docSnap = await docRef.get();
                if (docSnap.exists) {
                    await docRef.update({
                        invoiceStatus: "FAILED"
                    });
                }
            } catch (dbErr) {
                logger.error(`Failed to update invoiceStatus to FAILED for ${externalId}: ${dbErr.message}`);
            }
        }
        next(err);
    }
}

async function handlePaperWebhook(req, res, next) {
    try {
        const payload = req.body;
        // Log the incoming webhook for debugging
        console.log("Received Payment Webhook:", JSON.stringify(payload, null, 2));
        logger.info(`[PAPER_WEBHOOK_RECEIVED] Payload: ${JSON.stringify(payload)}`);

        // Safely handle both Production (flat) and Development (nested in .data) payload structures automatically
        const payloadData = payload.invoice ? payload : (payload.data ? payload.data : payload);

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
                // First, check if it's a public ticket booking
                const publicBookingRef = db.collection('publicBookings').doc(firebaseId);
                const publicBookingDoc = await publicBookingRef.get();

                if (publicBookingDoc.exists) {
                    logger.info(`Routing payment ${firebaseId} to Public Tickets Webhook Handler`);
                    
                    // Route to public ticket logic
                    const PublicTicketService = require('../services/PublicTicketService');
                    const bookingData = await PublicTicketService.handlePublicTicketWebhookPaid(firebaseId, payloadData);
                    
                    // Resolve dynamic venue label
                    let resolvedVenueLabel = bookingData.venue;
                    try {
                        const eventData = await PublicTicketService.getPublicTicketEventData();
                        if (eventData && eventData.venues) {
                            const venueObj = eventData.venues.find(v => v.id === bookingData.venue);
                            if (venueObj) resolvedVenueLabel = venueObj.label;
                        }
                    } catch (e) {
                        logger.warn(`Could not fetch dynamic venue label: ${e.message}`);
                    }

                    // Send booking confirmation email
                    try {
                        await emailService.sendPublicBookingConfirmationEmail(bookingData, resolvedVenueLabel);
                    } catch (emailErr) {
                        logger.error(`Confirmation email failed for ${bookingData.userEmail}: ${emailErr.message}`);
                    }
                    
                    return res.status(200).json({ status: 'OK' });
                }

                // If not a public ticket, assume it's a Competition Registration
                const docRef = db.collection('Registrants2025').doc(firebaseId);

                // Double check if doc exists before updating
                const docSnap = await docRef.get();
                if (docSnap.exists) {
                    await docRef.update({
                        paymentStatus: 'PAID',
                        paidAt: new Date(),
                        amountPaid: payloadData.invoice.amount || payloadData.invoice.amount_due || 0,
                        paymentMethod: payloadData.payment_info?.method || 'paper_id',
                        paymentDetails: payloadData // Save full log for audit trail
                    });
                    logger.info(`payment status updated successfully for ${firebaseId}`)
                    console.log(`✅ Firebase updated successfully for ${firebaseId}`);

                    const docData = docSnap.data();
                    const performers = docData.performers || [];
                    logger.info(`[PAPER_WEBHOOK_PERFORMERS] Registrant ${firebaseId} performers data: ${JSON.stringify(performers)}`);

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
                    logger.info(`[PAPER_WEBHOOK] Sending confirmation emails for ${dataEmailList.length} groups... Email list: ${JSON.stringify(dataEmailList)}`);

                    // Iterate and send emails individually (since we are in the backend)
                    for (const emailData of dataEmailList) {
                        try {
                            // A. Send Confirmation Email to User
                            // Ensure 'sendEmailFunc' is exported in your EmailService module
                            const sendUserResult = await emailService.sendEmailFunc(emailData);
                            logger.info(`[PAPER_WEBHOOK_EMAIL_SUCCESS_1] ✅ Confirmation email sent to ${emailData.email}. Result: ${JSON.stringify(sendUserResult || {})}`);

                            // B. Send Notification Email to APCS Admin
                            const sendAdminResult = await emailService.sendEmailNotifyApcs(emailData);
                            logger.info(`[PAPER_WEBHOOK_EMAIL_SUCCESS_2] ✅ Admin notification sent for ${emailData.name}. Result: ${JSON.stringify(sendAdminResult || {})}`);

                        } catch (emailError) {
                            // Log error but don't fail the webhook response
                            logger.error(`[PAPER_WEBHOOK_EMAIL_ERROR] ❌ Failed to send email for ${emailData.email}: ${emailError.message} - Stack: ${emailError.stack}`);
                        }
                    }

                } else {
                    logger.error(`⚠️ Registrant document ${firebaseId} not found!`);
                    console.warn(`⚠️ Registrant document ${firebaseId} not found!`);
                }
            }
        } else {
            logger.error("Webhook received but status is not 'paid', ignoring.");
            console.log("Webhook received but status is not 'paid', ignoring.");
        }

        // Always return 200 to Paper.id so they know you received it
        res.status(200).json({ status: 'OK' });

    } catch (error) {
        console.error("Webhook Processing Error:", error);
        logger.error(`[PAPER_WEBHOOK_FATAL_ERROR] Webhook Processing Error: ${error.message} - Stack: ${error.stack}`);
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

async function resendConfirmationEmail(req, res, next) {
    try {
        const { registrantId } = req.body;

        if (!registrantId) {
            return res.status(400).json({ message: "registrantId is required" });
        }

        logger.info(`[RESEND_EMAIL] Admin triggered resend for registrant: ${registrantId}`);

        const docRef = db.collection('Registrants2025').doc(registrantId);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            logger.error(`[RESEND_EMAIL] Registrant document ${registrantId} not found`);
            return res.status(404).json({ message: `Registrant ${registrantId} not found` });
        }

        const docData = docSnap.data();
        const performers = docData.performers || [];

        if (performers.length === 0) {
            return res.status(400).json({ message: "No performers found for this registrant" });
        }

        // Format the price (same logic as webhook)
        const formattedPrice = new Intl.NumberFormat('id-ID', {
            style: 'currency',
            currency: 'IDR',
            minimumFractionDigits: 0
        }).format(docData.amountToPay || 0);

        // Group performers by email (same logic as webhook)
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
            const fullName = performer.fullName || `${performer.firstName} ${performer.lastName}`;
            acc[email].names.push(fullName);
            return acc;
        }, {});

        const dataEmailList = Object.values(emailGroups).map(group => ({
            email: group.email,
            name: group.names.join(' and '),
            competitionCategory: group.competitionCategory,
            instrumentCategory: group.instrumentCategory,
            price: group.price
        }));

        logger.info(`[RESEND_EMAIL] Sending confirmation emails for ${dataEmailList.length} groups...`);

        const results = [];
        for (const emailData of dataEmailList) {
            try {
                const sendUserResult = await emailService.sendEmailFunc(emailData);
                logger.info(`[RESEND_EMAIL_SUCCESS] ✅ Confirmation email sent to ${emailData.email}`);

                const sendAdminResult = await emailService.sendEmailNotifyApcs(emailData);
                logger.info(`[RESEND_EMAIL_SUCCESS] ✅ Admin notification sent for ${emailData.name}`);

                results.push({ email: emailData.email, status: 'sent' });
            } catch (emailError) {
                logger.error(`[RESEND_EMAIL_ERROR] ❌ Failed for ${emailData.email}: ${emailError.message}`);
                results.push({ email: emailData.email, status: 'failed', error: emailError.message });
            }
        }

        return res.status(200).json({
            message: `Resend completed for ${registrantId}`,
            results
        });

    } catch (error) {
        logger.error(`[RESEND_EMAIL_FATAL] Error: ${error.message}`);
        next(error);
    }
}

module.exports = {
    createInvoice,
    handlePaperWebhook,
    checkPaymentStatus,
    resendConfirmationEmail
};