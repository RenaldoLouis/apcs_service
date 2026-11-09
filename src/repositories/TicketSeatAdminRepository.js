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

// Only recorded staff assignments (and their replacements) may move in a mixed booking.
function staffAssignedSeatIds(booking) {
    if (!Array.isArray(booking.addOnIds || [])) return [];
    const current = booking.selectedSeatIds || [];
    if (!(booking.addOnIds || []).some(id => ['seat_selection', 'seat_selection_performer'].includes(String(id).toLowerCase()))) return current;
    const staff = new Set((booking.seatAssignments || []).flatMap(item => item.seatIds || []));
    for (const change of booking.seatChanges || []) {
        for (const id of change.seatIds || []) {
            if (!(change.previousSeatIds || []).includes(id)) staff.add(id);
        }
    }
    return current.filter(id => staff.has(id));
}

// Snapshot prices follow individual chairs across later moves, even if tier prices change.
function seatPricesFor(booking, seatDocs) {
    const remaining = (booking.tickets || []).filter(ticket => !isMasterclassTicket(ticket))
        .map(ticket => ({ tier: String(ticket.id).toLowerCase(), quantity: ticket.quantity, price: ticket.priceEach }));
    const prices = {};
    for (const record of seatDocs) {
        const saved = booking.seatPriceSnapshots?.[record.id];
        if (saved === undefined) continue;
        const line = remaining.find(item => item.tier === String(record.data().areaType).toLowerCase()
            && item.price === saved && item.quantity > 0);
        if (!line || !Number.isSafeInteger(saved) || saved < 0) throw fail('The saved ticket prices need reconciliation.');
        line.quantity--; prices[record.id] = saved;
    }
    for (const record of seatDocs) {
        if (prices[record.id] !== undefined) continue;
        const line = remaining.find(item => item.tier === String(record.data().areaType).toLowerCase() && item.quantity > 0);
        if (!line || !Number.isSafeInteger(line.price) || line.price < 0) throw fail('The original ticket price is missing or invalid. Reconcile this booking before upgrading.');
        line.quantity--; prices[record.id] = line.price;
    }
    return prices;
}
const upgradeRevision = booking => {
    const revision = booking.seatUpgradeRevision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) throw fail('The seat upgrade history needs reconciliation.');
    return revision;
};
const upgradeBalance = booking => {
    const balance = booking.seatUpgradeBalance ?? 0;
    if (!Number.isSafeInteger(balance) || balance < 0 || (booking.seatUpgrades || []).filter(item => item.status === 'pending')
        .reduce((sum, item) => sum + item.amountDue, 0) !== balance) throw fail('The seat upgrade balance needs reconciliation.');
    return balance;
};

async function getSeatChangeOptions({ bookingId }, actor = {}) {
    if (!validKey(bookingId) || !actor.uid || !actor.email) throw fail('Admin authentication and a booking are required.', 400);
    return db.runTransaction(async transaction => {
        const snap = await transaction.get(db.collection('publicBookings').doc(bookingId));
        if (!snap.exists) throw fail('Booking no longer exists.', 404);
        const booking = snap.data();
        if (!isPaid(booking) || booking.seatingMode === 'free' || booking.isOrchestra || booking.isMasterclass
            || booking.bookingType === 'public_orchestra' || !validKey(booking.eventId)) throw fail('Select a paid numbered competition booking.');
        const ids = booking.selectedSeatIds || [];
        if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every(validKey) || new Set(ids).size !== ids.length) throw fail('The assigned seats need reconciliation.');
        const eventSnap = await transaction.get(db.collection('events').doc(booking.eventId));
        const docs = await transaction.getAll(...ids.map(id => db.collection(`seats${booking.eventId}`).doc(id)));
        if (!eventSnap.exists || docs.some(record => !record.exists || record.data().bookingId !== bookingId
            || record.data().status !== 'booked' || record.data().venueId !== booking.venue
            || record.data().sessionId !== `${booking.date}_${booking.session}`)) throw fail('The assigned seats changed. Refresh this booking.');
        const prices = seatPricesFor(booking, docs);
        const editable = staffAssignedSeatIds(booking);
        return { bookingId, expectedSeatIds: ids, revision: upgradeRevision(booking), balance: upgradeBalance(booking),
            seats: docs.filter(record => editable.includes(record.id)).map(record => ({ id: record.id,
                label: record.data().seatLabel, tier: String(record.data().areaType).toLowerCase(), price: prices[record.id] })),
            tierPrices: Object.fromEntries((eventSnap.data().ticketTiers || [])
                .filter(tier => ['presto', 'allegro', 'lento'].includes(tier.id))
                .map(tier => [tier.id, tier.venuePrices?.[booking.venue] ?? null])) };
    });
}

