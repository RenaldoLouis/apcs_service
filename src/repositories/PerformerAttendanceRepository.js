const { createHash } = require('node:crypto');
const { db, admin } = require('../configs/firebase-init');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');
const { isPaid, validateKey } = require('../services/TicketRedemptionModel');
const { performerNames } = require('../services/RegistrantAttendanceImport');

const documentId = () => admin.firestore.FieldPath.documentId();
const attendanceFor = eventId => db.collection('ticketRedemptions')
    .doc(encodeURIComponent(JSON.stringify([eventId, 'performerAttendance']))).collection('performerAttendance');
const normalize = text => text.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

function roster(registration) {
    const occurrences = new Map();
    return performerNames(registration.data()).filter(Boolean).map(name => {
        const normalized = normalize(name);
        const occurrence = (occurrences.get(normalized) || 0) + 1;
        occurrences.set(normalized, occurrence);
        const id = createHash('sha256').update(JSON.stringify([registration.id, normalized, occurrence])).digest('hex');
        return { id, registrantId: registration.id, name, occurrence };
    });
}

function validateSearch(eventId, search, cursor) {
    if (!validateKey(eventId) || typeof search !== 'string' || search.length > 200 || (cursor && !validateKey(cursor))) {
        throw new AppError('Invalid event, performer search or cursor.', 400);
    }
}

const matches = (person, search) => {
    const text = normalize(`${person.name} ${person.registrantId}`);
    return search.every(term => text.includes(term));
};
const attendanceRow = doc => {
    const { name, registrantId, markedAt, actorEmail } = doc.data();
    return { id: doc.id, name, registrantId, markedAt: markedAt?.toMillis?.() ?? markedAt?.toDate?.().getTime() ?? null, actorEmail };
};

async function list({ eventId, search = '' }) {
    validateSearch(eventId, search);
    const terms = normalize(search).split(' ');
    const rows = [];
    const pageSize = 100;
    const query = attendanceFor(eventId).orderBy(documentId()).limit(pageSize);
    let cursor;
    while (true) {
        const { docs } = await (cursor ? query.startAfter(cursor) : query).get();
        rows.push(...docs.map(attendanceRow).filter(person => matches(person, terms)));
        if (docs.length < pageSize) break;
        cursor = docs[docs.length - 1];
    }
    return { attendance: rows.sort((a, b) => b.markedAt - a.markedAt) };
}

async function candidates({ eventId, search = '', cursor }) {
    validateSearch(eventId, search, cursor);
    const pageSize = 25;
    const query = db.collection('Registrants2025').where('eventId', '==', eventId)
        .orderBy(documentId()).limit(pageSize);
    const { docs } = await (cursor ? query.startAfter(cursor) : query).get();
    if (!docs.length) return { performers: [], nextCursor: null };

    const nextCursor = docs.length === pageSize ? docs[docs.length - 1].id : null;
    const terms = normalize(search).split(' ');
    const matchesInPage = docs.flatMap(roster).filter(person => matches(person, terms));
    if (!matchesInPage.length) return { performers: [], nextCursor };

    const registrantIds = [...new Set(matchesInPage.map(person => person.registrantId))];
    const bookings = await db.collection('publicBookings').where('eventId', '==', eventId)
        .where('registrantId', 'in', registrantIds).select('registrantId', 'paymentStatus').get();
    const paid = new Set(bookings.docs.map(doc => doc.data()).filter(isPaid).map(booking => booking.registrantId));
    const people = matchesInPage.filter(person => !paid.has(person.registrantId));
    const attendance = attendanceFor(eventId);
    const marked = people.length ? await db.getAll(...people.map(person => attendance.doc(person.id))) : [];
    return {
        performers: people.filter((_, index) => !marked[index].exists),
        nextCursor,
    };
}

async function markPresent({ eventId, registrantId, performerId }, actor) {
    if (!validateKey(eventId) || !validateKey(registrantId) || typeof performerId !== 'string' || !/^[a-f0-9]{64}$/.test(performerId)) {
        throw new AppError('Select a performer from this event.', 400);
    }
    if (!actor?.uid || !actor?.email) throw new AppError('Ticketing administrator is required.', 403);

    const entry = attendanceFor(eventId).doc(performerId);
    await db.runTransaction(async transaction => {
        const existing = await transaction.get(entry);
        if (existing.exists) return;
        const [event, registration, bookings] = await Promise.all([
            transaction.get(db.collection('events').doc(eventId)),
            transaction.get(db.collection('Registrants2025').doc(registrantId)),
            transaction.get(db.collection('publicBookings').where('eventId', '==', eventId).where('registrantId', '==', registrantId)),
        ]);
        const person = event.exists && registration.exists && registration.data().eventId === eventId
            ? roster(registration).find(item => item.id === performerId) : null;
        if (!person) throw new AppError('This performer is no longer available. Refresh the performer list.', 404);
        if (bookings.docs.some(doc => isPaid(doc.data()))) {
            throw new AppError('This performance now has a paid booking. Refresh the performer list.', 409);
        }
        transaction.set(entry, { eventId, registrantId, name: person.name, actorUid: actor.uid, actorEmail: actor.email,
            markedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    return { attendance: attendanceRow(await entry.get()) };
}

module.exports = { list, candidates, markPresent };
