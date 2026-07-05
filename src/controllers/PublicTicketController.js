const PublicTicketService = require('../services/PublicTicketService');
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

        // Resolve dynamic venue label
        let resolvedVenueLabel = req.body.venue;
        try {
            const eventData = await PublicTicketService.getPublicTicketEventData();
            if (eventData && eventData.venues) {
                const venueObj = eventData.venues.find(v => v.id === req.body.venue);
                if (venueObj) resolvedVenueLabel = venueObj.label;
            }
        } catch (e) {
            logger.warn(`Could not fetch dynamic venue label: ${e.message}`);
        }

        // Send "seats locked" holding email
        try {
            await emailService.sendPublicSeatHoldEmail({
                to: req.body.userEmail,
                name: req.body.buyerName,
                registrantName: req.body.registrantName,
                venueName: resolvedVenueLabel,
                date: req.body.date,
                session: req.body.session,
                paymentUrl: data.paymentUrl,
                lockExpiresAt: data.lockExpiresAt,
                totalAmount: req.body.totalAmount, // display only; server re-calculated
            });
        } catch (emailErr) {
            // Non-fatal: don't fail the booking if email fails
            logger.error(`Seat-hold email failed for ${req.body.userEmail}: ${emailErr.message}`);
        }

        res.status(201).json(data);
    } catch (err) {
        next(err);
    }
}

/** POST /api/v1/apcs/public-ticket/webhook — Paper.id calls this on payment success */
async function handlePublicTicketWebhook(req, res, next) {
    try {
        const payload = req.body;
        logger.info('Public ticket webhook received: ' + JSON.stringify(payload));

        const paperEnv = process.env.PAPER_ENV || 'development';
        const payloadData = (paperEnv === 'production' || paperEnv === 'Production' || paperEnv === 'prod') ? payload : payload.data;
        const isPaid = payloadData.invoice && payloadData.invoice.status?.toLowerCase() === 'paid';

        if (isPaid) {
            const bookingId = payloadData.invoice.number; // we set number = bookingId
            logger.info(`Processing paid public booking: ${bookingId}`);

            const bookingData = await PublicTicketService.handlePublicTicketWebhookPaid(bookingId, payloadData);

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

module.exports = {
    getPublicTicketEventData,
    createPublicTicketBooking,
    handlePublicTicketWebhook,
    getPublicTicketSeats,
    getEligibleWinners,
    getBookingStatus
};
