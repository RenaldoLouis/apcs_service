const { db } = require('../configs/firebase-init');
const admin = require('firebase-admin');
const PaperRepository = require('./PaperRepository');
const { logger } = require('../utils/Logger');

const SEAT_OWNERSHIP_COLLECTION = 'ticketSeatOwnership';
const CAPACITY_COLLECTION = 'ticketCapacity';
const WINNER_CLAIM_COLLECTION = 'winnerOrchestraClaims';
const safeDocumentId = value => encodeURIComponent(String(value ?? '')).replace(/%/g, '_');

const getBookingInventory = async (transaction, booking) => {
    const seatIds = [...new Set([...(booking.selectedSeatIds || []), ...(booking.orchestraSelectedSeatIds || [])])];
    const seatRefs = booking.eventId ? seatIds.map(id => db.collection(`seats${booking.eventId}`).doc(id)) : [];
    const seats = seatRefs.length ? await transaction.getAll(...seatRefs) : [];
    const ownershipRefs = (booking.physicalSeatKeys || []).map(key =>
        db.collection(SEAT_OWNERSHIP_COLLECTION).doc(safeDocumentId(key)));
    const ownershipDocs = ownershipRefs.length ? await transaction.getAll(...ownershipRefs) : [];
    const quota = Number(booking.complimentaryTickets || 0);
    const eventRef = booking.eventId && quota > 0 ? db.collection('events').doc(booking.eventId) : null;
    const eventDoc = eventRef ? await transaction.get(eventRef) : null;
    const capacityRef = booking.capacityReservation?.capacityId
        ? db.collection(CAPACITY_COLLECTION).doc(booking.capacityReservation.capacityId) : null;
    const capacityDoc = capacityRef ? await transaction.get(capacityRef) : null;
    const winnerClaimRef = booking.winnerClaimId
        ? db.collection(WINNER_CLAIM_COLLECTION).doc(booking.winnerClaimId) : null;
    const winnerClaimDoc = winnerClaimRef ? await transaction.get(winnerClaimRef) : null;
    return {
        seats, ownershipDocs, quota, eventRef, eventDoc,
        capacityRef, capacityDoc, winnerClaimRef, winnerClaimDoc,
    };
};

