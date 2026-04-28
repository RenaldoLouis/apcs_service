const { db, admin } = require('../configs/firebase-init');
const { logger } = require('../utils/Logger');
const jwt = require('jsonwebtoken');
const PaperRepository = require('./PaperRepository');

const JWT_SECRET = process.env.JWT_SECRET;
const LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes in milliseconds
const EVENT_ID = 'APCS2026';

/**
 * Returns the events/APCS2026 document for the frontend to render
 * pricing tiers, sessions, and add-ons.
 */
const getPublicTicketEventData = async (_body, callback) => {
    try {
        const docRef = db.collection('events').doc(EVENT_ID);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            throw new Error(`Event data for ${EVENT_ID} not found in events collection.`);
        }

        callback(null, { id: docSnap.id, ...docSnap.data() });
    } catch (error) {
        logger.error(`getPublicTicketEventData failed: ${error.message}`);
        callback(error);
    }
};

/**
 * Returns the seat layout for a specific venue and session.
 * Cleans up sensitive data and evaluates expired locks before returning.
 */
const getPublicTicketSeats = async (query, callback) => {
    try {
        const { venueId, sessionId } = query;
        if (!venueId || !sessionId) {
            return callback(new Error('venueId and sessionId are required.'));
        }

        const seatsRef = db.collection(`seats${EVENT_ID}`);
        const q = seatsRef
            .where('venueId', '==', venueId)
            .where('sessionId', '==', sessionId);
        
        const snap = await q.get();
        const seats = snap.docs.map(doc => {
            const data = doc.data();
            
            // Clean up sensitive fields
            delete data.assignedTo;
            delete data.bookingId;
            delete data.lockedByBookingId;
            
            // Evaluate locks lazily
            if (data.status === 'locked' && data.lockedAt) {
                const isExpiredLock = (Date.now() - data.lockedAt.toDate().getTime()) > LOCK_DURATION_MS;
                if (isExpiredLock) {
                    data.status = 'available';
                }
            }

            return { id: doc.id, ...data };
        });
        callback(null, seats);
    } catch (error) {
        logger.error(`getPublicTicketSeats failed: ${error.message}`);
        callback(error);
    }
};

/**
 * Creates a public ticket booking.
 * Steps:
 *  1. Server-side price recalculation (never trust client).
 *  2. Atomic Firestore transaction: check seats available → lock them → create booking doc.
 *  3. Call Paper.id to generate payment invoice.
 *  4. Send "seats locked" holding email to the user.
 * Returns { bookingId, paymentUrl }.
 */
