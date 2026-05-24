/**
 * Discount Utilities
 * 
 * Pure functions for calculating promotional discounts.
 * Extracted from PaperController.js to enable unit testing
 * of the critical Vocal Choir ensemble discount tiers.
 */

/**
 * Returns the applicable discount percentage for a Vocal Choir ensemble
 * based on the number of performers.
 *
 * Discount tiers:
 *   -  5–10 performers → 5%  (0.05)
 *   - 11–20 performers → 15% (0.15)
 *   - 21–30 performers → 20% (0.20)
 *
 * @param {string} competitionCategory - e.g. "VocalChoir", "Piano"
 * @param {string} performanceCategory - "Solo" or "Ensemble"
 * @param {number} totalPerformer - Number of performers
 * @returns {number} - Discount as a decimal (0, 0.05, 0.15, or 0.20)
 */
function getVocalChoirDiscount(competitionCategory, performanceCategory, totalPerformer) {
    if (competitionCategory !== 'VocalChoir' || performanceCategory !== 'Ensemble') {
        return 0;
    }

    const performers = totalPerformer || 0;

    if (performers >= 21 && performers <= 30) {
        return 0.20;
    } else if (performers >= 11 && performers <= 20) {
        return 0.15;
    } else if (performers >= 5 && performers <= 10) {
        return 0.05;
    }

    return 0;
}

/**
 * Applies the Vocal Choir discount to a given amount.
 *
 * @param {number} amount - The total amount before discount
 * @param {number} discountPercent - Discount as a decimal (e.g. 0.15)
 * @returns {{ finalAmount: number, discountAmount: number }}
 */
function applyDiscount(amount, discountPercent) {
    if (discountPercent <= 0) {
        return { finalAmount: amount, discountAmount: 0 };
    }
    const discountAmount = amount * discountPercent;
    const finalAmount = amount * (1 - discountPercent);
    return { finalAmount, discountAmount };
}

module.exports = {
    getVocalChoirDiscount,
    applyDiscount,
};
