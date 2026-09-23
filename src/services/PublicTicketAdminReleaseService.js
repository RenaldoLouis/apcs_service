const PaperRepository = require('../repositories/PaperRepository');
const PublicTicketFailureRepository = require('../repositories/PublicTicketFailureRepository');
const { logger } = require('../utils/Logger');

const ADMIN_RELEASE_REASONS = new Set([
    'customer_declined',
    'no_response_after_one_hour',
    'manual_payment_unpaid',
]);
const ADMIN_NO_RESPONSE_WAIT_MS = 60 * 60 * 1000;

const adminReleaseError = (message, statusCode = 400, code = 'ADMIN_RELEASE_FAILED') => Object.assign(new Error(message), {
    statusCode,
    isOperational: true,
    code,
});

const releasePublicTicketBooking = async (bookingId, options = {}, actor = {}) => {
    const reason = String(options.reason || '').trim();
    const note = String(options.note || '').trim().slice(0, 500);
    if (!ADMIN_RELEASE_REASONS.has(reason)) {
        throw adminReleaseError(
            'Select a valid reason before releasing this booking.',
            400,
            'INVALID_RELEASE_REASON',
        );
    }

    const booking = await PublicTicketFailureRepository.getPublicTicketBooking(bookingId);
    if (!booking) throw adminReleaseError('Booking not found.', 404, 'BOOKING_NOT_FOUND');

    const paymentStatus = String(booking.paymentStatus || '').toLowerCase();
    if (paymentStatus === 'paid') {
        throw adminReleaseError(
            'A paid booking can never be canceled from Seat Occupancy.',
            409,
            'PAID_BOOKING',
        );
    }
    if (!['pending', 'failed'].includes(paymentStatus)) {
        throw adminReleaseError(
            'This booking is no longer eligible for inventory release.',
            409,
            'BOOKING_NOT_ELIGIBLE',
        );
    }
    if (paymentStatus === 'failed' && booking.checkoutFailure?.cleanupStatus === 'complete') {
        throw adminReleaseError(
            'This failed booking has already been reconciled.',
            409,
            'BOOKING_ALREADY_RECONCILED',
        );
    }
    const isManualBooking = booking.paymentMode === 'manual';
    if (reason === 'manual_payment_unpaid' && !isManualBooking) {
        throw adminReleaseError('This reason is only for manual-payment bookings.', 400, 'INVALID_RELEASE_REASON');
    }
    if (isManualBooking && reason !== 'manual_payment_unpaid') {
        throw adminReleaseError('Select the manual-payment cancellation reason.', 400, 'INVALID_RELEASE_REASON');
    }
    if (isManualBooking && options.paymentNotReceivedConfirmed !== true) {
        throw adminReleaseError('Confirm that staff checked payment and no payment was received.', 409, 'MANUAL_PAYMENT_NOT_VERIFIED');
    }

    if (reason === 'no_response_after_one_hour') {
        const createdAt = booking.createdAt?.toDate ? booking.createdAt.toDate() : new Date(booking.createdAt);
        if (!createdAt || Number.isNaN(createdAt.getTime())
            || Date.now() - createdAt.getTime() < ADMIN_NO_RESPONSE_WAIT_MS) {
            throw adminReleaseError(
                'Wait one hour from booking creation before using the no-response reason.',
                409,
                'NO_RESPONSE_TOO_SOON',
            );
        }
    }

    const lifecycleField = paymentStatus === 'failed' ? 'checkoutFailure' : 'expiry';
    let invoiceCancellationStatus;
    if (isManualBooking) {
        if (booking.invoiceId || booking.paymentUrl) {
            throw adminReleaseError('Manual booking has an invoice reference. Reconcile before release.', 409, 'BOOKING_INVOICE_CHANGED');
        }
        invoiceCancellationStatus = 'manual_payment_not_received';
    } else if (booking.invoiceId) {
        if (booking[lifecycleField]?.invoiceCancellationStatus !== 'canceled') {
            await PublicTicketFailureRepository.recordCancellationResult(bookingId, lifecycleField, 'pending');
            let canceled = false;
            try {
                canceled = Boolean(await PaperRepository.deleteInvoice(booking.invoiceId));
            } catch (error) {
                logger.error(`Admin invoice cancellation failed for booking ${bookingId}: ${error.message}`);
            }
            if (!canceled) {
                await PublicTicketFailureRepository.recordCancellationResult(bookingId, lifecycleField, 'failed');
                throw adminReleaseError(
                    'Paper.id could not confirm invoice cancellation. The seats remain locked.',
                    409,
                    'PAPER_CANCELLATION_FAILED',
                );
            }
            await PublicTicketFailureRepository.recordCancellationResult(bookingId, lifecycleField, 'canceled');
        }
        invoiceCancellationStatus = 'canceled';
    } else {
        if (paymentStatus === 'pending') {
            throw adminReleaseError(
                'This checkout is still pending invoice creation. Reconcile it as failed before releasing inventory.',
                409,
                'PENDING_INVOICE_CREATION',
            );
        }
        if (options.manualProviderConfirmation !== true) {
            throw adminReleaseError(
                'Please confirm that you checked Paper.id and found no paid or active invoice.',
                409,
                'MANUAL_CONFIRMATION_REQUIRED',
            );
        }
        invoiceCancellationStatus = 'manually_verified_no_active_invoice';
    }

    const terminalStatus = paymentStatus === 'failed' ? 'failed' : 'expired';
    const released = await PublicTicketFailureRepository.releaseAdminBookingInventory(bookingId, {
        terminalStatus,
        lifecycleField,
        invoiceCancellationStatus,
        reason,
        note,
        actor,
        expectedPaymentStatus: paymentStatus,
        expectedInvoiceId: booking.invoiceId || null,
        expectedPaymentMode: isManualBooking ? 'manual' : null,
        expectedInvoiceCancellationStatus: booking.invoiceId ? 'canceled' : null,
    });
    if (!released) {
        throw adminReleaseError(
            'The booking changed while it was being reconciled. Refresh before trying again.',
            409,
            'BOOKING_STATE_CHANGED',
        );
    }

    logger.info(`Admin ${actor.email || actor.uid || 'unknown'} released public booking ${bookingId} (${reason}).`);
    return {
        bookingId,
        released: true,
        paymentStatus: terminalStatus,
        invoiceCancellationStatus,
        reconciliationReasons: released.reconciliationReasons,
    };
};

module.exports = { releasePublicTicketBooking };
