const { db, admin } = require('../configs/firebase-init');
const {
    physicalSeatKey, safeDocumentId, SEAT_OWNERSHIP_COLLECTION,
    capacityDocumentId, getPaidCapacityByTier, getReservedCapacityByTier,
} = require('./PublicTicketRepository');

// Staff seat writes run in Admin SDK transactions so they serialize with checkout, payment and each other.
const GENERATION_CHUNK_SIZE = 150;
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode, isOperational: true });
const validKey = value => typeof value === 'string' && value.length > 0 && value.length < 300 && !value.includes('/');
const isPaid = booking => booking.paymentStatus === 'PAID' || booking.paymentStatus === 'paid';
const isMasterclassTicket = ticket => ['master_class', 'masterclass'].includes(String(ticket.id || '').toLowerCase());
const occupiedStatus = status => ['locked', 'booked', 'reserved', 'blocked'].includes(String(status || '').toLowerCase());
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
                // Serialize the first seat writes with venue-layout edits on the event document.
                const currentEventSnap = await transaction.get(eventRef);
                const currentEvent = currentEventSnap.data();
                const currentVenue = (currentEvent?.venues || []).find(item => item.id === venueId);
                if (!currentEventSnap.exists || currentEvent.competitionScheduleState?.status === 'draft'
                    || JSON.stringify(currentVenue?.seatConfig) !== JSON.stringify(venue.seatConfig)
                    || !(currentVenue?.sessions?.[sessionId.slice(0, sessionId.indexOf('_'))] || [])
                        .includes(sessionId.slice(sessionId.indexOf('_') + 1))) {
                    throw fail('Venue layout or schedule changed. Refresh before generating seats.');
                }
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
                    // Available-chair refreshes must retain block revisions so an old admin
                    // dialog cannot match a newer block after regeneration (an ABA conflict).
                    const blockRevision = Math.max(...[current, legacy, ownership]
                        .map(record => record.data()?.seatBlockRevision || 0));
                    const lastSeatBlock = target.data()?.lastSeatBlock;
                    transaction.set(target.ref, {
                        eventId, venueId, sessionId, status: 'available', ...template,
                        ...(blockRevision ? { seatBlockRevision: blockRevision } : {}),
                        ...(lastSeatBlock ? { lastSeatBlock } : {}),
                    });
                    chunkCounts[target.exists ? 'refreshed' : 'created']++;
                });
                // Write the unchanged snapshot to serialize with edits, without marking
                // a partially generated session complete. Flags are set after all chunks.
                transaction.update(eventRef, { venues: currentEvent.venues });
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

