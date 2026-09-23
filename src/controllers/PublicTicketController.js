const PublicTicketService = require('../services/PublicTicketService');
const PublicTicketAdminReleaseService = require('../services/PublicTicketAdminReleaseService');
const PublicTicketRepository = require('../repositories/PublicTicketRepository');
const { db } = require('../configs/firebase-init');
const emailService = require('../services/EmailService');
const { logger } = require('../utils/Logger');

/** GET /api/v1/apcs/public-ticket/event-data */
async function getPublicTicketEventData(req, res, next) {
    try {
        const data = await PublicTicketService.getPublicTicketEventData();
        res.status(200).json(data);
    } catch (err) {
        next(err);
    }
}

/** GET /api/v1/apcs/public-ticket/booking-status/:bookingId */
async function getBookingStatus(req, res, next) {
    try {
        const { bookingId } = req.params;
        if (!bookingId) return res.status(400).json({ message: "Booking ID required" });

        const bookingRef = require('../configs/firebase-init').db.collection('publicBookings').doc(bookingId);
        const bookingSnap = await bookingRef.get();

        if (!bookingSnap.exists) {
            return res.status(404).json({ message: "Booking not found" });
        }

        const data = bookingSnap.data();
        
        // Return only safe polling data
        return res.status(200).json({
            paymentStatus: data.paymentStatus,
            paymentMode: data.paymentMode || 'paper_id',
            paymentUrl: data.paymentUrl,
            lockExpiresAt: data.lockExpiresAt ? data.lockExpiresAt.toDate().toISOString() : null
        });
    } catch (err) {
        next(err);
    }
}

/** POST /api/v1/apcs/public-ticket/booking */
async function createPublicTicketBooking(req, res, next) {
    try {
        const data = await PublicTicketService.createPublicTicketBooking(req);
        // data = { bookingId, paymentUrl, lockExpiresAt }

        if (data.paymentMode === 'manual') {
            const bookingRef = db.collection('publicBookings').doc(data.bookingId);
            const snapshot = await bookingRef.get();
            if (!snapshot.exists) throw new Error('Manual booking could not be loaded after checkout.');
            try {
                await emailService.sendManualTicketPaymentInstructions({ id: snapshot.id, ...snapshot.data() });
                await bookingRef.update({ manualInstructionsEmailSent: true });
            } catch (emailErr) {
                logger.error(`Manual payment email failed for ${data.bookingId}: ${emailErr.message}`);
                await bookingRef.update({ manualInstructionsEmailSent: false });
                return res.status(503).json({
                    bookingId: data.bookingId,
                    message: `Booking ${data.bookingId} is reserved, but payment instructions could not be emailed. Retry or contact APCS with this booking ID.`,
                });
            }
            return res.status(201).json(data);
        }

        const bookingSnap = await db.collection('publicBookings').doc(data.bookingId).get();
        if (!bookingSnap.exists) throw new Error('Booking could not be loaded after checkout.');
        const booking = bookingSnap.data();

        // Send "seats locked" holding email
        try {
            await emailService.sendPublicSeatHoldEmail({
                to: booking.userEmail,
                name: booking.buyerName,
                registrantName: booking.registrantName,
                venueName: booking.venueName || booking.venue,
                date: booking.date,
                session: booking.session,
                paymentUrl: data.paymentUrl,
                lockExpiresAt: data.lockExpiresAt,
                totalAmount: booking.totalAmount,
            });
        } catch (emailErr) {
            // Non-fatal: don't fail the booking if email fails
            logger.error(`Seat-hold email failed for ${booking.userEmail}: ${emailErr.message}`);
        }

        res.status(201).json(data);
    } catch (err) {
        next(err);
    }
}

/** POST /api/v1/apcs/public-ticket/admin/mark-manual-paid */
async function markManualBookingPaid(req, res, next) {
    try {
        const bookingId = String(req.body?.bookingId || '').trim();
        if (!bookingId) return res.status(400).json({ message: 'bookingId is required' });
        const booking = await PublicTicketRepository.markManualBookingPaid(bookingId, req.ticketingAdmin);
        let emailSent = Boolean(booking.emailSent);
        if (!booking.alreadyPaid) {
            try {
                await emailService.sendPublicBookingConfirmationEmail(booking);
                await db.collection('publicBookings').doc(bookingId).update({ emailSent: true });
                emailSent = true;
            } catch (emailErr) {
                logger.error(`Manual payment confirmation email failed for ${bookingId}: ${emailErr.message}`);
                await db.collection('publicBookings').doc(bookingId).update({ emailSent: false });
                emailSent = false;
            }
        }
        return res.status(200).json({ bookingId, paymentStatus: 'PAID', emailSent });
    } catch (err) {
        return next(err);
    }
}

