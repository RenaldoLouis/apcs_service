const { db, admin } = require('../configs/firebase-init');
const model = require('../services/TicketRedemptionModel');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');

function validateIdentity({ eventId, bookingId }) {
    if (!model.validateKey(eventId) || !model.validateKey(bookingId)) throw new AppError('Event and Booking ID are required.', 400);
}
const assignmentId = (eventId, registrantId) => encodeURIComponent(`${eventId}|${registrantId}`);
const milliseconds = value => value?.toMillis?.() ?? value?.toDate?.().getTime() ?? null;
const customer = booking => ({ id: booking.id, buyerName: booking.buyerName || booking.userName || '',
    userEmail: booking.userEmail || '', userPhone: booking.userPhone || '', registrantName: booking.registrantName || '',
    registrantId: booking.registrantId || '', paymentStatus: booking.paymentStatus, bookingType: booking.bookingType || 'historical',
    venueName: booking.venueName || booking.venue, date: booking.date, session: booking.session,
    seatingMode: booking.seatingMode, performanceSeatLabels: booking.performanceSeatLabels || [] });

async function contextFor({ eventId, bookingId }, transaction) {
    validateIdentity({ eventId, bookingId });
    const read = ref => transaction ? transaction.get(ref) : ref.get();
    const [bookingSnap, eventSnap] = await Promise.all([
        read(db.collection('publicBookings').doc(bookingId)), read(db.collection('events').doc(eventId)),
    ]);
    if (!bookingSnap.exists || bookingSnap.data().eventId !== eventId || bookingSnap.data().paymentStatus === 'archived_test') {
        throw new AppError('Booking was not found in this event.', 404);
    }
    if (!eventSnap.exists) throw new AppError('Event was not found.', 404);
    const booking = { ...bookingSnap.data(), id: bookingId };
    const assignmentSnap = booking.registrantId
        ? await read(db.collection('orchestraAssignments').doc(assignmentId(eventId, booking.registrantId))) : null;
    const assignment = assignmentSnap?.exists ? assignmentSnap.data() : null;
    const allowances = model.allowancesFor(booking, eventSnap.data(), assignment);
    return { booking, assignment, allowances };
}

async function detail(input) {
    const context = await contextFor(input);
    const allowances = await Promise.all(context.allowances.map(async allowance => {
        const [state, history] = await Promise.all([
            db.collection('ticketRedemptions').doc(allowance.id).get(),
            db.collection(`ticketRedemptions/${allowance.id}/claims`).orderBy('revision', 'desc').limit(20).get(),
        ]);
        return { ...model.withState(allowance, state.exists ? state.data() : null),
            history: history.docs.map(doc => ({ id: doc.id, ...doc.data(), claimedAt: milliseconds(doc.data().claimedAt) })) };
    }));
    return { booking: customer(context.booking), allowances };
}