/** Keep an unused competition chair out of sale, including tickets sold without seat selection. */
async function setSeatBlock({ eventId, venueId, sessionId, seatId, action, reason, expectedRevision }, actor = {}) {
    if (![eventId, venueId, sessionId, seatId].every(validKey)
        || !['block', 'unblock'].includes(action)
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw fail('A seat, session, action and current block revision are required.', 400);
    }
    const note = typeof reason === 'string' ? reason.trim() : '';
    if (action === 'block' && (!note || note.length > 500)) {
        throw fail('Enter a reason for the block (up to 500 characters).', 400);
    }
    if (!actor.uid || !actor.email) throw fail('Admin authentication is required.', 401);
    const separator = sessionId.indexOf('_');
    const date = sessionId.slice(0, separator);
    const session = sessionId.slice(separator + 1);
    const eventRef = db.collection('events').doc(eventId);
    const seats = db.collection(`seats${eventId}`);
    const seatRef = seats.doc(seatId);
    const capacityRef = db.collection('ticketCapacity').doc(capacityDocumentId(eventId, venueId, date, session));

    return db.runTransaction(async transaction => {
        const [eventSnap, seatSnap, capacitySnap] = await transaction.getAll(eventRef, seatRef, capacityRef);
        if (!eventSnap.exists || !seatSnap.exists) throw fail('The event or seat no longer exists.', 404);
        const event = eventSnap.data();
        const venue = (event.venues || []).find(item => item.id === venueId);
        const seat = seatSnap.data();
        if (separator < 0 || !(venue?.sessions?.[date] || []).includes(session)
            || [...(event.orchestraSessions || []), ...(event.masterclassSessions || [])]
                .some(item => item.venue === venueId && item.date === date && item.time === session)
            || seat.eventId !== eventId || seat.venueId !== venueId || seat.sessionId !== sessionId) {
            throw fail('Select a numbered seat in the current competition session.');
        }
        const tierId = String(seat.areaType || '').toLowerCase();
        if (!(venue.seatConfig || []).some(row => row.row === seat.row
            && String(row.areaType || '').toLowerCase() === tierId
            && Number.isInteger(seat.number) && seat.number > 0 && seat.number <= Number(row.seatCount))) {
            throw fail('This seat no longer matches the venue layout.');
        }
        if ((seat.seatBlockRevision || 0) !== expectedRevision) {
            throw fail('The seat block changed. Refresh the layout before trying again.');
        }
        const key = physicalSeatKey(eventId, seat);
        const ownerRef = ownershipRef(key);
        const ownerSnap = await transaction.get(ownerRef);
        const aliases = await transaction.get(seats.where('venueId', '==', venueId).where('sessionId', '==', sessionId)
            .where('row', '==', seat.row).where('number', '==', seat.number));
        const blockedSeats = await transaction.get(seats.where('venueId', '==', venueId)
            .where('sessionId', '==', sessionId).where('status', '==', 'blocked'));
        const sessionBookings = !capacitySnap.exists
            ? await transaction.get(db.collection('publicBookings').where('eventId', '==', eventId)
                .where('venue', '==', venueId).where('date', '==', date).where('session', '==', session))
            : { docs: [] };

        const isBlocking = action === 'block';
        const expectedStatus = isBlocking ? 'available' : 'blocked';
        if (!aliases.docs.length || aliases.docs.some(alias => {
            const data = alias.data();
            return data.status !== expectedStatus || data.bookingId || data.lockedByBookingId
                || data.eventId !== eventId || data.areaType !== seat.areaType
                || !Number.isSafeInteger(data.seatBlockRevision || 0) || (data.seatBlockRevision || 0) < 0
                || (!isBlocking && (!data.seatBlock || data.seatBlockRevision !== expectedRevision));
        })) {
            throw fail('This chair is booked, held, or changed. Refresh the layout before trying again.');
        }
        const owner = ownerSnap.data();
        if (isBlocking ? (ownerSnap.exists && owner.active !== false)
            : (!ownerSnap.exists || owner.active !== true || owner.status !== 'blocked'
                || owner.bookingId || owner.seatBlockRevision !== expectedRevision)) {
            throw fail('The physical chair ownership changed. Refresh or reconcile it before trying again.');
        }
        const blockedByTier = {};
        const blockedKeys = new Set();
        blockedSeats.docs.forEach(record => {
            const data = record.data();
            const physicalKey = physicalSeatKey(eventId, data);
            if (blockedKeys.has(physicalKey)) return;
            blockedKeys.add(physicalKey);
            const tier = String(data.areaType || '').toLowerCase();
            blockedByTier[tier] = (blockedByTier[tier] || 0) + 1;
        });
        const savedBlocked = capacitySnap.data()?.blockedByTier || {};
        if (capacitySnap.exists && [...new Set([...Object.keys(savedBlocked), ...Object.keys(blockedByTier)])]
            .some(tier => Number(savedBlocked[tier] || 0) !== (blockedByTier[tier] || 0))) {
            throw fail('Seat block capacity needs reconciliation before changing this block.');
        }
        const reservedByTier = capacitySnap.exists ? capacitySnap.data().reservedByTier || {}
            : getReservedCapacityByTier(sessionBookings.docs.map(record => record.data()));
        const capacityByTier = getPaidCapacityByTier(venue);
        blockedByTier[tierId] = (blockedByTier[tierId] || 0) + (isBlocking ? 1 : -1);
        const reserved = Number(reservedByTier[tierId] || 0);
        if (!Number.isSafeInteger(reserved) || reserved < 0 || blockedByTier[tierId] < 0) {
            throw fail('Session capacity needs reconciliation before changing this block.');
        }
        if (isBlocking && reserved + blockedByTier[tierId] > (capacityByTier[tierId] || 0)) {
            throw fail(`This chair is needed for existing paid or held ${tierId} tickets. There is no spare capacity to block it.`);
        }

        const updatedAt = admin.firestore.FieldValue.serverTimestamp();
        const revision = Math.max(...aliases.docs.map(alias => alias.data().seatBlockRevision || 0)) + 1;
        const block = { reason: note, blockedByUid: actor.uid, blockedByEmail: actor.email, blockedAt: updatedAt };
        const lastSeatBlock = !isBlocking ? {
            ...seat.seatBlock, unblockedByUid: actor.uid, unblockedByEmail: actor.email, unblockedAt: updatedAt,
        } : null;
        aliases.docs.forEach(alias => transaction.update(alias.ref, {
            status: isBlocking ? 'blocked' : 'available', seatBlockRevision: revision,
            seatBlock: isBlocking ? block : admin.firestore.FieldValue.delete(),
            ...(!isBlocking ? { lastSeatBlock } : {}),
        }));
        transaction.set(ownerRef, {
            eventId, physicalSeatKey: key, seatId, status: isBlocking ? 'blocked' : 'available',
            active: isBlocking, seatBlockRevision: revision, updatedAt,
        });
        const capacityData = {
            eventId, venue: venueId, date, session, pool: 'paid', capacityByTier,
            capacityPolicy: 'numbered_layout', reservedByTier, blockedByTier, updatedAt,
        };
        if (capacitySnap.exists) transaction.update(capacityRef, capacityData);
        else transaction.set(capacityRef, capacityData);
        return { seatId, status: isBlocking ? 'blocked' : 'available', revision };
    });
}

module.exports = { generateSeatLayout, assignPaidBookingSeats, setSeatBlock };
