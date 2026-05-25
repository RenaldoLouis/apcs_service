/**
 * Invoice Utilities
 * 
 * Pure functions for building Paper.id invoice payloads.
 * Extracted from PaperRepository.js to enable unit testing of
 * the critical USD → IDR conversion logic.
 */

const USD_TO_IDR_RATE = 17800;

/**
 * Converts a single invoice item from the frontend format into the
 * Paper.id-ready format. Handles:
 *  - USD → IDR conversion at a fixed rate
 *  - Appending "(Original: $X USD)" to the description
 *  - Converting discount amounts from USD to IDR
 *
 * @param {Object} item - The invoice item from the frontend
 * @param {number} item.price - The price (in the item's currency)
 * @param {string} [item.description] - Item description
 * @param {string} [item.currency] - 'USD' or 'IDR'
 * @param {number} [item.discount] - Discount amount (in the item's currency)
 * @param {string} item.name - Item name
 * @returns {Object} - Transformed item ready for Paper.id payload
 */
function buildInvoiceItem(item) {
    let finalPrice = parseFloat(item.price);
    let finalDescription = item.description || "APCS Registration";

    if (item.currency === 'USD') {
        finalPrice = Math.round(finalPrice * USD_TO_IDR_RATE);
        finalDescription = `${finalDescription} (Original: $${item.price} USD)`;
    }

    let finalDiscount = parseFloat(item.discount || 0);
    if (item.currency === 'USD' && finalDiscount > 0) {
        finalDiscount = Math.round(finalDiscount * USD_TO_IDR_RATE);
    }

    return {
        name: item.name,
        description: finalDescription,
        price: finalPrice,
        discount: finalDiscount,
    };
}

/**
 * Generates the invoice notes string.
 *
 * @param {string} dueDate - Formatted due date string (DD-MM-YYYY)
 * @param {boolean} isInternational - Whether any item is in USD
 * @returns {string} - The notes string for the Paper.id invoice
 */
function buildInvoiceNotes(dueDate, isInternational) {
    return `Please complete payment before ${dueDate}.${isInternational ? `\nNote: International payment uses a fixed rate of Rp ${USD_TO_IDR_RATE.toLocaleString('id-ID')} per USD.` : ''}`;
}

module.exports = {
    USD_TO_IDR_RATE,
    buildInvoiceItem,
    buildInvoiceNotes,
};