// Explicit staff searches scan bounded, event-scoped pages. Continue from the last examined document.
async function list({ eventId, search = '', cursor }) {
    if (!model.validateKey(eventId) || typeof search !== 'string' || search.length > 200 || (cursor && !model.validateKey(cursor))) {
        throw new AppError('Invalid event, search or cursor.', 400);
    }
    const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const bookings = [];
    let after = cursor, exhausted = false, scanned = 0;
    while (bookings.length < 25 && scanned < 500 && !exhausted) {
        let query = db.collection('publicBookings').where('eventId', '==', eventId)
            .orderBy(admin.firestore.FieldPath.documentId()).limit(100);
        if (after) query = query.startAfter(after);
        const page = await query.get();
        if (!page.docs.length) { exhausted = true; break; }
        for (const doc of page.docs) {
            after = doc.id; scanned += 1;
            const booking = { ...doc.data(), id: doc.id };
            const haystack = [booking.id, booking.buyerName, booking.userName, booking.userEmail, booking.userPhone,
                booking.registrantName, booking.registrantId].join(' ').toLowerCase().replace(/\s+/g, ' ');
            if (booking.paymentStatus !== 'archived_test' && terms.every(term => haystack.includes(term))) bookings.push(booking);
            if (bookings.length === 25 || scanned === 500) break;
        }
        exhausted = after === page.docs[page.docs.length - 1].id && page.docs.length < 100;
    }
    const rows = await Promise.all(bookings.map(async booking => {
        const row = customer(booking);
        let ticketTotal;
        try { ticketTotal = model.total(model.ticketBuckets(booking)); }
        catch (error) { return { ...row, reviewRequired: true }; }
        const direct = booking.bookingType === 'public_orchestra' || booking.isOrchestra === true || booking.seatingMode === 'free';
        const quantities = { performance: direct || booking.isMasterclass ? 0 : ticketTotal,
            orchestra: direct ? ticketTotal : (booking.ticketingVersion === 2 ? booking.orchestraAttendanceTickets : booking.complimentaryTickets) || 0 };
        const summaries = await Promise.all(Object.entries(quantities).map(async ([channel, quantity]) => {
            if (!quantity) return [channel, null];
            const state = await db.collection('ticketRedemptions').doc(model.redemptionId(eventId, booking.id, channel)).get();
            return [channel, { redeemed: model.total(state.data()?.redeemed || {}), total: quantity }];
        }));
        return { ...row, redemption: Object.fromEntries(summaries) };
    }));
    return { bookings: rows, nextCursor: exhausted ? null : after, scanned };
}

