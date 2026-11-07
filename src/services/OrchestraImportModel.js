const crypto = require('node:crypto');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');

const validKey = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('/');
const text = (value, max, label) => {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
        throw new AppError(`A valid ${label} is required.`, 400);
    }
    return value.trim();
};

function normalizeImport(input) {
    if (!validKey(input?.eventId) || !Array.isArray(input.rows) || !input.rows.length || input.rows.length > 100) {
        throw new AppError('Choose an event and import between 1 and 100 rows.', 400);
    }
    const seen = new Set();
    return input.rows.map((row, index) => {
        try {
            const buyerName = text(row.buyerName, 200, 'name');
            const userEmail = text(row.userEmail, 254, 'email').toLowerCase();
            if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(userEmail)) throw new AppError('Invalid email.', 400);
            const userPhone = text(row.userPhone, 40, 'WhatsApp number');
            if (!/^\+?[\d\s().-]+$/.test(userPhone) || userPhone.replace(/\D/g, '').length < 8) throw new AppError('Invalid WhatsApp number.', 400);
            if (!validKey(row.sessionId)) throw new AppError('Choose an orchestra session.', 400);
            if (!row.expectedSession || !['venue', 'date', 'time'].every(key =>
                typeof row.expectedSession[key] === 'string' && row.expectedSession[key].length > 0 && row.expectedSession[key].length <= 200)) {
                throw new AppError('The orchestra session snapshot is required.', 400);
            }
            const category = String(row.category || '').trim().toLowerCase();
            if (!['presto', 'allegro'].includes(category)) throw new AppError('Category must be Presto or Allegro.', 400);
            if (!Number.isSafeInteger(row.quantity) || row.quantity < 1 || row.quantity > 1000) throw new AppError('Ticket quantity must be a whole number from 1 to 1000.', 400);
            if (!Number.isSafeInteger(row.totalPaid) || row.totalPaid < 0) throw new AppError('Total Paid must be a nonnegative whole IDR amount.', 400);
            if (typeof row.notes !== 'string' || row.notes.length > 2000) throw new AppError('Notes must be at most 2000 characters.', 400);
            // Price/notes are excluded from identity: correcting them must never create more tickets.
            const identity = JSON.stringify([input.eventId, row.sessionId, buyerName.toLowerCase().replace(/\s+/g, ' '),
                userEmail, userPhone.replace(/\D/g, '').replace(/^62/, '0'), category, row.quantity]);
            const bookingId = `IMP-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;
            if (seen.has(bookingId)) throw new AppError('Duplicate buyer/session/category/quantity in this file.', 400);
            seen.add(bookingId);
            return { bookingId, buyerName, userEmail, userPhone, sessionId: row.sessionId, category,
                quantity: row.quantity, totalPaid: row.totalPaid, notes: row.notes.trim(), expectedSession: row.expectedSession };
        } catch (error) {
            throw new AppError(`Row ${index + 2}: ${error.message}`, 400);
        }
    });
}

module.exports = { normalizeImport };