const createPublicTicketBooking = async (body, callback) => {
    const {
        userName, userEmail, userPhone,
        venue, date, session,
        tickets,      // [{ id, name, quantity, wantsSeat, seatQuantity }]
        selectedSeatIds, // [seatDocumentId, ...]
        addOnIds,     // ['merchandise', ...]
    } = body;

    // --- 1. Basic validation ---
    if (!userName || !userEmail || !userPhone || !venue || !date || !session || !tickets) {
        return callback(new Error('Missing required booking fields.'));
    }

    try {
        // --- 2. Fetch authoritative pricing from Firestore ---
        const eventRef = db.collection('events').doc(EVENT_ID);
        const eventSnap = await eventRef.get();
        if (!eventSnap.exists) {
            throw new Error(`Event ${EVENT_ID} not found.`);
        }
        const eventData = eventSnap.data();

        // Build a quick lookup: tierId → price
        const tierPriceMap = {};
        (eventData.ticketTiers || []).forEach(t => { tierPriceMap[t.id] = t.price; });

        const addOnPriceMap = {};
        (eventData.addOns || []).forEach(a => { addOnPriceMap[a.id] = { price: a.price, name: a.name }; });

        // --- 3. Recalculate total server-side ---
        let totalAmount = 0;
        const lineItems = [];

        tickets.forEach(ticket => {
            if (ticket.quantity > 0) {
                const price = tierPriceMap[ticket.id];
                if (price === undefined) throw new Error(`Unknown ticket tier: ${ticket.id}`);
                const subtotal = price * ticket.quantity;
                totalAmount += subtotal;
                lineItems.push({
                    name: `${ticket.name} Ticket`,
                    description: `${ticket.quantity}x ${ticket.name} – ${venue === 'Venue1' ? 'Jatayu' : 'Melati'} | ${date} ${session}`,
                    price: subtotal,
                    currency: 'IDR',
                });
            }
        });

        (addOnIds || []).forEach(addOnId => {
            const addOn = addOnPriceMap[addOnId];
            if (addOn) {
                totalAmount += addOn.price;
                lineItems.push({
                    name: addOn.name,
                    description: 'Add-on',
                    price: addOn.price,
                    currency: 'IDR',
                });
            }
        });

        // --- 4. Atomic Firestore transaction: lock seats + create booking ---
        const bookingRef = db.collection('publicBookings2026').doc();
        const bookingId = bookingRef.id;
        const lockedAt = admin.firestore.FieldValue.serverTimestamp();
        const lockExpiresAt = new Date(Date.now() + LOCK_DURATION_MS);

        await db.runTransaction(async (transaction) => {
            // Check every selected seat is still available
            if (selectedSeatIds && selectedSeatIds.length > 0) {
                const seatRefs = selectedSeatIds.map(id => db.collection(`seats${EVENT_ID}`).doc(id));
                const seatDocs = await transaction.getAll(...seatRefs);

                for (const seatDoc of seatDocs) {
                    if (!seatDoc.exists) {
                        throw new Error(`Seat ${seatDoc.id} does not exist.`);
                    }
                    const seatData = seatDoc.data();

                    // A seat is bookable if it's 'available', OR if it's 'locked' but the lock has expired (>30 min).
                    // This lazy check eliminates the need for a separate cleanup cron job.
                    const isAvailable = seatData.status === 'available';
                    const isExpiredLock = seatData.status === 'locked'
                        && seatData.lockedAt
                        && (Date.now() - seatData.lockedAt.toDate().getTime()) > LOCK_DURATION_MS;

                    if (!isAvailable && !isExpiredLock) {
                        throw new Error(`Seat ${seatData.seatLabel} is no longer available. Please go back and re-select.`);
                    }

                    // If we're reclaiming an expired lock, also mark the old booking as expired
                    if (isExpiredLock && seatData.lockedByBookingId) {
                        const oldBookingRef = db.collection('publicBookings2026').doc(seatData.lockedByBookingId);
                        transaction.update(oldBookingRef, { paymentStatus: 'expired' });
                    }
                    // Lock the seat
                    transaction.update(seatDoc.ref, {
                        status: 'locked',
                        lockedAt: lockedAt,
                        lockedByBookingId: bookingId,
                    });
                }
            }

            // Create the booking document
            transaction.set(bookingRef, {
                eventId: EVENT_ID,
                userName,
                userEmail,
                userPhone,
                venue,
                date,
                session,
                tickets,
                selectedSeatIds: selectedSeatIds || [],
                addOnIds: addOnIds || [],
                totalAmount,
                paymentStatus: 'pending',
                seatsSelected: (selectedSeatIds || []).length > 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lockExpiresAt: lockExpiresAt,
            });
        });

        logger.info(`Public booking ${bookingId} created. Seats locked: ${(selectedSeatIds || []).join(', ')}`);

        // --- 5. Create Paper.id invoice ---
        // Format deadline string for display in invoice notes
        const deadlineStr = lockExpiresAt.toLocaleString('id-ID', {
            timeZone: 'Asia/Jakarta',
            day: '2-digit', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        }) + ' WIB';

        const invoiceBody = {
            externalId: bookingId,
            user: {
                name: userName,
                email: userEmail,
                phone: userPhone.replace('+', ''),
            },
            items: lineItems,
            notes: `Your selected seat(s) are held for 30 minutes. Please complete payment before ${deadlineStr}. After this time your seat reservation will be released.`,
        };

        // Use PaperRepository directly (same pattern it already uses)
        const paperResult = await new Promise((resolve, reject) => {
            PaperRepository.createInvoice(invoiceBody, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });

        callback(null, {
            bookingId,
            paymentUrl: paperResult.paymentUrl,
            lockExpiresAt: lockExpiresAt.toISOString(),
        });

    } catch (error) {
        logger.error(`createPublicTicketBooking failed: ${error.message}`);

        // Rollback: release any seats that were locked
        if (selectedSeatIds && selectedSeatIds.length > 0) {
            try {
                const batch = db.batch();
                selectedSeatIds.forEach(seatId => {
                    const seatRef = db.collection(`seats${EVENT_ID}`).doc(seatId);
                    batch.update(seatRef, { status: 'available', lockedAt: null, lockedByBookingId: null });
                });
                await batch.commit();
                logger.info(`Rollback complete: seats released for failed booking.`);
            } catch (rollbackErr) {
                logger.error(`Rollback failed: ${rollbackErr.message}`);
            }
        }

        callback(error);
    }
};

/**
 * Called by the Paper.id webhook when payment is confirmed (isPaid = true).
 * Upgrades seat status from 'locked' → 'reserved' and marks booking as PAID.
 * Returns the booking data for the caller to use when sending the confirmation email.
 */
const handlePublicTicketWebhookPaid = async (bookingId, payloadData) => {
    const bookingRef = db.collection('publicBookings2026').doc(bookingId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
        throw new Error(`Public booking ${bookingId} not found.`);
    }

    const bookingData = bookingSnap.data();

    // Idempotency guard: if already paid, skip
    if (bookingData.paymentStatus === 'PAID') {
        logger.info(`Booking ${bookingId} already marked PAID. Skipping.`);
        return bookingData;
    }

    // Upgrade seats + mark booking paid in a batch
    const batch = db.batch();

    (bookingData.selectedSeatIds || []).forEach(seatId => {
        const seatRef = db.collection(`seats${EVENT_ID}`).doc(seatId);
        batch.update(seatRef, {
            status: 'reserved',
            bookingId,
            lockedAt: admin.firestore.FieldValue.delete(),
            lockedByBookingId: admin.firestore.FieldValue.delete(),
            assignedTo: {
                name: bookingData.userName,
                email: bookingData.userEmail,
            },
        });
    });

    batch.update(bookingRef, {
        paymentStatus: 'PAID',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        amountPaid: payloadData?.invoice?.total_amount || bookingData.totalAmount,
        paymentDetails: payloadData,
    });

    await batch.commit();
    logger.info(`Booking ${bookingId} marked PAID. Seats permanently reserved.`);

    return { id: bookingId, ...bookingData };
};

module.exports = {
    getPublicTicketEventData,
    createPublicTicketBooking,
    handlePublicTicketWebhookPaid,
    getPublicTicketSeats,
};
