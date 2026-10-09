const { db, admin } = require('../configs/firebase-init');
const PaperRepository = require('./PaperRepository');
const { handlePublicTicketWebhookPaid } = require('./PublicTicketRepository');
const { logger } = require('../utils/Logger');

// Durable record of every paid Paper.id notification for an existing public booking.
// Written before fulfillment so a failed or premature callback can be replayed after restart.
const RECEIPT_COLLECTION = 'ticketPaymentReceipts';
const MAX_ATTEMPTS = 48;
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const safeDocumentId = value => encodeURIComponent(String(value ?? '')).replace(/%/g, '_');
const receiptIdFor = (bookingId, invoiceId) => safeDocumentId(`${bookingId}|${invoiceId || 'missing-invoice'}`);
const isPaid = booking => booking.paymentStatus === 'PAID' || booking.paymentStatus === 'paid';
const backoffMs = attempts => Math.min(MAX_BACKOFF_MS, 60 * 1000 * (2 ** Math.min(attempts, 10)));
// These outcomes cannot change by retrying; staff must reconcile them with the provider.
const TERMINAL_CODES = new Set([
    'BOOKING_NOT_FOUND', 'BOOKING_RELEASED', 'BOOKING_CANCELED', 'PAYMENT_INVOICE_MISMATCH',
    'PAYMENT_CURRENCY_MISMATCH', 'PAYMENT_AMOUNT_MISMATCH', 'SEAT_OWNERSHIP_LOST',
]);

const receiptRef = receiptId => db.collection(RECEIPT_COLLECTION).doc(receiptId);

// Promise-returning: a failure means no durable receipt exists and the caller must not acknowledge success.
const recordPaymentReceipt = async (bookingId, payloadData) => {
    const providerInvoiceId = String(payloadData?.invoice?.id || '').trim() || null;
    const ref = receiptRef(receiptIdFor(bookingId, providerInvoiceId));
    return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        const now = admin.firestore.FieldValue.serverTimestamp();
        if (snapshot.exists) {
            transaction.update(ref, { deliveryCount: Number(snapshot.data().deliveryCount || 1) + 1, lastReceivedAt: now });
            return { receiptId: ref.id, status: snapshot.data().status, duplicate: true };
        }
        transaction.set(ref, {
            bookingId, providerInvoiceId, payload: payloadData,
            status: 'pending', reason: 'received', attempts: 0, deliveryCount: 1,
            nextAttemptAt: Date.now(), receivedAt: now, lastReceivedAt: now,
        });
        return { receiptId: ref.id, status: 'pending', duplicate: false };
    });
};

// Records a non-final outcome on both the receipt and the booking marker shown to staff.
const settleReceipt = async (ref, { status, reason, detail = '' }) => {
    let settled = null;
    await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists || snapshot.data().status !== 'pending') return;
        const receipt = snapshot.data();
        const bookingRef = db.collection('publicBookings').doc(receipt.bookingId);
        const bookingSnap = await transaction.get(bookingRef);
        const attempts = Number(receipt.attempts || 0) + 1;
        const finalStatus = status === 'pending' && attempts >= MAX_ATTEMPTS ? 'needs_review' : status;
        const finalReason = finalStatus !== status ? 'retry_limit_reached' : reason;
        transaction.update(ref, {
            status: finalStatus, reason: finalReason, lastError: String(detail).slice(0, 500), attempts,
            nextAttemptAt: finalStatus === 'pending' ? Date.now() + backoffMs(attempts) : null,
            lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        if (bookingSnap.exists && !isPaid(bookingSnap.data()) && finalStatus !== 'ignored') {
            transaction.update(bookingRef, {
                paymentReceipt: { receiptId: ref.id, status: finalStatus, reason: finalReason },
            });
        }
        settled = { status: finalStatus, reason: finalReason };
    });
    return settled || { status: 'unchanged', reason };
};

/**
 * Attempts to apply one pending receipt. Saved invoice identity is trusted as before; any other
 * invoice ID is applied only after the authenticated Paper.id invoice API confirms that it belongs
 * to this booking, is paid and has the booking total. Inventory is never released here.
 */
