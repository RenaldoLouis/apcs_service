const { db, admin } = require('../configs/firebase-init');
const { physicalSeatKey, safeDocumentId, SEAT_OWNERSHIP_COLLECTION } = require('./PublicTicketRepository');

// Staff seat writes run in Admin SDK transactions so they serialize with checkout, payment and each other.
const GENERATION_CHUNK_SIZE = 150;
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode, isOperational: true });
const validKey = value => typeof value === 'string' && value.length > 0 && value.length < 300 && !value.includes('/');
const isPaid = booking => booking.paymentStatus === 'PAID' || booking.paymentStatus === 'paid';
const isMasterclassTicket = ticket => ['master_class', 'masterclass'].includes(String(ticket.id || '').toLowerCase());
const occupiedStatus = status => ['locked', 'booked', 'reserved'].includes(String(status || '').toLowerCase());
const ownershipRef = key => db.collection(SEAT_OWNERSHIP_COLLECTION).doc(safeDocumentId(key));

const seatTemplatesFor = venue => (venue?.seatConfig || []).flatMap(config =>
    Array.from({ length: Number(config.seatCount || 0) }, (_, index) => ({
        seatLabel: `${config.row}${index + 1}`,
        areaType: config.areaType,
        row: config.row,
        number: index + 1,
    })));

/**
 * Creates missing numbered seats and refreshes available ones for the given venue sessions.
 * Each chunk re-reads its seat documents (current and legacy ID formats) and canonical chair
 * ownership inside the transaction, so a concurrent lock, payment or staff assignment is preserved.
 */
async function generateSeatLayout({ eventId, venueId, sessionIds }) {
    if (!validKey(eventId) || !validKey(venueId)) throw fail('Event and venue are required.', 400);
    if (!Array.isArray(sessionIds) || !sessionIds.length || sessionIds.length > 100
        || sessionIds.some(id => typeof id !== 'string' || !/^\d{4}-\d{2}-\d{2}_.+$/.test(id) || id.includes('/'))) {
        throw fail('No sessions provided to generate seats for.', 400);
    }
    const eventRef = db.collection('events').doc(eventId);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) throw fail('Event not found.', 404);
    const event = eventSnap.data();
    if (event.competitionScheduleState?.status === 'draft') {
        throw fail('Publish the competition schedule before generating numbered seats.');
    }
    const venue = (event.venues || []).find(item => item.id === venueId);
    const templates = seatTemplatesFor(venue);
    if (!templates.length) throw fail(`No seat configuration found for venueId: ${venueId}`);
    for (const sessionId of sessionIds) {
        const separator = sessionId.indexOf('_');
        if (!(venue.sessions?.[sessionId.slice(0, separator)] || []).includes(sessionId.slice(separator + 1))) {
            throw fail(`Session ${sessionId} is not configured for this venue.`);
        }
    }

    const totals = { created: 0, refreshed: 0, preserved: 0 };
    const seats = db.collection(`seats${eventId}`);
    for (const sessionId of [...new Set(sessionIds)]) {
        for (let start = 0; start < templates.length; start += GENERATION_CHUNK_SIZE) {
            const chunk = templates.slice(start, start + GENERATION_CHUNK_SIZE);
            const counts = await db.runTransaction(async transaction => {
                const seatRefs = chunk.flatMap(template => [
                    seats.doc(`${venueId}-${template.areaType}-${template.seatLabel}_${eventId}_${sessionId}`),
                    seats.doc(`${template.areaType}-${template.seatLabel}_${eventId}_${sessionId}`),
                ]);
                const ownershipRefs = chunk.map(template =>
                    ownershipRef(physicalSeatKey(eventId, { venueId, sessionId, row: template.row, number: template.number })));
                const docs = await transaction.getAll(...seatRefs, ...ownershipRefs);
                const chunkCounts = { created: 0, refreshed: 0, preserved: 0 };
                chunk.forEach((template, index) => {
                    const current = docs[index * 2];
                    const legacy = docs[index * 2 + 1];
                    const ownership = docs[chunk.length * 2 + index];
                    const occupied = [current, legacy].some(doc => doc.exists && (doc.data().status !== 'available'
                        || doc.data().lockedByBookingId || doc.data().bookingId));
                    if (occupied || (ownership.exists && ownership.data().active !== false)) {
                        chunkCounts.preserved++;
                        return;
                    }
                    const target = legacy.exists ? legacy : current;
                    transaction.set(target.ref, { eventId, venueId, sessionId, status: 'available', ...template });
                    chunkCounts[target.exists ? 'refreshed' : 'created']++;
                });
                return chunkCounts;
            });
            Object.keys(totals).forEach(key => { totals[key] += counts[key]; });
        }
    }

    const flags = {};
    sessionIds.forEach(sessionId => {
        flags[`sessionsSeatsGenerated.${sessionId}`] = true; // Legacy support
        flags[`sessionsSeatsGenerated.${venueId}_${sessionId}`] = true;
    });
    await eventRef.update(flags);
    return { eventId, venueId, sessionIds, ...totals };
}

/**
 * Assigns numbered seats to a paid booking whose buyer did not select them during checkout.
 * Booking, seats, canonical ownership and physical-chair aliases are read in one transaction.
 */