async function upgradePaidBookingSeat({ bookingId, fromSeatId, toSeatId, expectedSeatIds, expectedDifference, expectedRevision, expectedBalance }, actor = {}) {
    if (!validKey(fromSeatId) || !validKey(toSeatId) || fromSeatId === toSeatId
        || !Array.isArray(expectedSeatIds) || !expectedSeatIds.includes(fromSeatId)
        || expectedSeatIds.includes(toSeatId) || !Number.isSafeInteger(expectedDifference) || expectedDifference < 0
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
        || !Number.isSafeInteger(expectedBalance) || expectedBalance < 0) throw fail('Select one original chair and one replacement, and review the current price.', 400);
    return reassignPaidBookingSeats({ bookingId, expectedSeatIds,
        seatIds: expectedSeatIds.map(id => id === fromSeatId ? toSeatId : id),
        upgrade: { fromSeatId, toSeatId, expectedDifference, expectedRevision, expectedBalance } }, actor);
}

async function resolveSeatUpgradePayment({ bookingId, expectedRevision, expectedBalance }, actor = {}) {
    if (!validKey(bookingId) || !actor.uid || !actor.email || !Number.isSafeInteger(expectedRevision)
        || !Number.isSafeInteger(expectedBalance) || expectedBalance <= 0) throw fail('Review the outstanding seat upgrade payment before confirming.', 400);
    const ref = db.collection('publicBookings').doc(bookingId);
    return db.runTransaction(async transaction => {
        const snap = await transaction.get(ref);
        if (!snap.exists) throw fail('Booking no longer exists.', 404);
        const booking = snap.data();
        if (!isPaid(booking) || upgradeRevision(booking) !== expectedRevision || upgradeBalance(booking) !== expectedBalance) {
            throw fail('The seat upgrade payment changed. Refresh this booking before confirming.');
        }
        const history = booking.seatUpgrades || [];
        if (history.filter(item => item.status === 'pending').reduce((sum, item) => sum + item.amountDue, 0) !== expectedBalance) {
            throw fail('The seat upgrade history and balance need reconciliation.');
        }
        const paidAt = new Date().toISOString();
        transaction.update(ref, { seatUpgradeBalance: 0, seatUpgradeRevision: expectedRevision + 1,
            seatUpgrades: history.map(item => item.status === 'pending' ? { ...item, status: 'paid',
                paidAt, paidByUid: actor.uid, paidByEmail: actor.email, paymentMethod: 'outside_system' } : item) });
        return { bookingId, balance: 0, revision: expectedRevision + 1, resolvedAmount: expectedBalance };
    });
}

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

