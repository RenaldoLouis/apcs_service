const { db, admin } = require('../configs/firebase-init');
const idFor = (eventId, registrantId) => encodeURIComponent(`${eventId}|${registrantId}`);
const capacityIdFor = session => encodeURIComponent(`${session.eventId}|${session.venue}|${session.date}|${session.time}|paid`).replace(/%/g, '_');
const isPaid = booking => ['PAID', 'paid'].includes(booking.paymentStatus);
const ticketCount = booking => (booking.tickets || []).reduce((sum, ticket) => sum + Number(ticket.quantity || 0), 0);
const fail = message => Object.assign(new Error(message), { statusCode: 409, isOperational: true });
const validateKey = value => typeof value === 'string' && value.length > 0 && value.length < 200 && !value.includes('/');
const validateIdentity = (eventId, registrantId) => {
    if (!validateKey(eventId) || !validateKey(registrantId)) throw fail('Event and winner are required.');
};

// Read all purchases for this specific performance (including pending records).
// The transaction then observes a concurrent payment before saving an assignment.
async function readGroup(eventId, registrantId, transaction) {
    validateIdentity(eventId, registrantId);
    const read = ref => transaction ? transaction.get(ref) : ref.get();
    const [bookingsSnap, registrationSnap, assignmentSnap] = await Promise.all([
        read(db.collection('publicBookings').where('eventId', '==', eventId).where('registrantId', '==', registrantId)),
        read(db.collection('Registrants2025').doc(registrantId)),
        read(db.collection('orchestraAssignments').doc(idFor(eventId, registrantId))),
    ]);
    const allPaid = bookingsSnap.docs.map(doc => ({ ...doc.data(), id: doc.id })).filter(isPaid);
    const bookings = allPaid.filter(booking => booking.ticketingVersion === 2 && booking.orchestraAttendanceTickets > 0);
    const registration = registrationSnap.exists ? registrationSnap.data() : null;
    const winnerBookings = bookings.filter(booking => booking.bookingType !== 'public_competition');
    const performerCount = winnerBookings.length
        ? Math.max(1, ...winnerBookings.map(booking => Number(booking.performerCount || 1))) : 0;
    const paidTicketCount = bookings.reduce((sum, booking) => sum + ticketCount(booking), 0);
    const publicTicketCount = bookings.filter(booking => booking.bookingType === 'public_competition')
        .reduce((sum, booking) => sum + ticketCount(booking), 0);
    return {
        id: idFor(eventId, registrantId), eventId, registrantId,
        name: bookings[0]?.registrantName || registration?.name || registrantId,
        performerCount, paidTicketCount, publicTicketCount,
        winnerTicketCount: paidTicketCount - publicTicketCount,
        quantity: paidTicketCount ? paidTicketCount + performerCount : 0,
        bookings,
        legacyConflict: allPaid.some(booking => booking.ticketingVersion !== 2 && Number(booking.complimentaryTickets || 0) > 0),
        assignment: assignmentSnap.exists ? assignmentSnap.data() : null,
    };
}

async function listGroups({ eventId, cursor }) {
    if (!validateKey(eventId)) throw fail('Event is required.');
    let query = db.collection('publicBookings').where('eventId', '==', eventId)
        .where('paymentStatus', 'in', ['PAID', 'paid']).orderBy(admin.firestore.FieldPath.documentId()).limit(25);
    if (cursor) {
        if (!validateKey(cursor)) throw fail('Invalid page cursor.');
        query = query.startAfter(cursor);
    }
    const page = await query.get();
    const ids = [...new Set(page.docs.map(doc => doc.data()).filter(booking =>
        booking.ticketingVersion === 2 && booking.registrantId && booking.orchestraAttendanceTickets > 0)
        .map(booking => booking.registrantId))];
    const groups = await Promise.all(ids.map(id => readGroup(eventId, id)));
    return { groups: groups.map(({ bookings, ...group }) => ({ ...group, bookingCount: bookings.length })),
        nextCursor: page.docs.length === 25 ? page.docs[page.docs.length - 1].id : null };
}

