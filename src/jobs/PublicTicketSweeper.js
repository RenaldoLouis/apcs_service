const { db } = require('../configs/firebase-init');
const { logger } = require('../utils/Logger');
const { expirePublicTicketBooking } = require('../repositories/PublicTicketFailureRepository');

const SWEEPER_INTERVAL_MS = 5 * 60 * 1000;

const startPublicTicketSweeper = () => {
    setInterval(async () => {
        try {
            const pendingBookingsSnap = await db.collection('publicBookings')
                .where('paymentStatus', '==', 'pending')
                .get();
            if (pendingBookingsSnap.empty) return;

            let releasedCount = 0;
            for (const doc of pendingBookingsSnap.docs) {
                const booking = doc.data();
                if (!booking.lockExpiresAt || booking.lockExpiresAt.toDate().getTime() >= Date.now()) continue;
                logger.info(`[SWEEPER] Requesting provider cancellation for expired public booking ${doc.id}.`);
                try {
                    if (await expirePublicTicketBooking(doc.id)) releasedCount++;
                } catch (error) {
                    logger.error(`[SWEEPER] Expiry cleanup failed for ${doc.id}: ${error.message}`);
                }
            }
            if (releasedCount > 0) logger.info(`[SWEEPER] Released ${releasedCount} provider-canceled public bookings.`);
        } catch (error) {
            logger.error(`[SWEEPER] Error processing expired public bookings: ${error.message}`);
        }
    }, SWEEPER_INTERVAL_MS);

    logger.info(`[SWEEPER] Public ticket sweeper started (runs every ${SWEEPER_INTERVAL_MS / 1000}s)`);
};

module.exports = { startPublicTicketSweeper };
