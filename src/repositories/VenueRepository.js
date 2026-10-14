const { db } = require('../configs/firebase-init');
const fail = message => Object.assign(new Error(message), { statusCode: 409, isOperational: true });
const validKey = value => typeof value === 'string' && value.length > 0 && value.length < 200 && !value.includes('/');

// Metadata edits must not overwrite sessions, seat layouts, or concurrent venue changes.
async function saveVenue(eventId, venueId, values, includeLayout = false) {
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
    if (includeLayout && (!Array.isArray(values.seatConfig) || !values.seatConfig.length
        || values.seatConfig.length > 100 || values.seatConfig.some(config =>
            !config || typeof config.row !== 'string' || !/^[A-Za-z]+$/.test(config.row)
            || config.row.length > 10 || !Number.isInteger(config.seatCount)
            || config.seatCount < 1 || config.seatCount > 100
            || !['Lento', 'Allegro', 'Presto'].includes(config.areaType))
        || new Set(values.seatConfig.map(config => config.row.toUpperCase())).size !== values.seatConfig.length)) {
        throw fail('Enter unique row letters, capacities from 1 to 100, and valid ticket tiers.');
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
        const layoutChanged = includeLayout && JSON.stringify(values.seatConfig) !== JSON.stringify(venue.seatConfig || []);
        if (includeLayout && JSON.stringify(values.expected.seatConfig) !== JSON.stringify(venue.seatConfig || [])) {
            throw fail('Venue layout changed. Refresh Venue Settings before saving.');
        }
        if (layoutChanged) {
            const seats = await transaction.get(db.collection(`seats${eventId}`).where('venueId', '==', venueId).limit(1));
            if (!seats.empty) throw fail('Seat layout cannot be changed because numbered seats already exist for this venue.');
        }
        const venues = event.venues.map(item => item.id === venueId
            ? { ...item, label: values.label.trim(), imageUrl: values.imageUrl,
                ...(includeLayout ? { seatConfig: values.seatConfig.map(({ row, seatCount, areaType }) => ({ row, seatCount, areaType })) } : {}) } : item);
        transaction.update(ref, { venues });
        return { venues };
    });
}
const updateMetadata = (eventId, venueId, values) => saveVenue(eventId, venueId, values);
const updateLayout = (eventId, venueId, values) => saveVenue(eventId, venueId, values, true);
module.exports = { updateMetadata, updateLayout };
