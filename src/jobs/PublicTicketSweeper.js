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
            
            let expiredCount = 0;
            
            for (const doc of pendingBookingsSnap.docs) {
                const data = doc.data();
                
                // If the lock has expired
                if (data.lockExpiresAt && data.lockExpiresAt.toDate().getTime() < Date.now()) {
                    const bookingId = doc.id;
                    logger.info(`[SWEEPER] Found expired pending booking ${bookingId}. Cleaning up.`);
                    
                    // 1. Delete invoice in Paper.id
                    if (data.invoiceId) {
                        try {
                            await PaperRepository.deleteInvoice(data.invoiceId);
                        } catch (err) {
                            logger.error(`[SWEEPER] Failed to delete invoice ${data.invoiceId}: ${err.message}`);
                        }
                    }
                    
                    // 2. Perform Firestore cleanup atomically
                    try {
                        await db.runTransaction(async (transaction) => {
                            const bDoc = await transaction.get(doc.ref);
                            if (!bDoc.exists || bDoc.data().paymentStatus !== 'pending') return;

                            // Mark as expired
                            transaction.update(doc.ref, { paymentStatus: 'expired' });

                            // Release normal seats
                            if (data.eventId && data.selectedSeatIds && data.selectedSeatIds.length > 0) {
                                data.selectedSeatIds.forEach(seatId => {
                                    const seatRef = db.collection(`seats${data.eventId}`).doc(seatId);
                                    transaction.update(seatRef, { status: 'available', lockedAt: null, lockedByBookingId: null });
                                });
                            }
                            
                            // Release orchestra complimentary seats
                            if (data.eventId && data.orchestraSelectedSeatIds && data.orchestraSelectedSeatIds.length > 0) {
                                data.orchestraSelectedSeatIds.forEach(seatId => {
                                    const seatRef = db.collection(`seats${data.eventId}`).doc(seatId);
                                    transaction.update(seatRef, { status: 'available', lockedAt: null, lockedByBookingId: null });
                                });
                            }

                            // Refund complimentary quota
                            if (data.eventId && data.orchestraSessionId && data.complimentaryTickets > 0) {
                                const eventRef = db.collection('events').doc(data.eventId);
                                const eventDoc = await transaction.get(eventRef);
                                if (eventDoc.exists) {
                                    const eventData = eventDoc.data();
                                    const osIndex = (eventData.orchestraSessions || []).findIndex(s => s.id === data.orchestraSessionId);
                                    if (osIndex !== -1) {
                                        const currentSession = eventData.orchestraSessions[osIndex];
                                        const claimed = currentSession.complimentaryClaimed || 0;
                                        const updatedSessions = [...eventData.orchestraSessions];
                                        updatedSessions[osIndex] = {
                                            ...currentSession,
                                            complimentaryClaimed: Math.max(0, claimed - data.complimentaryTickets)
                                        };
                                        transaction.update(eventRef, { orchestraSessions: updatedSessions });
                                    }
                                }
                            }
                        });
                        expiredCount++;
                    } catch (err) {
                        logger.error(`[SWEEPER] Firestore transaction failed for ${bookingId}: ${err.message}`);
                    }
                }
            }
            
            if (expiredCount > 0) {
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
