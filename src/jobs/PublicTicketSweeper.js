const { db } = require('../configs/firebase-init');
const admin = require('firebase-admin');
const { logger } = require('../utils/Logger');
const PaperRepository = require('../repositories/PaperRepository');

const SWEEPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const startPublicTicketSweeper = () => {
    setInterval(async () => {
        try {
            const pendingBookingsSnap = await db.collection('publicBookings')
                .where('paymentStatus', '==', 'pending')
                .get();
                
            if (pendingBookingsSnap.empty) return;
            
            const batch = db.batch();
            let expiredCount = 0;
            
            for (const doc of pendingBookingsSnap.docs) {
                const data = doc.data();
                
                // If the lock has expired
                if (data.lockExpiresAt && data.lockExpiresAt.toDate().getTime() < Date.now()) {
                    expiredCount++;
                    const bookingId = doc.id;
                    logger.info(`[SWEEPER] Found expired pending booking ${bookingId}. Cleaning up.`);
                    
                    // 1. Delete invoice in Paper.id
                    if (data.invoiceId) {
                        await PaperRepository.deleteInvoice(data.invoiceId);
                    }
                    
                    // 2. Mark as expired
                    batch.update(doc.ref, { paymentStatus: 'expired' });
                    
                    // 3. Release seats
                    if (data.eventId && data.selectedSeatIds && data.selectedSeatIds.length > 0) {
                        data.selectedSeatIds.forEach(seatId => {
                            const seatRef = db.collection(`seats${data.eventId}`).doc(seatId);
                            batch.update(seatRef, { status: 'available', lockedAt: null, lockedByBookingId: null });
                        });
                    }
                }
            }
            
            if (expiredCount > 0) {
                await batch.commit();
                logger.info(`[SWEEPER] Cleaned up ${expiredCount} expired public bookings.`);
            }
            
        } catch (error) {
            logger.error(`[SWEEPER] Error cleaning up expired bookings: ${error.message}`);
        }
    }, SWEEPER_INTERVAL_MS);
    
    logger.info(`[SWEEPER] Public ticket sweeper started (runs every ${SWEEPER_INTERVAL_MS / 1000}s)`);
};

module.exports = {
    startPublicTicketSweeper
};