const reconcilePaymentReceipt = async receiptId => {
    const ref = receiptRef(receiptId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return { receiptId, status: 'missing' };
    const receipt = snapshot.data();
    if (receipt.status !== 'pending') return { receiptId, status: receipt.status };
    const review = (reason, detail) => settleReceipt(ref, { status: 'needs_review', reason, detail })
        .then(result => ({ receiptId, ...result }));
    const retry = (reason, detail) => settleReceipt(ref, { status: 'pending', reason, detail })
        .then(result => ({ receiptId, ...result }));

    const bookingSnap = await db.collection('publicBookings').doc(receipt.bookingId).get();
    if (!bookingSnap.exists) return review('booking_not_found');
    const booking = bookingSnap.data();
    if (booking.paymentStatus === 'archived_test') return settleReceipt(ref, { status: 'ignored', reason: 'archived_test' }).then(result => ({ receiptId, ...result }));
    if (!receipt.providerInvoiceId) return review('missing_invoice_id');
    if (booking.paymentMode === 'manual') return review('manual_payment_booking');
    if (booking.invoiceId && booking.invoiceId !== receipt.providerInvoiceId) return review('invoice_mismatch');
    if (isPaid(booking) && !booking.invoiceId) return review('paid_without_saved_invoice');
    if (booking.paymentStatus === 'expired') return review('booking_canceled_before_payment');
    if (booking.paymentStatus === 'failed' && booking.checkoutFailure?.cleanupStatus === 'complete') {
        return review('booking_released_before_payment');
    }

    let verifiedInvoice = null;
    if (!isPaid(booking) && (!booking.invoiceId || booking.paymentStatus === 'failed')) {
        let invoice;
        try {
            invoice = await PaperRepository.getInvoice(receipt.providerInvoiceId);
        } catch (error) {
            return retry('provider_verification_unavailable', error.message);
        }
        if (String(invoice?.number ?? '') !== receipt.bookingId) return review('provider_invoice_not_for_booking');
        if (Number(invoice.total) !== Number(booking.totalAmount)) return review('provider_total_mismatch');
        if (invoice.paymentStatus !== 'paid') return retry('provider_not_paid', `Provider status: ${invoice.paymentStatus || 'unknown'}`);
        verifiedInvoice = { invoiceId: receipt.providerInvoiceId, total: Number(invoice.total), paymentStatus: 'paid', verifiedAt: Date.now() };
    }

    try {
        const result = await handlePublicTicketWebhookPaid(receipt.bookingId, receipt.payload, { receiptRef: ref, verifiedInvoice });
        return { receiptId, status: 'processed', booking: result, newlyPaid: !result.alreadyPaid };
    } catch (error) {
        if (error.code === 'ARCHIVED_TEST') return settleReceipt(ref, { status: 'ignored', reason: 'archived_test' }).then(result => ({ receiptId, ...result }));
        if (TERMINAL_CODES.has(error.code)) return review(error.code.toLowerCase(), error.message);
        logger.error(`Payment receipt ${receiptId} will be retried: ${error.message}`);
        return retry(error.code === 'AWAITING_INVOICE_IDENTITY' ? 'awaiting_invoice_identity' : 'fulfillment_failed', error.message);
    }
};

const listDueReceiptIds = async (limit = 100) => {
    const snapshot = await db.collection(RECEIPT_COLLECTION).where('status', '==', 'pending').limit(limit).get();
    const now = Date.now();
    return snapshot.docs
        .filter(doc => Number(doc.data().nextAttemptAt || 0) <= now)
        .sort((left, right) => Number(left.data().nextAttemptAt || 0) - Number(right.data().nextAttemptAt || 0))
        .map(doc => doc.id);
};

const listPendingReceiptIdsForBooking = async bookingId => {
    const snapshot = await db.collection(RECEIPT_COLLECTION).where('bookingId', '==', bookingId).get();
    return snapshot.docs.filter(doc => doc.data().status === 'pending').map(doc => doc.id);
};

module.exports = {
    RECEIPT_COLLECTION,
    MAX_ATTEMPTS,
    receiptIdFor,
    recordPaymentReceipt,
    reconcilePaymentReceipt,
    listDueReceiptIds,
    listPendingReceiptIdsForBooking,
};