async function resendManualPaymentInstructions(req, res, next) {
    try {
        const bookingId = String(req.body?.bookingId || '').trim();
        if (!bookingId) return res.status(400).json({ message: 'bookingId is required' });
        const bookingRef = db.collection('publicBookings').doc(bookingId);
        const snapshot = await bookingRef.get();
        if (!snapshot.exists) return res.status(404).json({ message: 'Booking not found' });
        const booking = snapshot.data();
        if (booking.paymentMode !== 'manual' || booking.paymentStatus !== 'pending'
            || booking.invoiceId || booking.paymentUrl) {
            return res.status(409).json({ message: 'Only pending manual bookings can receive these instructions.' });
        }
        await emailService.sendManualTicketPaymentInstructions({ id: bookingId, ...booking });
        await bookingRef.update({ manualInstructionsEmailSent: true });
        return res.status(200).json({ bookingId, sent: true });
    } catch (err) {
        return next(err);
    }
}

/** POST /api/v1/apcs/public-ticket/webhook — Paper.id calls this on payment success */
async function handlePublicTicketWebhook(req, res, next) {
    try {
        const payload = req.body;
        logger.info('Public ticket webhook received: ' + JSON.stringify(payload));

        // Safely handle both Production (flat) and Development (nested in .data) payload structures automatically
        const payloadData = payload.invoice ? payload : (payload.data ? payload.data : payload);
        const isPaid = payloadData.invoice && payloadData.invoice.status?.toLowerCase() === 'paid';

        if (isPaid) {
            const bookingId = payloadData.invoice.number; // we set number = bookingId
            logger.info(`Processing paid public booking: ${bookingId}`);

            const bookingData = await PublicTicketService.handlePublicTicketWebhookPaid(bookingId, payloadData);


            // Send booking confirmation email
            try {
                await emailService.sendPublicBookingConfirmationEmail(bookingData);
            } catch (emailErr) {
                logger.error(`Confirmation email failed for ${bookingData.userEmail}: ${emailErr.message}`);
            }
        } else {
            logger.info('Public ticket webhook: status is not paid, ignoring.');
        }

        // Always respond 200 so Paper.id doesn't retry
        res.status(200).json({ status: 'OK' });
    } catch (err) {
        logger.error(`Public ticket webhook error: ${err.message}`);
        res.status(200).json({ status: 'Error handled' });
    }
}



/** GET /api/v1/apcs/public-ticket/seats */
async function getPublicTicketSeats(req, res, next) {
    try {
        const seats = await PublicTicketService.getPublicTicketSeats(req.query);
        res.status(200).json(seats);
    } catch (err) {
        next(err);
    }
}

/** GET /api/v1/apcs/public-ticket/eligible-winners */
async function getEligibleWinners(req, res, next) {
    try {
        const data = await PublicTicketService.getEligibleWinners(req.query);
        res.status(200).json(data);
    } catch (err) {
        next(err);
    }
}

/** POST /api/v1/apcs/public-ticket/resend-email */
async function resendPublicTicketEmail(req, res, next) {
    try {
        const { bookingId } = req.body;
        if (!bookingId) return res.status(400).json({ message: "bookingId is required" });

        const bookingRef = require('../configs/firebase-init').db.collection('publicBookings').doc(bookingId);
        const bookingSnap = await bookingRef.get();

        if (!bookingSnap.exists) {
            return res.status(404).json({ message: `Booking ${bookingId} not found` });
        }

        const bookingData = { id: bookingSnap.id, ...bookingSnap.data() };
        if (bookingData.paymentStatus !== 'PAID' && bookingData.paymentStatus !== 'paid') {
            return res.status(400).json({ message: "Booking is not paid yet." });
        }


        try {
            await emailService.sendPublicBookingConfirmationEmail(bookingData);
            await bookingRef.update({ emailSent: true });
            res.status(200).json({ message: "Email sent successfully" });
        } catch (emailErr) {
            logger.error(`Resend confirmation email failed for ${bookingData.userEmail}: ${emailErr.message}`);
            await bookingRef.update({ emailSent: false });
            return res.status(500).json({ message: "Failed to send email." });
        }
    } catch (err) {
        next(err);
    }
}

/** POST /api/v1/apcs/public-ticket/admin/release-booking */
async function releasePublicTicketBooking(req, res, next) {
    try {
        const { bookingId, reason, note, manualProviderConfirmation, paymentNotReceivedConfirmed } = req.body || {};
        if (!bookingId) return res.status(400).json({ message: 'bookingId is required' });

        const result = await PublicTicketAdminReleaseService.releasePublicTicketBooking(
            bookingId,
            { reason, note, manualProviderConfirmation, paymentNotReceivedConfirmed },
            req.ticketingAdmin,
        );
        return res.status(200).json(result);
    } catch (err) {
        return next(err);
    }
}

module.exports = {
    getPublicTicketEventData,
    createPublicTicketBooking,
    handlePublicTicketWebhook,
    getPublicTicketSeats,
    getEligibleWinners,
    getBookingStatus,
    resendPublicTicketEmail,
    releasePublicTicketBooking,
    markManualBookingPaid,
    resendManualPaymentInstructions,
};