async function claim(input, actor) {
    validateIdentity(input);
    const { eventId, bookingId, channel, requestId, expectedRevision, sessionKey, action = 'redeem', quantities, targetClaimId, reason } = input;
    if (!['performance', 'orchestra', 'performers'].includes(channel) || !model.validateKey(requestId) ||
        !model.count(expectedRevision) || !['redeem', 'undo'].includes(action) || typeof sessionKey !== 'string' || sessionKey.length > 1000) {
        throw new AppError('Invalid redemption request.', 400);
    }
    if (!actor?.uid || !actor?.email) throw new AppError('Ticketing administrator is required.', 403);
    if (action === 'redeem' && (!quantities || Array.isArray(quantities) || typeof quantities !== 'object' ||
        !Object.keys(quantities).length || Object.keys(quantities).length > 3 ||
        Object.values(quantities).some(quantity => !model.count(quantity)) || !model.total(quantities))) {
        throw new AppError('Enter whole ticket quantities greater than zero.', 400);
    }
    if (action === 'undo' && (!model.validateKey(targetClaimId) || typeof reason !== 'string' || !reason.trim() || reason.length > 500)) {
        throw new AppError('Select a claim and enter a correction reason (maximum 500 characters).', 400);
    }
    const signature = JSON.stringify([eventId, bookingId, channel, action, sessionKey,
        action === 'redeem' ? Object.entries(quantities).sort(([a], [b]) => a.localeCompare(b)) : [targetClaimId, reason.trim()]]);
    return db.runTransaction(async transaction => {
        const context = await contextFor(input, transaction);
        const allowance = context.allowances.find(item => item.channel === channel);
        if (!allowance) throw model.fail('This booking has no entitlement for that redemption type.');
        const stateRef = db.collection('ticketRedemptions').doc(allowance.id);
        const requestRef = db.collection(`ticketRedemptions/${allowance.id}/requests`).doc(requestId);
        const [stateSnap, requestSnap] = await Promise.all([transaction.get(stateRef), transaction.get(requestRef)]);
        if (requestSnap.exists) {
            if (requestSnap.data().signature !== signature) throw model.fail('This request ID was already used for a different claim.');
            const previousClaim = await transaction.get(db.collection(`ticketRedemptions/${allowance.id}/claims`)
                .doc(requestSnap.data().result.claimId));
            if (!previousClaim.exists) throw model.fail('The original claim history needs review.');
            if (previousClaim.data().action === 'redeem') {
                if (previousClaim.data().undoneBy) throw model.fail('This claim has been undone. Refresh and review the correction before handing over tickets.');
                const current = model.withState(allowance, stateSnap.exists ? stateSnap.data() : null);
                if (current.blockedReason) throw model.fail(current.blockedReason);
                if (current.sessionKey !== model.sessionKey(previousClaim.data().session)) throw model.fail('The original claim session changed. Review its history before handing over tickets.');
            }
            return { ...requestSnap.data().result, replayed: true };
        }
        const state = stateSnap.exists ? stateSnap.data() : null;
        const current = model.withState(allowance, state);
        if (current.revision !== expectedRevision) throw model.fail('Another staff member changed this allowance. Refresh and review the latest counts.');
        if (action === 'redeem' && current.blockedReason) throw model.fail(current.blockedReason);
        if (!model.isPaid(context.booking)) throw model.fail('Payment is not confirmed.');
        if (action === 'redeem' && current.sessionKey !== sessionKey) throw model.fail('The assigned session changed. Refresh before handing over tickets.');
        if (channel === 'performers') {
            // Check the paid winner behind the assignment; an assignment by itself is not admission.
            const snapshots = await Promise.all((context.assignment.bookingIds || []).map(id => transaction.get(db.collection('publicBookings').doc(id))));
            if (!snapshots.some(snap => snap.exists && model.isPaid(snap.data()) && snap.data().eventId === eventId &&
                snap.data().registrantId === context.booking.registrantId && snap.data().bookingType === 'winner' &&
                snap.data().ticketingVersion === 2 && Number(snap.data().performerCount || 0) >= allowance.quantities.performers)) {
                throw model.fail('The paid winner entitlement for performer places needs review.');
            }
        }
        let amounts = quantities, targetRef, target;
        if (action === 'undo') {
            targetRef = db.collection(`ticketRedemptions/${allowance.id}/claims`).doc(targetClaimId);
            const targetSnap = await transaction.get(targetRef);
            target = targetSnap.exists ? targetSnap.data() : null;
            if (!target || target.action !== 'redeem' || target.undoneBy) throw model.fail('This claim cannot be undone or has already been undone.');
            amounts = target.quantities;
        }
        const redeemed = { ...current.redeemed };
        for (const [tier, quantity] of Object.entries(amounts)) {
            if (!Object.hasOwn(allowance.quantities, tier) || !model.count(quantity) ||
                (action === 'redeem' && quantity > current.remaining[tier]) || (action === 'undo' && quantity > (redeemed[tier] || 0))) {
                throw model.fail('The quantity exceeds the remaining entitlement. Refresh and review the counts.');
            }
            redeemed[tier] = (redeemed[tier] || 0) + (action === 'undo' ? -quantity : quantity);
        }
        const revision = current.revision + 1;
        const claimId = String(revision).padStart(12, '0');
        const claimedAt = admin.firestore.FieldValue.serverTimestamp();
        const result = { redemptionId: allowance.id, claimId, revision, redeemed };
        const record = { revision, action, quantities: amounts, bookingId, channel, session: action === 'undo' ? target.session : allowance.session,
            actorUid: actor.uid, actorEmail: actor.email, claimedAt, requestId,
            ...(action === 'undo' ? { targetClaimId, reason: reason.trim() } : {}) };
        // Every read above precedes all writes. The stable allowance ID survives assignment revisions.
        transaction.set(stateRef, { eventId, bookingId: channel === 'performers' ? '' : bookingId,
            registrantId: context.booking.registrantId || '', channel, redeemed, revision,
            sessionKey: action === 'undo' ? state.sessionKey : allowance.sessionKey,
            session: action === 'undo' ? state.session : allowance.session, updatedAt: claimedAt });
        transaction.set(db.collection(`ticketRedemptions/${allowance.id}/claims`).doc(claimId), record);
        transaction.set(requestRef, { signature, result });
        if (targetRef) transaction.update(targetRef, { undoneBy: claimId });
        return result;
    });
}

module.exports = { list, detail, claim };
