const { db } = require('../configs/firebase-init');
const fail = message => Object.assign(new Error(message), { statusCode: 409, isOperational: true });
const validKey = value => typeof value === 'string' && value.length > 0 && value.length < 200 && !value.includes('/');

// Metadata edits must not overwrite sessions, seat layouts, or concurrent venue changes.
async function updateMetadata(eventId, venueId, values) {
    if (!validKey(eventId) || !validKey(venueId) || !values
        || typeof values.label !== 'string' || !values.label.trim() || values.label.length > 200
        || typeof values.imageUrl !== 'string' || values.imageUrl.length > 4096) {
        throw fail('Enter a valid venue name and image URL.');
    }
    try {
        if (new URL(values.imageUrl).protocol !== 'https:') throw new Error();
    } catch (_) {
        throw fail('Venue image must use an HTTPS URL.');
    }
    return db.runTransaction(async transaction => {
        const ref = db.collection('events').doc(eventId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw fail('Event not found.');
        const event = snapshot.data();
        const venue = (event.venues || []).find(item => item.id === venueId);
        if (!venue) throw fail('Venue no longer exists. Refresh Venue Settings.');
        if (!values.expected || venue.label !== values.expected.label
            || (venue.imageUrl || '') !== values.expected.imageUrl) {
            throw fail('Venue changed. Refresh Venue Settings before saving.');
        }
        const venues = event.venues.map(item => item.id === venueId
            ? { ...item, label: values.label.trim(), imageUrl: values.imageUrl } : item);
        transaction.update(ref, { venues });
        return { venues };
    });
}
module.exports = { updateMetadata };
