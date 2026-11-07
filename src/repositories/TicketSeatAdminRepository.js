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

/** Replace staff-assigned competition chairs without changing paid capacity or entitlements. */
async function reassignPaidBookingSeats({ bookingId, seatIds, expectedSeatIds }, actor = {}) {
    const validIds = ids => Array.isArray(ids) && ids.length > 0 && ids.length <= 100
        && ids.every(validKey) && new Set(ids).size === ids.length;
    if (!validKey(bookingId) || !validIds(seatIds) || !validIds(expectedSeatIds)) {
        throw fail('The booking, replacement seats and original seat selection are required.', 400);
    }
    if (!actor.uid || !actor.email) throw fail('Admin authentication is required.', 401);
    const sameIds = (a, b) => a.length === b.length && a.every(id => b.includes(id));
    const bookingRef = db.collection('publicBookings').doc(bookingId);
    return db.runTransaction(async transaction => {
        const bookingSnap = await transaction.get(bookingRef);
        if (!bookingSnap.exists) throw fail('Booking no longer exists.', 404);
        const booking = bookingSnap.data();
        if (!isPaid(booking) || booking.seatingMode === 'free' || booking.isOrchestra || booking.isMasterclass
            || booking.bookingType === 'public_orchestra') {
            throw fail('Only paid numbered competition bookings can have their seats changed.');
        }
        if (!Array.isArray(booking.addOnIds || []) || (booking.addOnIds || [])
            .some(id => ['seat_selection', 'seat_selection_performer'].includes(String(id).toLowerCase()))) {
            throw fail('Seats cannot be edited for a booking with a seat-selection add-on.');
        }
        const currentSeatIds = booking.selectedSeatIds || [];
        if (!validIds(currentSeatIds) || !sameIds(currentSeatIds, expectedSeatIds)) {
            throw fail('The assigned seats changed. Close this dialog and refresh the booking before trying again.');
        }
        if (seatIds.length !== currentSeatIds.length) throw fail('Keep the same number of assigned seats. Use Assign Missing Seats for additional seats.');
        if (!validKey(booking.eventId)) throw fail('Booking has no valid event reference.');
        const eventSnap = await transaction.get(db.collection('events').doc(booking.eventId));
        const event = eventSnap.data();
        const venue = (event?.venues || []).find(item => item.id === booking.venue);
        const sessionId = `${booking.date}_${booking.session}`;
        if (!eventSnap.exists || !(venue?.sessions?.[booking.date] || []).includes(booking.session)
            || [...(event.orchestraSessions || []), ...(event.masterclassSessions || [])]
                .some(item => item.venue === booking.venue && item.date === booking.date && item.time === booking.session)) {
            throw fail('This booking no longer matches a configured competition session.');
        }
        const ticketQuantities = {};
        for (const ticket of booking.tickets || []) {
            if (isMasterclassTicket(ticket)) continue;
            const tier = String(ticket.id || '').toLowerCase();
            const quantity = Number(ticket.quantity);
            if (!['presto', 'allegro', 'lento'].includes(tier) || !Number.isSafeInteger(quantity) || quantity < 0) {
                throw fail('This booking has invalid ticket quantities. Reconcile it before editing seats.');
            }
            ticketQuantities[tier] = (ticketQuantities[tier] || 0) + quantity;
        }
        const seats = db.collection(`seats${booking.eventId}`);
        const allIds = [...new Set([...currentSeatIds, ...seatIds])];
        const seatDocs = await transaction.getAll(...allIds.map(id => seats.doc(id)));
        const docsById = new Map(seatDocs.map(record => [record.id, record]));
        const keys = seatDocs.map(record => {
            if (!record.exists) throw fail(`Seat ${record.id} no longer exists.`);
            const seat = record.data();
            if (seat.eventId !== booking.eventId || seat.venueId !== booking.venue || seat.sessionId !== sessionId
                || !(venue.seatConfig || []).some(row => row.row === seat.row
                    && String(row.areaType || '').toLowerCase() === String(seat.areaType || '').toLowerCase()
                    && Number.isInteger(seat.number) && seat.number > 0 && seat.number <= Number(row.seatCount))) {
                throw fail(`Seat ${seat.seatLabel || record.id} does not match this booking's session and venue layout.`);
            }
            return physicalSeatKey(booking.eventId, seat);
        });
        // Do not let another document ID masquerade as a replacement for the same chair.
        if (new Set(keys).size !== keys.length) throw fail('Select each physical seat only once. Refresh the seat map.');
        const ownerRefs = keys.map(ownershipRef);
        const owners = await transaction.getAll(...ownerRefs);
        const aliases = await Promise.all(seatDocs.map(record => {
            const seat = record.data();
            return transaction.get(seats.where('venueId', '==', seat.venueId).where('sessionId', '==', seat.sessionId)
                .where('row', '==', seat.row).where('number', '==', seat.number));
        }));
        const countsFor = ids => ids.reduce((counts, id) => {
            const tier = String(docsById.get(id).data().areaType || '').toLowerCase();
            counts[tier] = (counts[tier] || 0) + 1;
            return counts;
        }, {});
        const oldCounts = countsFor(currentSeatIds), newCounts = countsFor(seatIds);
        if (Object.keys({ ...oldCounts, ...newCounts }).some(tier => oldCounts[tier] !== newCounts[tier]
            || oldCounts[tier] > (ticketQuantities[tier] || 0))) {
            throw fail('Keep the same number of assigned seats in each purchased tier.');
        }
        seatDocs.forEach((record, index) => {
            const seat = record.data(), owner = owners[index].data();
            const existing = currentSeatIds.includes(record.id);
            if (existing ? (seat.status !== 'booked' || seat.bookingId !== bookingId
                || (seat.lockedByBookingId && seat.lockedByBookingId !== bookingId))
                : (seat.status !== 'available' || seat.bookingId || seat.lockedByBookingId)) {
                throw fail(`Seat ${seat.seatLabel || record.id} is no longer ${existing ? 'booked by this booking' : 'available'}. Refresh the booking.`);
            }
            if (owners[index].exists && owner.active !== false
                && (!existing || owner.bookingId !== bookingId || owner.status !== 'booked')) {
                throw fail(`Physical seat ${seat.seatLabel || record.id} has conflicting ownership.`);
            }
            if (aliases[index].docs.some(alias => {
                const data = alias.data();
                return data.eventId !== booking.eventId || data.areaType !== seat.areaType
                    || (data.bookingId && data.bookingId !== bookingId)
                    || (data.lockedByBookingId && data.lockedByBookingId !== bookingId)
                    || (existing ? (data.status !== 'available' && !(data.status === 'booked' && data.bookingId === bookingId))
                        : (data.status !== 'available' || data.bookingId || data.lockedByBookingId));
            })) throw fail(`Physical seat ${seat.seatLabel || record.id} has a conflicting seat record.`);
        });
        if (sameIds(currentSeatIds, seatIds)) return { bookingId, seatIds: currentSeatIds, changed: false };
        if (aliases.reduce((sum, snapshot) => sum + snapshot.docs.length + 1, 1) > 450) {
            throw fail('Too many seat records to change safely. Ask staff to reconcile duplicate seat records.');
        }
        const updatedAt = admin.firestore.FieldValue.serverTimestamp();
        const buyerName = booking.buyerName || booking.userName || '';
        seatDocs.forEach((record, index) => {
            if (currentSeatIds.includes(record.id) && seatIds.includes(record.id)) return;
            const booked = seatIds.includes(record.id);
            aliases[index].docs.forEach(alias => transaction.update(alias.ref, {
                status: booked ? 'booked' : 'available',
                bookingId: booked ? bookingId : admin.firestore.FieldValue.delete(),
                assignedTo: booked ? { userName: buyerName, registrantName: buyerName, userEmail: booking.userEmail || '' }
                    : admin.firestore.FieldValue.delete(),
                lockedAt: admin.firestore.FieldValue.delete(), lockedByBookingId: admin.firestore.FieldValue.delete(),
            }));
            transaction.set(ownerRefs[index], {
                eventId: booking.eventId, physicalSeatKey: keys[index], seatId: record.id,
                ...(booked ? { bookingId } : {}), status: booked ? 'booked' : 'available', active: booked, updatedAt,
            });
        });
        const oldKeys = currentSeatIds.map(id => keys[allIds.indexOf(id)]);
        const newKeys = seatIds.map(id => keys[allIds.indexOf(id)]);
        const labelsFor = ids => ids.map(id => {
            const seat = docsById.get(id).data();
            return seat.seatLabel || `${seat.row}${seat.number}`;
        });
        const seatLabels = labelsFor(seatIds);
        transaction.update(bookingRef, {
            selectedSeatIds: seatIds, performanceSeatLabels: seatLabels, seatsSelected: true,
            physicalSeatKeys: [...newKeys, ...(booking.physicalSeatKeys || []).filter(key => !oldKeys.includes(key))],
            seatChanges: [...(booking.seatChanges || []), {
                previousSeatIds: currentSeatIds, seatIds, previousSeatLabels: labelsFor(currentSeatIds), seatLabels,
                changedByUid: actor.uid, changedByEmail: actor.email, changedAt: new Date().toISOString(),
            }],
        });
        return { bookingId, seatIds, seatLabels, changed: true };
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

module.exports = { generateSeatLayout, assignPaidBookingSeats, reassignPaidBookingSeats, setSeatBlock };
