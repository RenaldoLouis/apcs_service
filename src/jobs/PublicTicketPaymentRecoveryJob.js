const { logger } = require('../utils/Logger');
const { processDueReceipts } = require('../services/PublicTicketPaymentService');

const RECOVERY_INTERVAL_MS = 2 * 60 * 1000;
const STARTUP_DELAY_MS = 15 * 1000;

// Replays durable paid-callback receipts after a failed attempt, an early callback or a restart.
// It applies verified payments only; it never cancels invoices or releases inventory.
const startPublicTicketPaymentRecovery = () => {
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            const result = await processDueReceipts();
            if (result.attempted) {
                logger.info(`[PAYMENT_RECOVERY] Attempted ${result.attempted} receipts: ${result.processed} processed, ${result.needsReview} need review.`);
            }
        } catch (error) {
            logger.error(`[PAYMENT_RECOVERY] Receipt recovery failed: ${error.message}`);
        } finally {
            running = false;
        }
    };
    setTimeout(run, STARTUP_DELAY_MS);
    setInterval(run, RECOVERY_INTERVAL_MS);
    logger.info(`[PAYMENT_RECOVERY] Paid callback recovery started (runs every ${RECOVERY_INTERVAL_MS / 1000}s)`);
};

module.exports = { startPublicTicketPaymentRecovery };