/** Replace staff-assigned competition chairs; upgrades also move tier capacity and record the internal balance. */
async function reassignPaidBookingSeats({ bookingId, seatIds, expectedSeatIds, upgrade = null }, actor = {}) {
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
        const editableSeatIds = staffAssignedSeatIds(booking);
        if ((booking.selectedSeatIds || []).some(id => !seatIds.includes(id) && !editableSeatIds.includes(id))) {
            throw fail('A buyer-selected seat with a seat-selection add-on cannot be changed. Only staff-assigned seats can move.');
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
        if (Object.keys(oldCounts).some(tier => oldCounts[tier] > (ticketQuantities[tier] || 0))) {
            throw fail('The assigned seats exceed the purchased ticket quantities.');
        }
        let upgradePatch = {}, capacityWrite = null, difference = 0;
        if (upgrade) {
            if (upgradeRevision(booking) !== upgrade.expectedRevision) throw fail('The seat upgrade changed. Refresh the booking and review the price.');
            const previousBalance = upgradeBalance(booking);
            if (previousBalance !== upgrade.expectedBalance) throw fail('The seat upgrade balance changed. Refresh this booking.');
            const source = docsById.get(upgrade.fromSeatId).data(), target = docsById.get(upgrade.toSeatId).data();
            const fromTier = String(source.areaType).toLowerCase(), toTier = String(target.areaType).toLowerCase();
            const ranks = { lento: 0, allegro: 1, presto: 2 };
            if (ranks[toTier] === undefined || ranks[fromTier] === undefined || ranks[toTier] < ranks[fromTier]) throw fail('Select the same tier or a higher tier. Downgrades are not supported.');
            const prices = seatPricesFor(booking, currentSeatIds.map(id => docsById.get(id)));
            const originalPrice = prices[upgrade.fromSeatId];
            const destinationPrice = fromTier === toTier ? originalPrice
                : (event.ticketTiers || []).find(tier => tier.id === toTier)?.venuePrices?.[booking.venue];
            if (!Number.isSafeInteger(destinationPrice) || destinationPrice < originalPrice) throw fail('The destination price is missing or below the original paid price. Reconcile pricing before upgrading.');
            difference = destinationPrice - originalPrice;
            if (difference !== upgrade.expectedDifference) throw fail('The upgrade price changed. Refresh the booking and review the additional amount.');
            const tickets = (booking.tickets || []).map(ticket => ({ ...ticket }));
            if (fromTier !== toTier) {
                const sourceLine = tickets.find(ticket => String(ticket.id).toLowerCase() === fromTier && ticket.priceEach === originalPrice && ticket.quantity > 0);
                if (!sourceLine) throw fail('The original ticket price needs reconciliation.');
                sourceLine.quantity--;
                const targetLine = tickets.find(ticket => String(ticket.id).toLowerCase() === toTier && ticket.priceEach === destinationPrice);
                if (targetLine) targetLine.quantity++;
                else tickets.push({ id: toTier, name: (event.ticketTiers || []).find(tier => tier.id === toTier)?.name || toTier,
                    quantity: 1, priceEach: destinationPrice });
                const byTier = { ...ticketQuantities, [fromTier]: ticketQuantities[fromTier] - 1, [toTier]: (ticketQuantities[toTier] || 0) + 1 };
                const redemptionRef = db.collection('ticketRedemptions').doc(encodeURIComponent(JSON.stringify([booking.eventId, 'performance', bookingId])));
                const redemption = (await transaction.get(redemptionRef)).data();
                if (Object.entries(redemption?.redeemed || {}).some(([tier, quantity]) => !Number.isSafeInteger(quantity)
                    || quantity < 0 || quantity > (byTier[tier] || 0))) throw fail('This upgrade would change tickets already redeemed. Correct the redemption before upgrading.');
                const capacityId = capacityDocumentId(booking.eventId, booking.venue, booking.date, booking.session);
                const capacityRef = db.collection('ticketCapacity').doc(capacityId);
                const capacitySnap = await transaction.get(capacityRef);
                if (!capacitySnap.exists || (booking.capacityReservation && (booking.capacityReservation.capacityId !== capacityId
                    || Object.keys({ ...ticketQuantities, ...(booking.capacityReservation.byTier || {}) }).some(tier =>
                        (booking.capacityReservation.byTier?.[tier] || 0) !== (ticketQuantities[tier] || 0))))) throw fail('This booking’s capacity reservation needs reconciliation before upgrading.');
                const capacity = capacitySnap.data(), reserved = { ...(capacity.reservedByTier || {}) };
                const ceilings = getPaidCapacityByTier(venue);
                const blocked = await transaction.get(seats.where('venueId', '==', booking.venue).where('sessionId', '==', sessionId).where('status', '==', 'blocked'));
                const blockedByTier = {}, seenBlocks = new Set();
                for (const record of blocked.docs) {
                    const key = physicalSeatKey(booking.eventId, record.data());
                    if (seenBlocks.has(key)) continue;
                    seenBlocks.add(key);
                    const tier = String(record.data().areaType).toLowerCase();
                    blockedByTier[tier] = (blockedByTier[tier] || 0) + 1;
                }
                if (Object.keys({ ...(capacity.blockedByTier || {}), ...blockedByTier }).some(tier =>
                    (capacity.blockedByTier?.[tier] || 0) !== (blockedByTier[tier] || 0))) throw fail('Seat block capacity needs reconciliation before upgrading.');
                for (const tier of [fromTier, toTier]) {
                    if (!Number.isSafeInteger(reserved[tier] ?? 0) || (reserved[tier] ?? 0) < (ticketQuantities[tier] || 0)) throw fail('Session capacity needs reconciliation before upgrading.');
                }
                reserved[fromTier]--; reserved[toTier] = (reserved[toTier] || 0) + 1;
                if (reserved[toTier] + (blockedByTier[toTier] || 0) > (ceilings[toTier] || 0)) throw fail('There is no remaining capacity in the destination tier, including tickets awaiting seats.');
                capacityWrite = { ref: capacityRef, data: { reservedByTier: reserved, capacityByTier: ceilings,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp() } };
                upgradePatch.tickets = tickets.filter(ticket => ticket.quantity > 0);
                upgradePatch.capacityReservation = { capacityId, byTier };
            }
            delete prices[upgrade.fromSeatId]; prices[upgrade.toSeatId] = destinationPrice;
            const revision = upgradeRevision(booking) + 1;
            if (!Number.isSafeInteger(previousBalance + difference)) throw fail('The total upgrade balance is too large.');
            upgradePatch = { ...upgradePatch, seatPriceSnapshots: prices, seatUpgradeRevision: revision,
                seatUpgradeBalance: previousBalance + difference, seatUpgrades: [...(booking.seatUpgrades || []), {
                    revision, fromSeatId: upgrade.fromSeatId, toSeatId: upgrade.toSeatId,
                    fromSeatLabel: source.seatLabel, toSeatLabel: target.seatLabel, fromTier, toTier,
                    originalPrice, destinationPrice, amountDue: difference, status: difference > 0 ? 'pending' : 'not_required',
                    changedAt: new Date().toISOString(), changedByUid: actor.uid, changedByEmail: actor.email,
                }] };
        } else if (Object.keys({ ...oldCounts, ...newCounts }).some(tier => (oldCounts[tier] || 0) !== (newCounts[tier] || 0))) {
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
        if (capacityWrite) transaction.update(capacityWrite.ref, capacityWrite.data);
        // Older same-tier callers retain individual price snapshots after a move.
        if (!upgrade && booking.seatPriceSnapshots) {
            const prices = { ...booking.seatPriceSnapshots };
            const removed = currentSeatIds.filter(id => !seatIds.includes(id));
            for (const id of seatIds.filter(id => !currentSeatIds.includes(id))) {
                const index = removed.findIndex(oldId => String(docsById.get(oldId).data().areaType).toLowerCase() === String(docsById.get(id).data().areaType).toLowerCase());
                const [oldId] = removed.splice(index, 1);
                if (prices[oldId] !== undefined) { prices[id] = prices[oldId]; delete prices[oldId]; }
            }
            upgradePatch.seatPriceSnapshots = prices;
        }
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
            ...upgradePatch,
            selectedSeatIds: seatIds, performanceSeatLabels: seatLabels, seatsSelected: true,
            physicalSeatKeys: [...newKeys, ...(booking.physicalSeatKeys || []).filter(key => !oldKeys.includes(key))],
            seatChanges: [...(booking.seatChanges || []), {
                previousSeatIds: currentSeatIds, seatIds, previousSeatLabels: labelsFor(currentSeatIds), seatLabels,
                changedByUid: actor.uid, changedByEmail: actor.email, changedAt: new Date().toISOString(),
            }],
        });
        return { bookingId, seatIds, seatLabels, changed: true,
            ...(upgrade ? { difference, balance: upgradePatch.seatUpgradeBalance, revision: upgradePatch.seatUpgradeRevision } : {}) };
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

module.exports = { generateSeatLayout, assignPaidBookingSeats, reassignPaidBookingSeats, setSeatBlock,
    getSeatChangeOptions, upgradePaidBookingSeat, resolveSeatUpgradePayment };
