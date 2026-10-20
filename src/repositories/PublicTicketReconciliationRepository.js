const { db, admin } = require('../configs/firebase-init');
const {
    physicalSeatKey, safeDocumentId, capacityDocumentId, getPaidCapacityByTier, getReservedCapacityByTier,
} = require('./PublicTicketRepository');

const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode, isOperational: true });
const validId = value => typeof value === 'string' && value.length > 0 && value.length < 300 && !value.includes('/');
const isPaid = booking => ['PAID', 'paid'].includes(booking.paymentStatus);
const sameSet = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && new Set(left).size === left.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
const sameCounts = (left, right) => [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .every(tier => Number(left[tier] || 0) === Number(right[tier] || 0));
const quantities = tickets => {
    if (!Array.isArray(tickets) || !tickets.length) throw fail('Booking ticket quantities need staff review.');
    const counts = {};
    tickets.forEach(ticket => {
        const tier = String(ticket.id || '').toLowerCase();
        if (!/^[a-z0-9_-]+$/.test(tier) || !Number.isSafeInteger(ticket.quantity) || ticket.quantity < 1) {
            throw fail('Booking ticket quantities need staff review.');
        }
        counts[tier] = (counts[tier] || 0) + ticket.quantity;
    });
    return counts;
};

// Some historical expiry writers released seat aliases but retained canonical ownership
// and the full capacity reservation. Prove those holds before including their demand.
async function readRetainedExpiredHolds(transaction, bookingDocs, eventId, capacityId, seats, sessionId, venue) {
    const candidates = bookingDocs.filter(doc => {
        const item = doc.data();
        return item.paymentStatus === 'expired' && !item.isMasterclass && !item.isOrchestra
            && Array.isArray(item.physicalSeatKeys) && item.physicalSeatKeys.length;
    });
    const allKeys = [...new Set(candidates.flatMap(doc => doc.data().physicalSeatKeys))];
    if (allKeys.length > 400 || allKeys.some(key => !validId(key))) {
        throw fail('Other expired booking inventory needs separate staff review.');
    }
    const ownership = allKeys.length ? await transaction.getAll(...allKeys.map(key =>
        db.collection('ticketSeatOwnership').doc(safeDocumentId(key)))) : [];
    const ownersByKey = new Map(allKeys.map((key, index) => [key, ownership[index].data()]));
    const held = [];
    for (const doc of candidates) {
        const item = doc.data();
        const keys = item.physicalSeatKeys;
        const owned = keys.filter(key => {
            const owner = ownersByKey.get(key);
            return owner && owner.bookingId === doc.id && owner.active !== false;
        });
        if (!owned.length) continue; // Fully released or now owned by another booking.
        const byTier = quantities(item.tickets);
        const ids = item.selectedSeatIds;
        if (!sameSet(keys, keys) || owned.length !== keys.length
            || keys.length !== Object.values(byTier).reduce((sum, count) => sum + count, 0)
            || !sameSet(ids, ids) || ids.length !== keys.length || ids.some(id => !validId(id))
            || item.capacityReservation?.capacityId !== capacityId
            || !sameCounts(item.capacityReservation.byTier || {}, byTier)
            || owned.some(key => ownersByKey.get(key).eventId !== eventId
                || !['locked', 'booked'].includes(ownersByKey.get(key).status))) {
            throw fail('Other expired booking inventory needs separate staff review.');
        }
        const originals = await transaction.getAll(...ids.map(id => seats.doc(id)));
        const selectedByTier = {};
        for (const original of originals) {
            const chair = original.data();
            const tier = String(chair?.areaType || '').toLowerCase();
            if (!original.exists || chair.eventId !== eventId || chair.venueId !== venue.id
                || chair.sessionId !== sessionId || !keys.includes(physicalSeatKey(eventId, chair))
                || !(venue.seatConfig || []).some(row => row.row === chair.row
                    && String(row.areaType || '').toLowerCase() === tier && Number.isInteger(chair.number)
                    && chair.number > 0 && chair.number <= Number(row.seatCount))) {
                throw fail('Other expired booking inventory needs separate staff review.');
            }
            selectedByTier[tier] = (selectedByTier[tier] || 0) + 1;
        }
        if (!sameSet(originals.map(doc => physicalSeatKey(eventId, doc.data())), keys)
            || !sameCounts(selectedByTier, byTier)) {
            throw fail('Other expired booking inventory needs separate staff review.');
        }
        held.push({ booking: item, byTier });
    }
    return held;
}

// Promise-returning and caught by the controller. No provider calls, emails or writes outside
// the transaction: a conflict must leave the entire booking and inventory unchanged.
async function reconcileVerifiedExpiredBooking(input = {}, actor = {}) {
    const { bookingId, eventId, invoiceId, receiptId, amount, seatIds, confirmedPaid, note = '' } = input;
    if (![bookingId, eventId, invoiceId, receiptId].every(validId) || confirmedPaid !== true
        || !Number.isSafeInteger(amount) || amount <= 0 || !Array.isArray(seatIds)
        || seatIds.length > 100 || seatIds.some(id => !validId(id)) || !sameSet(seatIds, seatIds)
        || typeof note !== 'string' || note.trim().length > 500) {
        throw fail('Confirm the matching invoice and full payment in Paper.id before recovering this booking.', 400);
    }
    if (!actor.uid || !actor.email) throw fail('Admin authentication is required.', 401);

    const bookingRef = db.collection('publicBookings').doc(bookingId);
    return db.runTransaction(async transaction => {
        const bookingSnap = await transaction.get(bookingRef);
        if (!bookingSnap.exists) throw fail('Booking no longer exists.', 404);
        const booking = bookingSnap.data();
        if (booking.eventId !== eventId || booking.invoiceId !== invoiceId || booking.totalAmount !== amount
            || booking.paymentReceipt?.receiptId !== receiptId || !sameSet(booking.selectedSeatIds || [], seatIds)) {
            throw fail('Booking details changed. Refresh the customer list and verify payment again.');
        }
        // A lost acknowledgement or another administrator must never duplicate capacity or email.
        if (isPaid(booking) && booking.paymentReconciliation?.receiptId === receiptId
            && booking.paymentReconciliation.invoiceId === invoiceId) {
            return { id: bookingId, ...booking, alreadyPaid: true };
        }
        if (booking.paymentStatus !== 'expired' || booking.paymentMode !== 'paper_id'
            || booking.ticketingVersion !== 2 || booking.seatingMode !== 'numbered'
            || !['winner', 'public_competition'].includes(booking.bookingType)
            || booking.isOrchestra || booking.isMasterclass || booking.winnerClaimId
            || Number(booking.complimentaryTickets || 0) || Number(booking.freeMasterclassCount || 0)
            || (booking.orchestraSelectedSeatIds || []).length
            || booking.paymentReceipt?.status !== 'needs_review'
            || booking.paymentReceipt?.reason !== 'booking_canceled_before_payment') {
            throw fail('Only expired version-2 Paper.id competition bookings with a late-payment receipt can use this recovery.');
        }
        const byTier = quantities(booking.tickets);
        if (!validId(booking.venue) || !/^\d{4}-\d{2}-\d{2}$/.test(booking.date)
            || !/^\d{2}:\d{2}-\d{2}:\d{2}$/.test(booking.session)) {
            throw fail('The original booking session references need separate staff review.');
        }
        const capacityId = capacityDocumentId(eventId, booking.venue, booking.date, booking.session);
        if (booking.capacityReservation?.capacityId !== capacityId
            || !sameCounts(booking.capacityReservation.byTier || {}, byTier)) {
            throw fail('The original capacity reservation needs separate staff review.');
        }
        const capacityRef = db.collection('ticketCapacity').doc(capacityId);
        const receiptRef = db.collection('ticketPaymentReceipts').doc(receiptId);
        const seats = db.collection(`seats${eventId}`);
        const sessionId = `${booking.date}_${booking.session}`;
        const [eventSnap, capacitySnap, receiptSnap, seatDocs, sessionBookings, blockedSeats] = await Promise.all([
            transaction.get(db.collection('events').doc(eventId)), transaction.get(capacityRef), transaction.get(receiptRef),
            seatIds.length ? transaction.getAll(...seatIds.map(id => seats.doc(id))) : Promise.resolve([]),
            transaction.get(db.collection('publicBookings').where('eventId', '==', eventId)
                .where('venue', '==', booking.venue).where('date', '==', booking.date)
                .where('session', '==', booking.session).limit(1001)),
            transaction.get(seats.where('venueId', '==', booking.venue)
                .where('sessionId', '==', sessionId).where('status', '==', 'blocked')),
        ]);
        const event = eventSnap.data();
        const venue = event?.venues?.find(item => item.id === booking.venue);
        if (!eventSnap.exists || !venue || !(venue.sessions?.[booking.date] || []).includes(booking.session)
            || (event.orchestraSessions || []).some(item => item.venue === booking.venue
                && item.date === booking.date && item.time === booking.session)
            || (event.masterclassSessions || []).some(item => item.venue === booking.venue
                && item.date === booking.date && item.time === booking.session)) {
            throw fail('The original competition session needs separate staff review.');
        }
        const receipt = receiptSnap.data();
        const invoice = receipt?.payload?.invoice;
        const amounts = [invoice?.amount, invoice?.total_amount].filter(value => value !== undefined && value !== null && value !== '');
        const currency = String(booking.paymentCurrency || 'IDR').toUpperCase();
        if (!receiptSnap.exists || receipt.bookingId !== bookingId || receipt.providerInvoiceId !== invoiceId
            || receipt.status !== 'needs_review' || receipt.reason !== 'booking_canceled_before_payment'
            || invoice?.id !== invoiceId || (invoice.number && invoice.number !== bookingId)
            || String(invoice.status).toLowerCase() !== 'paid' || !amounts.length
            || amounts.some(value => Number(value) !== amount) || currency !== 'IDR'
            || ((invoice.currency || invoice.currency_code)
                && String(invoice.currency || invoice.currency_code).toUpperCase() !== currency)) {
            throw fail('The saved paid receipt does not match this invoice, currency and full booking amount.');
        }
        if (!capacitySnap.exists || sessionBookings.docs.length > 1000) {
            throw fail('Session capacity needs separate staff review before this payment can be recovered.');
        }
        const capacity = capacitySnap.data();
        if (capacity.eventId !== eventId || capacity.venue !== booking.venue || capacity.date !== booking.date
            || capacity.session !== booking.session || capacity.pool !== 'paid') {
            throw fail('The capacity record does not match the original booking session.');
        }
        if (seatDocs.some(seat => !seat.exists)) throw fail('An original seat no longer exists. Staff review is required.');
        const keys = seatDocs.map(seat => physicalSeatKey(eventId, seat.data()));
        if (!sameSet(keys, booking.physicalSeatKeys || [])) throw fail('Original physical seat references need staff review.');
        const ownerRefs = keys.map(key => db.collection('ticketSeatOwnership').doc(safeDocumentId(key)));
        const [owners, aliases] = await Promise.all([
            ownerRefs.length ? transaction.getAll(...ownerRefs) : Promise.resolve([]),
            Promise.all(seatDocs.map(seat => {
                const data = seat.data();
                return transaction.get(seats.where('venueId', '==', booking.venue).where('sessionId', '==', sessionId)
                    .where('row', '==', data.row).where('number', '==', data.number));
            })),
        ]);
        const selectedByTier = {};
        const aliasWrites = new Map();
        seatDocs.forEach((seatDoc, index) => {
            const seat = seatDoc.data();
            const tier = String(seat.areaType || '').toLowerCase();
            selectedByTier[tier] = (selectedByTier[tier] || 0) + 1;
            if (seat.eventId !== eventId || seat.venueId !== booking.venue || seat.sessionId !== sessionId
                || !byTier[tier] || selectedByTier[tier] > byTier[tier]
                || !(venue.seatConfig || []).some(row => row.row === seat.row
                    && String(row.areaType || '').toLowerCase() === tier && Number.isInteger(seat.number)
                    && seat.number > 0 && seat.number <= Number(row.seatCount))) {
                throw fail('An original seat no longer matches the purchased session, tier or venue layout.');
            }
            const owner = owners[index].data();
            if (owners[index].exists && owner.active !== false && (owner.bookingId !== bookingId
                || !['locked', 'booked'].includes(owner.status))) {
                throw fail(`Seat ${seat.seatLabel} is owned or blocked elsewhere. Stop for staff review.`);
            }
            if (!aliases[index].docs.some(alias => alias.id === seatDoc.id)) throw fail('Original seat aliases need staff review.');
            aliases[index].docs.forEach(alias => {
                const data = alias.data();
                const status = String(data.status || '').toLowerCase();
                if (data.eventId !== eventId || String(data.areaType || '').toLowerCase() !== tier
                    || !['available', 'locked', 'booked', 'reserved'].includes(status) || data.seatBlock
                    || (data.bookingId && data.bookingId !== bookingId)
                    || (data.lockedByBookingId && data.lockedByBookingId !== bookingId)
                    || (status !== 'available' && data.bookingId !== bookingId && data.lockedByBookingId !== bookingId)) {
                    throw fail(`Seat ${seat.seatLabel} is held, booked or blocked elsewhere. Stop for staff review.`);
                }
                aliasWrites.set(alias.ref.path, alias.ref);
            });
        });
        if (aliasWrites.size + ownerRefs.length > 450) throw fail('This booking requires separate staff review.');

        const otherBookingDocs = sessionBookings.docs.filter(doc => doc.id !== bookingId);
        const otherBookings = otherBookingDocs.map(doc => doc.data());
        const activeBookings = otherBookings.filter(item => !item.isMasterclass
            && (['pending', 'PAID', 'paid'].includes(item.paymentStatus)
                || (item.paymentStatus === 'failed' && item.checkoutFailure?.cleanupStatus !== 'complete')));
        const retainedExpired = await readRetainedExpiredHolds(transaction, otherBookingDocs,
            eventId, capacityId, seats, sessionId, venue);
        [...activeBookings, ...retainedExpired.map(hold => hold.booking)].forEach(item => {
            quantities(item.tickets);
            if ((item.physicalSeatKeys || []).some(key => keys.includes(key))
                || (item.selectedSeatIds || []).some(id => aliasWrites.has(`seats${eventId}/${id}`))) {
                throw fail('Another active booking references an original chair. Stop for staff review.');
            }
        });
        const baseline = getReservedCapacityByTier(activeBookings);
        // The shared checkout helper intentionally excludes expired records. Add only
        // the fully verified retained reservations here; never count all expired sales.
        retainedExpired.forEach(hold => Object.entries(hold.byTier).forEach(([tier, count]) => {
            baseline[tier] = (baseline[tier] || 0) + count;
        }));
        const restored = { ...baseline };
        Object.entries(byTier).forEach(([tier, count]) => { restored[tier] = (restored[tier] || 0) + count; });
        const before = capacity.reservedByTier || {};
        // Expiry may have released demand, or an older writer may have left it counted.
        // Accept exactly those two explainable states; never guess or erase unrelated demand.
        if (!sameCounts(before, baseline) && !sameCounts(before, restored)) {
            throw fail('The session capacity counter differs from its bookings. Stop for staff review.');
        }
        const blocked = {};
        const blockedKeys = new Set();
        blockedSeats.docs.forEach(doc => {
            const seat = doc.data();
            const key = physicalSeatKey(eventId, seat);
            if (blockedKeys.has(key)) return;
            blockedKeys.add(key);
            const tier = String(seat.areaType || '').toLowerCase();
            blocked[tier] = (blocked[tier] || 0) + 1;
        });
        if (!sameCounts(blocked, capacity.blockedByTier || {})) throw fail('Blocked-chair capacity needs staff review.');
        const ceiling = getPaidCapacityByTier(venue);
        for (const tier of new Set([...Object.keys(before), ...Object.keys(restored), ...Object.keys(blocked)])) {
            if (!Number.isSafeInteger(Number(before[tier] || 0)) || Number(before[tier] || 0) < 0
                || !Number.isSafeInteger(restored[tier] || 0) || (restored[tier] || 0) < 0
                || (restored[tier] || 0) + (blocked[tier] || 0) > Number(ceiling[tier] || 0)) {
                throw fail('There is insufficient valid capacity to restore this booking. Stop for staff review.');
            }
        }

        const now = admin.firestore.FieldValue.serverTimestamp();
        const audit = {
            source: 'admin_paper_dashboard', invoiceId, receiptId, amount, currency,
            recoveredFromStatus: booking.paymentStatus, previousReceiptReason: receipt.reason,
            note: note.trim(), reconciledByUid: actor.uid, reconciledByEmail: actor.email, reconciledAt: now,
            capacityBefore: before, capacityAfter: restored,
        };
        for (const ref of aliasWrites.values()) transaction.update(ref, {
            status: 'booked', bookingId, lockedAt: admin.firestore.FieldValue.delete(),
            lockedByBookingId: admin.firestore.FieldValue.delete(),
            assignedTo: { userName: booking.userName || booking.buyerName || '', userEmail: booking.userEmail || '',
                registrantName: booking.registrantName || '' },
        });
        ownerRefs.forEach((ref, index) => transaction.set(ref, {
            ...(owners[index].data() || {}), eventId, physicalSeatKey: keys[index], seatId: seatIds[index], bookingId,
            active: true, status: 'booked', updatedAt: now,
        }));
        transaction.update(capacityRef, { reservedByTier: restored, capacityByTier: ceiling,
            capacityPolicy: 'numbered_layout', updatedAt: now });
        const patch = {
            paymentStatus: 'PAID', paidAt: now, amountPaid: amount, paymentDetails: receipt.payload,
            paymentReceipt: { receiptId, status: 'processed', reason: 'admin_reconciled' },
            paymentReconciliation: audit, emailSent: false,
        };
        transaction.update(bookingRef, patch);
        transaction.update(receiptRef, { status: 'processed', reason: 'admin_reconciled', processedAt: now,
            nextAttemptAt: null, reconciliation: audit });
        return { id: bookingId, ...booking, ...patch, alreadyPaid: false };
    });
}

module.exports = { reconcileVerifiedExpiredBooking };