async function assignGroup({ eventId, registrantId, sessionId }, actor) {
    validateIdentity(eventId, registrantId);
    if (!validateKey(sessionId)) throw fail('Select an orchestra session.');
    return db.runTransaction(async transaction => {
        const eventRef = db.collection('events').doc(eventId);
        const eventSnap = await transaction.get(eventRef);
        if (!eventSnap.exists) throw fail('Event no longer exists.');
        const event = eventSnap.data();
        const group = await readGroup(eventId, registrantId, transaction);
        if (!group.quantity) throw fail('Only paid performance-linked purchases can receive an orchestra assignment.');
        if (group.legacyConflict) throw fail('This winner has legacy orchestra allocations. Reconcile those records before assigning new attendance.');
        const sessions = event.orchestraSessions || [];
        const target = sessions.find(session => session.id === sessionId);
        if (!target) throw fail('Orchestra session no longer exists.');
        const venue = (event.venues || []).find(item => item.id === target.venue);
        if (!venue) throw fail('Orchestra venue no longer exists.');
        const capacitySnap = await transaction.get(db.collection('ticketCapacity').doc(capacityIdFor({ ...target, eventId })));
        const oldPaidBookings = !capacitySnap.exists ? await transaction.get(db.collection('publicBookings')
            .where('eventId', '==', eventId).where('venue', '==', target.venue)
            .where('date', '==', target.date).where('session', '==', target.time)) : null;
        const reservedPaid = capacitySnap.exists
            ? Object.values(capacitySnap.data().reservedByTier || {}).reduce((sum, count) => sum + Number(count), 0)
            : (oldPaidBookings?.docs || []).map(doc => doc.data()).filter(booking => isPaid(booking)
                || booking.paymentStatus === 'pending' || (booking.paymentStatus === 'failed' && booking.checkoutFailure?.cleanupStatus !== 'complete'))
                .reduce((sum, booking) => sum + ticketCount(booking), 0);
        const totalCapacity = (venue.seatConfig || []).reduce((sum, row) => sum + Number(row.seatCount || 0), 0);
        const quota = Number(target.complimentaryQuota || 0);
        if (!Number.isSafeInteger(quota) || quota < 0 || quota + reservedPaid > totalCapacity) throw fail('Session quota and paid reservations exceed the venue capacity. Review Orchestra Settings.');
        const old = group.assignment;
        if (old?.notificationLease?.expiresAt > Date.now()) throw fail('Assignment emails are being sent. Please retry shortly.');
        const oldSession = old && sessions.find(session => session.id === old.sessionId);
        if (old && (!oldSession || Number(oldSession.freeSeatingAssigned || 0) < old.quantity)) {
            throw fail('Previous session attendance counter needs reconciliation.');
        }
        const assigned = Number(target.freeSeatingAssigned || 0) - (old?.sessionId === sessionId ? old.quantity : 0) + group.quantity;
        if (assigned + Number(target.complimentaryClaimed || 0) > Number(target.complimentaryQuota || 0)) {
            throw fail('The whole group exceeds this session’s remaining performance quota. Choose another session or increase its capacity safely.');
        }
        const bookingIds = group.bookings.map(booking => booking.id).sort();
        const unchanged = old && old.sessionId === sessionId && old.quantity === group.quantity
            && JSON.stringify(old.bookingIds) === JSON.stringify(bookingIds)
            && old.venueName === (venue.label || venue.id) && old.date === target.date && old.time === target.time;
        if (unchanged) return { ...group, assignment: old };
        const assignment = {
            eventId, registrantId, sessionId, venue: venue.id, venueName: venue.label || venue.id,
            date: target.date, time: target.time, quantity: group.quantity,
            performerCount: group.performerCount, paidTicketCount: group.paidTicketCount,
            publicTicketCount: group.publicTicketCount, winnerTicketCount: group.winnerTicketCount,
            bookingIds, revision: Number(old?.revision || 0) + 1, notifiedBookingIds: [],
            assignedBy: actor.email, assignedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        const updatedSessions = sessions.map(session => {
            let count = Number(session.freeSeatingAssigned || 0);
            if (old?.sessionId === session.id) count -= old.quantity;
            if (session.id === sessionId) count += group.quantity;
            return { ...session, freeSeatingAssigned: count };
        });
        transaction.update(eventRef, { orchestraSessions: updatedSessions });
        transaction.set(db.collection('orchestraAssignments').doc(group.id), assignment);
        return { ...group, assignment };
    });
}

async function markNotified(groupId, revision, bookingId, token) {
    return db.runTransaction(async transaction => {
        const ref = db.collection('orchestraAssignments').doc(groupId);
        const snap = await transaction.get(ref);
        if (!snap.exists || snap.data().revision !== revision || (token && snap.data().notificationLease?.token !== token)) return;
        transaction.update(ref, { notificationLease: null, notifiedBookingIds: [...new Set([...(snap.data().notifiedBookingIds || []), bookingId])] });
    });
}

async function saveSession({ eventId, session, deleteSessionId }) {
    if (!validateKey(eventId)) throw fail('Event is required.');
    return db.runTransaction(async transaction => {
        const eventRef = db.collection('events').doc(eventId);
        const eventSnap = await transaction.get(eventRef);
        if (!eventSnap.exists) throw fail('Event no longer exists.');
        const event = eventSnap.data();
        const sessions = event.orchestraSessions || [];
        const id = deleteSessionId || session?.id || db.collection('orchestraAssignments').doc().id;
        if (!validateKey(id)) throw fail('Invalid session.');
        const old = sessions.find(item => item.id === id);
        const activeBookings = old ? await transaction.get(db.collection('publicBookings').where('eventId', '==', eventId)
            .where('venue', '==', old.venue).where('date', '==', old.date).where('session', '==', old.time)) : { docs: [] };
        const retained = activeBookings.docs.map(doc => doc.data()).filter(booking =>
            isPaid(booking) || booking.paymentStatus === 'pending' || (booking.paymentStatus === 'failed' && booking.checkoutFailure?.cleanupStatus !== 'complete'));
        const hasAttendance = Number(old?.freeSeatingAssigned || 0) > 0 || Number(old?.complimentaryClaimed || 0) > 0;
        if (deleteSessionId) {
            if (!old) throw fail('Session no longer exists.');
            if (hasAttendance || retained.length) throw fail('A session with active bookings or attendance cannot be deleted.');
            transaction.update(eventRef, { orchestraSessions: sessions.filter(item => item.id !== id) });
            return;
        }
        const venue = (event.venues || []).find(item => item.id === session?.venue);
        if (!venue || !(venue.sessions?.[session.date] || []).includes(session.time)) throw fail('Choose a configured venue date and time.');
        if (sessions.some(item => item.id !== id && item.venue === session.venue && item.date === session.date && item.time === session.time)) throw fail('This orchestra slot already exists.');
        if ((event.masterclassSessions || []).some(item => item.venue === session.venue && item.date === session.date && item.time === session.time)) throw fail('This slot belongs to a legacy Masterclass.');
        const changedSlot = !old || old.venue !== session.venue || old.date !== session.date || old.time !== session.time;
        if (old && changedSlot && (retained.length || hasAttendance)) throw fail('A session with active attendance cannot move to a different venue or time.');
        const assignments = await transaction.get(db.collection('sessionAssignments').doc(eventId));
        if ((assignments.data()?.assignments?.[`${session.venue}_${session.date}_${session.time}`] || []).length) throw fail('This slot has assigned competition performers.');
        const slotBookings = changedSlot ? await transaction.get(db.collection('publicBookings').where('eventId', '==', eventId)
            .where('venue', '==', session.venue).where('date', '==', session.date).where('session', '==', session.time)) : null;
        if (slotBookings?.docs.some(doc => isPaid(doc.data()) || doc.data().paymentStatus === 'pending'
            || (doc.data().paymentStatus === 'failed' && doc.data().checkoutFailure?.cleanupStatus !== 'complete'))) throw fail('This slot already has active bookings.');
        const quota = Number(session.complimentaryQuota);
        const totalCapacity = (venue.seatConfig || []).reduce((sum, row) => sum + Number(row.seatCount || 0), 0);
        const paidCount = retained.reduce((sum, booking) => sum + ticketCount(booking), 0);
        if (!Number.isSafeInteger(quota) || quota < Number(old?.freeSeatingAssigned || 0) + Number(old?.complimentaryClaimed || 0)
            || quota + paidCount > totalCapacity) throw fail('Performance quota must cover assigned attendance and fit alongside paid tickets within the venue capacity.');
        // Read the same ledger used by checkout, so concurrent reservations conflict.
        const capacitySnap = await transaction.get(db.collection('ticketCapacity').doc(capacityIdFor({ ...session, eventId })));
        const reservedPaid = capacitySnap.exists ? Object.values(capacitySnap.data().reservedByTier || {}).reduce((sum, count) => sum + Number(count), 0) : paidCount;
        if (quota + reservedPaid > totalCapacity) throw fail('Performance quota would exceed venue capacity with current paid reservations.');
        const updated = { ...old, id, venue: session.venue, date: session.date, time: session.time,
            complimentaryQuota: quota, complimentaryClaimed: Number(old?.complimentaryClaimed || 0),
            freeSeatingAssigned: Number(old?.freeSeatingAssigned || 0), seatingMode: 'free' };
        transaction.update(eventRef, { orchestraSessions: old ? sessions.map(item => item.id === id ? updated : item) : [...sessions, updated] });
        return updated;
    });
}
async function claimNotification(groupId, revision, bookingId) {
    const token = db.collection('orchestraAssignments').doc().id;
    return db.runTransaction(async transaction => {
        const ref = db.collection('orchestraAssignments').doc(groupId);
        const snap = await transaction.get(ref);
        if (!snap.exists || snap.data().revision !== revision || (snap.data().notifiedBookingIds || []).includes(bookingId)) return null;
        if (snap.data().notificationLease?.expiresAt > Date.now()) throw fail('Assignment emails are already being sent. Please retry shortly.');
        transaction.update(ref, { notificationLease: { token, bookingId, expiresAt: Date.now() + 120000 } });
        return token;
    });
}
async function releaseNotification(groupId, token) {
    return db.runTransaction(async transaction => {
        const ref = db.collection('orchestraAssignments').doc(groupId);
        const snap = await transaction.get(ref);
        if (snap.exists && snap.data().notificationLease?.token === token) transaction.update(ref, { notificationLease: null });
    });
}
async function sessionOverview({ eventId }) {
    if (!validateKey(eventId)) throw fail('Event is required.');
    const eventSnap = await db.collection('events').doc(eventId).get();
    if (!eventSnap.exists) throw fail('Event no longer exists.');
    const event = eventSnap.data();
    const sessions = await Promise.all((event.orchestraSessions || []).map(async session => {
        const bookings = await db.collection('publicBookings').where('eventId', '==', eventId)
            .where('venue', '==', session.venue).where('date', '==', session.date).where('session', '==', session.time).get();
        const paidPublicCount = bookings.docs.map(doc => doc.data()).filter(isPaid).reduce((sum, booking) => sum + ticketCount(booking), 0);
        const heldPublicCount = bookings.docs.map(doc => doc.data()).filter(booking => booking.paymentStatus === 'pending'
            || (booking.paymentStatus === 'failed' && booking.checkoutFailure?.cleanupStatus !== 'complete'))
            .reduce((sum, booking) => sum + ticketCount(booking), 0);
        const assignedWinnerCount = Number(session.freeSeatingAssigned || 0);
        return { ...session, paidPublicCount, heldPublicCount, confirmedAttendance: paidPublicCount + assignedWinnerCount };
    }));
    return { ...event, orchestraSessions: sessions };
}
module.exports = { sessionOverview, claimNotification, releaseNotification, readGroup, listGroups, assignGroup, markNotified, saveSession, idFor, ticketCount };
