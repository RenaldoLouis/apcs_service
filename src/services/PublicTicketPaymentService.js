const { db } = require('../configs/firebase-init');
const PaymentReceiptRepository = require('../repositories/PublicTicketPaymentReceiptRepository');
const emailService = require('./EmailService');
const { logger } = require('../utils/Logger');

// The confirmation is sent once, by whichever caller performed the paid transition.
const sendConfirmation = async booking => {
    const bookingRef = db.collection('publicBookings').doc(booking.id);
    try {
        await emailService.sendPublicBookingConfirmationEmail(booking);
        await bookingRef.update({ emailSent: true });
    } catch (emailError) {
        logger.error(`Confirmation email failed for booking ${booking.id}: ${emailError.message}`);
        try {
            await bookingRef.update({ emailSent: false });
        } catch (updateError) {
            logger.error(`Could not record email failure for booking ${booking.id}: ${updateError.message}`);
        }
    }
};

const reconcileReceipt = async receiptId => {
    let outcome;
    try {
        outcome = await PaymentReceiptRepository.reconcilePaymentReceipt(receiptId);
    } catch (error) {
        // The receipt is already durable; the recovery job retries it.
        logger.error(`Payment receipt ${receiptId} reconciliation deferred: ${error.message}`);
        return { receiptId, status: 'pending' };
    }
    if (outcome.newlyPaid) await sendConfirmation(outcome.booking);
    return outcome;
};

// Shared by both Paper.id callback routes. HTTP 200 is returned only after a durable receipt exists.
const handlePublicBookingPaidCallback = async (bookingId, booking, payloadData) => {
    if (booking.paymentStatus === 'archived_test') {
        logger.info(`Ignoring Paper callback for archived test booking ${bookingId}.`);
        return { statusCode: 200, body: { status: 'IGNORED_TEST_RESET' } };
    }
    let receipt;
    try {
        receipt = await PaymentReceiptRepository.recordPaymentReceipt(bookingId, payloadData);
    } catch (error) {
        logger.error(`Paid callback for booking ${bookingId} could not be stored: ${error.message}`);
        return { statusCode: 500, body: { status: 'RECEIPT_NOT_STORED' } };
    }
    const outcome = await reconcileReceipt(receipt.receiptId);
    return {
        statusCode: 200,
        body: {
            status: outcome.status === 'processed' ? 'OK' : 'RECEIVED_FOR_RECONCILIATION',
            receiptId: receipt.receiptId,
        },
    };
};

// Replays receipts that arrived before checkout saved the provider invoice identity.
const reconcileBookingReceipts = async bookingId => {
    const receiptIds = await PaymentReceiptRepository.listPendingReceiptIdsForBooking(bookingId);
    const outcomes = [];
    for (const receiptId of receiptIds) outcomes.push(await reconcileReceipt(receiptId));
    return outcomes;
};

const processDueReceipts = async () => {
    const receiptIds = await PaymentReceiptRepository.listDueReceiptIds();
    const outcomes = [];
    for (const receiptId of receiptIds) outcomes.push(await reconcileReceipt(receiptId));
    return {
        attempted: outcomes.length,
        processed: outcomes.filter(outcome => outcome.status === 'processed').length,
        needsReview: outcomes.filter(outcome => outcome.status === 'needs_review').length,
    };
};

module.exports = {
    handlePublicBookingPaidCallback,
    reconcileBookingReceipts,
    processDueReceipts,
};