const releaseBookingInventory = async (bookingId, terminalStatus, updateBooking) => {
    const bookingRef = db.collection('publicBookings').doc(bookingId);
    return db.runTransaction(async transaction => {
        const bookingDoc = await transaction.get(bookingRef);
        if (!bookingDoc.exists) return null;
        const booking = bookingDoc.data();
        if (booking.paymentStatus === 'PAID' || booking.paymentStatus === 'paid' || booking.paymentStatus === 'expired') return null;
        // Failed bookings retain the `failed` status after a successful release.
        // The completion marker, not the status alone, is the exactly-once guard
        // for a repeated cancellation acknowledgement or retry worker.
        if (booking.paymentStatus === 'failed' && booking.checkoutFailure?.cleanupStatus === 'complete'
            && booking.checkoutFailure?.invoiceCancellationStatus !== 'not_requested') return null;

        // Firestore requires every dependent read before the first write.
        const {
            seats, ownershipDocs, quota, eventRef, eventDoc,
            capacityRef, capacityDoc, winnerClaimRef, winnerClaimDoc,
        } = await getBookingInventory(transaction, booking);
        const event = eventDoc?.exists ? eventDoc.data() : null;
        const sessions = event?.orchestraSessions || [];
        const sessionIndex = sessions.findIndex(session => session.id === booking.orchestraSessionId);
        const claimed = sessionIndex >= 0 ? Number(sessions[sessionIndex].complimentaryClaimed) : NaN;
        const canRefund = quota > 0 && Number.isFinite(claimed) && claimed >= quota;
        const reconciliationReasons = [];
        if (!booking.eventId) reconciliationReasons.push('missing_event_id');
        if (quota > 0 && !canRefund) reconciliationReasons.push('quota_configuration_unavailable_or_inconsistent');

        for (const seat of seats) {
            if (!seat.exists) continue;
            const data = seat.data();
            if (data.status === 'locked' && data.lockedByBookingId === bookingId) {
                transaction.update(seat.ref, {
                    status: 'available',
                    lockedAt: admin.firestore.FieldValue.delete(),
                    lockedByBookingId: admin.firestore.FieldValue.delete(),
                });
            }
        }
        for (const ownership of ownershipDocs) {
            if (ownership.exists && ownership.data().bookingId === bookingId && ownership.data().active !== false) {
                transaction.update(ownership.ref, {
                    active: false,
                    status: 'released',
                    releasedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            }
        }
        if (capacityDoc?.exists) {
            const reservedByTier = { ...(capacityDoc.data().reservedByTier || {}) };
            Object.entries(booking.capacityReservation?.byTier || {}).forEach(([tierId, quantity]) => {
                reservedByTier[tierId] = Math.max(0, Number(reservedByTier[tierId] || 0) - Number(quantity || 0));
            });
            transaction.update(capacityRef, {
                reservedByTier,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }
        if (winnerClaimDoc?.exists && winnerClaimDoc.data().bookingId === bookingId
            && winnerClaimDoc.data().active !== false) {
            transaction.update(winnerClaimRef, {
                active: false,
                releasedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }
        if (canRefund) {
            const updatedSessions = sessions.map((session, index) => index === sessionIndex
                ? { ...session, complimentaryClaimed: claimed - quota } : session);
            transaction.update(eventRef, { orchestraSessions: updatedSessions });
        }

        transaction.update(bookingRef, updateBooking(booking, {
            paymentStatus: terminalStatus,
            reconciliationReasons,
            quotaRefundStatus: quota > 0
                ? (canRefund ? 'refunded' : 'reconciliation_required')
                : 'not_applicable',
        }));
        return booking;
    });
};

const recordCancellationResult = async (bookingId, field, status) => {
    const bookingRef = db.collection('publicBookings').doc(bookingId);
    await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(bookingRef);
        if (!snapshot.exists) return;
        const booking = snapshot.data();
        if (booking.paymentStatus === 'PAID' || booking.paymentStatus === 'paid' || booking.paymentStatus === 'expired') return;
        transaction.update(bookingRef, { [field]: { ...(booking[field] || {}), invoiceCancellationStatus: status } });
    });
};

const cancelKnownInvoice = async (bookingId, invoiceId, field) => {
    if (!invoiceId) return false;
    let canceled = false;
    try {
        canceled = Boolean(await PaperRepository.deleteInvoice(invoiceId));
    } catch (error) {
        logger.error(`Invoice cancellation failed for booking ${bookingId}: ${error.message}`);
    }
    if (!canceled) await recordCancellationResult(bookingId, field, 'failed');
    return canceled;
};

// Promise-returning helper: callers must await and catch cleanup failures.
const failPublicTicketBooking = async (bookingId, failure = {}) => {
    const bookingRef = db.collection('publicBookings').doc(bookingId);
    const cancellation = await db.runTransaction(async transaction => {
        const bookingDoc = await transaction.get(bookingRef);
        if (!bookingDoc.exists) return null;
        const booking = bookingDoc.data();
        if (!['pending', 'failed'].includes(booking.paymentStatus)) return null;

        const previous = booking.checkoutFailure || {};
        if (previous.cleanupStatus === 'complete' || previous.invoiceCancellationStatus === 'pending') return null;
        const invoiceId = booking.invoiceId || failure.invoiceId || null;
        const hasUnresolvedProviderOutcome = Boolean(invoiceId)
            || failure.invoiceCreationAttempted
            || previous.invoiceCancellationStatus === 'unknown';
        const invoiceCancellationStatus = invoiceId ? 'pending'
            : failure.invoiceCreationAttempted ? 'unknown' : 'not_requested';

        // A known payable invoice must retain its inventory until Paper confirms cancellation.
        transaction.update(bookingRef, {
            paymentStatus: 'failed',
            failedAt: booking.failedAt || admin.firestore.FieldValue.serverTimestamp(),
            ...(invoiceId ? { invoiceId } : {}),
            checkoutFailure: {
                reason: failure.reason || previous.reason || 'Checkout failed',
                cleanupStatus: hasUnresolvedProviderOutcome ? 'awaiting_cancellation' : 'complete',
                quotaRefundStatus: hasUnresolvedProviderOutcome ? 'held' : 'not_applicable',
                reconciliationReasons: hasUnresolvedProviderOutcome ? ['provider_cancellation_required'] : [],
                invoiceCancellationStatus,
            },
        });
        return { invoiceId, releaseWithoutInvoice: !hasUnresolvedProviderOutcome };
    });

    if (!cancellation) return;
    if (cancellation.releaseWithoutInvoice) {
        await releaseBookingInventory(bookingId, 'failed', (booking, result) => ({
            paymentStatus: result.paymentStatus,
            checkoutFailure: {
                ...(booking.checkoutFailure || {}), cleanupStatus: 'complete',
                quotaRefundStatus: result.quotaRefundStatus,
                reconciliationReasons: result.reconciliationReasons,
                invoiceCancellationStatus: 'not_requested',
            },
        }));
        return;
    }

    const canceled = await cancelKnownInvoice(bookingId, cancellation.invoiceId, 'checkoutFailure');
    if (!canceled) return;
    await releaseBookingInventory(bookingId, 'failed', (booking, result) => ({
        paymentStatus: result.paymentStatus,
        checkoutFailure: {
            ...(booking.checkoutFailure || {}), cleanupStatus: 'complete',
            quotaRefundStatus: result.quotaRefundStatus,
            reconciliationReasons: result.reconciliationReasons,
            invoiceCancellationStatus: 'canceled',
        },
    }));
};

const expirePublicTicketBooking = async bookingId => {
    const bookingRef = db.collection('publicBookings').doc(bookingId);
    const snapshot = await bookingRef.get();
    if (!snapshot.exists) return false;
    const booking = snapshot.data();
    if (booking.paymentStatus !== 'pending' || !booking.lockExpiresAt
        || booking.lockExpiresAt.toDate().getTime() > Date.now()) return false;

    if (!booking.invoiceId) {
        await recordCancellationResult(bookingId, 'expiry', 'unknown');
        return false;
    }
    const canceled = await cancelKnownInvoice(bookingId, booking.invoiceId, 'expiry');
    if (!canceled) return false;
    const released = await releaseBookingInventory(bookingId, 'expired', (current, result) => ({
        paymentStatus: result.paymentStatus,
        expiredAt: admin.firestore.FieldValue.serverTimestamp(),
        expiry: {
            ...(current.expiry || {}), invoiceCancellationStatus: 'canceled',
            quotaRefundStatus: result.quotaRefundStatus,
            reconciliationReasons: result.reconciliationReasons,
        },
    }));
    return Boolean(released);
};

module.exports = { failPublicTicketBooking, expirePublicTicketBooking };
