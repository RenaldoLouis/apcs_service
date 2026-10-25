const { db } = require('../configs/firebase-init');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');

const contactFields = ['buyerName', 'userName', 'userEmail', 'userPhone'];
const isReference = value => typeof value === 'string' && value.length > 0
    && value.length < 200 && value === value.trim() && !value.includes('/');
const hasExactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// One plain mailbox; never address lists, display names or mail headers.
const isEmail = value => {
    if (value.length > 254) return false;
    const parts = value.split('@');
    if (parts.length !== 2) return false;
    const [local, domain] = parts;
    return local.length > 0 && local.length <= 64 && !local.startsWith('.') && !local.endsWith('.')
        && !local.includes('..') && /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.\-]+$/.test(local)
        && domain.split('.').length >= 2 && domain.split('.').every(label => label.length <= 63
            && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label));
};

// A normal Promise-returning repository function, awaited/caught by the controller.
async function updatePendingBuyerContact(input, actor) {
    if (!actor?.uid || !actor?.email) throw new AppError('Ticketing administrator authentication is required.', 403);
    if (!hasExactKeys(input, ['bookingId', 'eventId', 'contact', 'expectedContact'])
        || !isReference(input.bookingId) || !isReference(input.eventId)
        || !hasExactKeys(input.contact, ['buyerName', 'userEmail', 'userPhone'])
        || !hasExactKeys(input.expectedContact, contactFields)
        || !contactFields.every(field => input.expectedContact[field] === null || typeof input.expectedContact[field] === 'string')) {
        throw new AppError('Invalid buyer contact request. Refresh the list and reopen the editor.', 400);
    }
    if (!Object.values(input.contact).every(value => typeof value === 'string')) {
        throw new AppError('Buyer name, email and phone must be text.', 400);
    }
    const buyerName = input.contact.buyerName.trim();
    const userEmail = input.contact.userEmail.trim();
    const userPhone = input.contact.userPhone.trim();
    if (!buyerName || buyerName.length > 200 || /[\x00-\x1f\x7f]/.test(buyerName)) {
        throw new AppError('Enter a buyer name of 1 to 200 characters without control characters.', 400);
    }
    if (!isEmail(userEmail)) throw new AppError('Enter one valid email address.', 400);
    const phoneDigits = userPhone.replace(/\D/g, '');
    if (userPhone.length > 40 || !/^\+?[0-9 ()\-]+$/.test(userPhone)
        || phoneDigits.length < 6 || phoneDigits.length > 20) {
        throw new AppError('Enter a phone number with 6 to 20 digits; spaces, parentheses, hyphens and a leading + are allowed.', 400);
    }

    // Both name fields are existing aliases read by ticketing screens and email senders.
    const contact = { buyerName, userName: buyerName, userEmail, userPhone };
    const bookingRef = db.collection('publicBookings').doc(input.bookingId);
    return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(bookingRef);
        if (!snapshot.exists) throw new AppError('Booking no longer exists. Refresh the list.', 404);
        const booking = snapshot.data();
        if (booking.eventId !== input.eventId || booking.recordType === 'documentation_only') {
            throw new AppError('This booking does not belong to the selected event or is not a ticket booking.', 409);
        }
        // This read participates in the same transaction as payment/expiry updates.
        if (booking.paymentStatus !== 'pending') {
            throw new AppError('Only pending bookings can be edited. Refresh the list to see its current status.', 409);
        }
        const alreadySaved = contactFields.every(field => (booking[field] ?? null) === contact[field]);
        if (!alreadySaved && !contactFields.every(field => (booking[field] ?? null) === input.expectedContact[field])) {
            throw new AppError('Buyer contact details changed since you opened the editor. Refresh the list and reopen it.', 409);
        }
        // Never spread client data or replace the booking: no inventory, payment or retry-key writes.
        if (!alreadySaved) transaction.update(bookingRef, contact);
        return { bookingId: input.bookingId, eventId: input.eventId, updated: true, contact };
    });
}

module.exports = { updatePendingBuyerContact };
