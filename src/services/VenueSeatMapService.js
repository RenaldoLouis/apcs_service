const axios = require('axios');
const { db } = require('../configs/firebase-init');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');

const SEAT_MAP_HOST = 'firebasestorage.googleapis.com';
const MAX_SEAT_MAP_BYTES = 2 * 1024 * 1024;
const SEAT_MAP_TIMEOUT_MS = 15000;
const DOWNLOAD_FAILED_MESSAGE = 'The venue seat map could not be downloaded. Try again, or upload it again in Venue Settings.';
const NOT_SVG_MESSAGE = 'The venue image is not an SVG seat map. Upload an SVG in Venue Settings.';

const validKey = value => typeof value === 'string' && value.length > 0 && value.length < 200 && !value.includes('/');

// Only the venue's own Firebase Storage download URL is fetched; the client never supplies a URL.
const isFirebaseStorageUrl = value => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === SEAT_MAP_HOST && url.pathname.startsWith('/v0/b/');
    } catch (_) {
        return false;
    }
};

const downloadSeatMap = async url => {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: SEAT_MAP_TIMEOUT_MS,
        maxContentLength: MAX_SEAT_MAP_BYTES,
        maxRedirects: 0,
    });
    return { contentType: String(response.headers?.['content-type'] || ''), body: response.data };
};

/**
 * Returns the SVG text of a venue's uploaded seat map.
 *
 * Firebase Storage sends no CORS headers, so the admin page cannot read the SVG
 * it displays through <img>. This proxy lets Seat Occupancy recolor it per session.
 *
 * @param {{ eventId: string, venueId: string }} params
 * @param {{ fetchFile?: (url: string) => Promise<{ contentType: string, body: Buffer|ArrayBuffer }> }} [deps]
 * @returns {Promise<{ venueId: string, venueLabel: string, svg: string }>}
 * @throws {AppError} 400 invalid ids, 404 unknown event/venue, 409 missing or non-SVG image, 502 download failure
 */
async function getVenueSeatMap({ eventId, venueId }, { fetchFile = downloadSeatMap } = {}) {
    if (!validKey(eventId) || !validKey(venueId)) throw new AppError('Choose a valid event and venue.', 400);
    const snapshot = await db.collection('events').doc(eventId).get();
    if (!snapshot.exists) throw new AppError('Event not found.', 404);
    const venue = (snapshot.data().venues || []).find(item => item.id === venueId);
    if (!venue) throw new AppError('Venue not found. Refresh Seat Occupancy.', 404);
    if (!isFirebaseStorageUrl(venue.imageUrl)) {
        throw new AppError('This venue has no uploaded seat map. Upload an SVG in Venue Settings.', 409);
    }

    let file;
    try {
        file = await fetchFile(venue.imageUrl);
    } catch (_) {
        throw new AppError(DOWNLOAD_FAILED_MESSAGE, 502);
    }
    const svg = Buffer.from(file.body || '').toString('utf8');
    if (!/^image\/svg\+xml\b/i.test(file.contentType) || !/<svg[\s>]/i.test(svg)) {
        throw new AppError(NOT_SVG_MESSAGE, 409);
    }
    return { venueId, venueLabel: venue.label || venueId, svg };
}

module.exports = { getVenueSeatMap, isFirebaseStorageUrl };