async function assignPaidBookingSeats({ bookingId, seatIds }, actor = {}) {
    if (!validKey(bookingId)) throw fail('Booking is required.', 400);
    if (!Array.isArray(seatIds) || !seatIds.length || seatIds.length > 100 || seatIds.some(id => !validKey(id))) {
        throw fail('Select the seats to assign.', 400);
    }
    if (new Set(seatIds).size !== seatIds.length) throw fail('Select each physical seat only once.', 400);
    const bookingRef = db.collection('publicBookings').doc(bookingId);
    return db.runTransaction(async transaction => {
        const bookingSnap = await transaction.get(bookingRef);
        if (!bookingSnap.exists) throw fail('Booking no longer exists.', 404);
        const booking = bookingSnap.data();
        if (booking.seatingMode === 'free') throw fail('Orchestra uses free seating; numbered seats cannot be assigned.');
        if (!isPaid(booking)) throw fail('Seats can only be assigned to a paid booking.');
        if (!booking.eventId) throw fail('Booking has no event reference.');
        const currentSeatIds = booking.selectedSeatIds || [];
        if (seatIds.some(id => currentSeatIds.includes(id))) throw fail('A selected seat is already assigned to this booking.');
        const ticketQuantities = (booking.tickets || []).filter(ticket => !isMasterclassTicket(ticket))
            .reduce((counts, ticket) => {
                const tierId = String(ticket.id || '').toLowerCase();
                counts[tierId] = (counts[tierId] || 0) + Number(ticket.quantity || 0);
                return counts;
            }, {});

        const seatsCollection = db.collection(`seats${booking.eventId}`);
        const allSeatIds = [...currentSeatIds, ...seatIds];
        const seatDocs = await transaction.getAll(...allSeatIds.map(id => seatsCollection.doc(id)));
        seatDocs.forEach((seatDoc, index) => {
            if (!seatDoc.exists) throw fail(`Selected seat ${allSeatIds[index]} no longer exists.`);
        });
        const physicalSeatKeys = seatDocs.map(seatDoc => physicalSeatKey(booking.eventId, seatDoc.data()));
        if (new Set(physicalSeatKeys).size !== physicalSeatKeys.length) throw fail('Select each physical seat only once.');
        const ownershipRefs = physicalSeatKeys.map(ownershipRef);
        const ownershipDocs = await transaction.getAll(...ownershipRefs);
        // Server SDK transactions support queries, keeping alias checks inside the atomic boundary.
        const aliasSnapshots = await Promise.all(seatDocs.map(seatDoc => {
            const seat = seatDoc.data();
            return transaction.get(seatsCollection.where('venueId', '==', seat.venueId)
                .where('sessionId', '==', seat.sessionId).where('row', '==', seat.row).where('number', '==', seat.number));
        }));

        const assignedByTier = {};
        seatDocs.forEach((seatDoc, index) => {
            const seat = seatDoc.data();
            const tierId = String(seat.areaType || '').toLowerCase();
            const label = seat.seatLabel || `${seat.row}${seat.number}`;
            if (seat.venueId !== booking.venue || seat.sessionId !== `${booking.date}_${booking.session}` || !ticketQuantities[tierId]) {
                throw fail(`Seat ${label} does not match this booking's session and tier.`);
            }
            if (index < currentSeatIds.length && (seat.status !== 'booked' || seat.bookingId !== bookingId)) {
                throw fail(`Existing seat ${label} is no longer booked by this booking.`);
            }
            if (index >= currentSeatIds.length && (seat.status !== 'available' || seat.lockedByBookingId || seat.bookingId)) {
                throw fail(`Seat ${label} is no longer available.`);
            }
            const ownership = ownershipDocs[index];
            if (ownership.exists && ownership.data().active !== false && ownership.data().bookingId !== bookingId) {
                throw fail(`Physical seat ${label} is already held by another booking.`);
            }
            const occupiedAlias = (aliasSnapshots[index].docs || []).find(alias => alias.id !== seatDoc.id
                && occupiedStatus(alias.data().status)
                && alias.data().lockedByBookingId !== bookingId && alias.data().bookingId !== bookingId);
            if (occupiedAlias) throw fail(`Physical seat ${label} is already occupied by an existing seat record.`);
            assignedByTier[tierId] = (assignedByTier[tierId] || 0) + 1;
            if (assignedByTier[tierId] > ticketQuantities[tierId]) throw fail(`Too many ${tierId} seats are assigned for this booking.`);
        });

        const updatedAt = admin.firestore.FieldValue.serverTimestamp();
        const buyerName = booking.buyerName || booking.userName || '';
        const newSeatDocs = seatDocs.slice(currentSeatIds.length);
        newSeatDocs.forEach((seatDoc, offset) => {
            const index = currentSeatIds.length + offset;
            transaction.update(seatDoc.ref, {
                status: 'booked', bookingId,
                assignedTo: { userName: buyerName, registrantName: buyerName, userEmail: booking.userEmail || '' },
                lockedAt: admin.firestore.FieldValue.delete(),
                lockedByBookingId: admin.firestore.FieldValue.delete(),
            });
            transaction.set(ownershipRefs[index], {
                eventId: booking.eventId, physicalSeatKey: physicalSeatKeys[index], bookingId,
                seatId: seatDoc.id, status: 'booked', active: true, updatedAt,
            });
        });
        const newSeatLabels = newSeatDocs.map(seatDoc => seatDoc.data().seatLabel || `${seatDoc.data().row}${seatDoc.data().number}`);
        transaction.update(bookingRef, {
            selectedSeatIds: allSeatIds,
            performanceSeatLabels: [...(booking.performanceSeatLabels || []), ...newSeatLabels],
            physicalSeatKeys,
            seatsSelected: true,
            seatAssignments: [...(booking.seatAssignments || []), {
                seatIds, assignedByUid: actor.uid || '', assignedByEmail: actor.email || '', assignedAt: new Date().toISOString(),
            }],
        });
        return { bookingId, assignedSeatIds: seatIds, seatLabels: newSeatLabels };
    });
}

module.exports = { generateSeatLayout, assignPaidBookingSeats };
