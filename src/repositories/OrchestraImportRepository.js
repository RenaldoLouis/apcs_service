const { db, admin } = require('../configs/firebase-init');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');
const { normalizeImport } = require('../services/OrchestraImportModel');
const { capacityDocumentId, getReservedCapacityByTier } = require('./PublicTicketRepository');

async function importPaidOrchestraBookings(input, actor) {
    if (!actor?.uid || !actor?.email) throw new AppError('Ticketing administrator is required.', 403);
    const rows = normalizeImport(input);
    return db.runTransaction(async transaction => {
        const eventSnap = await transaction.get(db.collection('events').doc(input.eventId));
        if (!eventSnap.exists) throw new AppError('Event was not found.', 404);
        const event = eventSnap.data();
        const sessions = new Map();
        for (const row of rows) {
            const matches = (event.orchestraSessions || []).filter(session => session.id === row.sessionId);
            const session = matches[0];
            const venue = (event.venues || []).find(item => item.id === session?.venue);
            if (matches.length !== 1 || !venue || !session.date || !session.time) {
                throw new AppError('An orchestra session is unavailable. Refresh and review the session mapping.', 409);
            }
            if (row.expectedSession.venue !== session.venue || row.expectedSession.date !== session.date
                || row.expectedSession.time !== session.time) {
                throw new AppError('The orchestra timetable changed. Reload the page and review the session mapping.', 409);
            }
            if (!(event.ticketTiers || []).some(tier => String(tier.id).toLowerCase() === row.category)) {
                throw new AppError(`The event has no ${row.category} ticket category.`, 409);
            }
            sessions.set(row.sessionId, { ...session, venueName: venue.label || venue.id });
        }
        const bookingRefs = rows.map(row => db.collection('publicBookings').doc(row.bookingId));
        const existing = await Promise.all(bookingRefs.map(ref => transaction.get(ref)));
        const freshRows = rows.filter((row, index) => {
            if (!existing[index].exists) return true;
            const saved = existing[index].data();
            if (saved.importSource !== 'paid_orchestra_excel' || saved.eventId !== input.eventId
                || saved.totalAmount !== row.totalPaid || saved.adminNote !== row.notes) {
                throw new AppError(`Imported booking ${row.bookingId} already exists with different details. Review it in Public Customers; no rows were imported.`, 409);
            }
            return false;
        });
        const capacity = new Map();
        // All reads precede writes. Reuse checkout's exact counter key and bootstrap predicate.
        for (const row of freshRows) {
            const session = sessions.get(row.sessionId);
            const id = capacityDocumentId(input.eventId, session.venue, session.date, session.time);
            if (!capacity.has(id)) {
                const ref = db.collection('ticketCapacity').doc(id);
                const snap = await transaction.get(ref);
                let reserved = snap.data()?.reservedByTier;
                if (!snap.exists) {
                    const bookings = await transaction.get(db.collection('publicBookings')
                        .where('eventId', '==', input.eventId).where('venue', '==', session.venue)
                        .where('date', '==', session.date).where('session', '==', session.time));
                    reserved = getReservedCapacityByTier(bookings.docs.map(doc => doc.data()));
                }
                if (!reserved || Array.isArray(reserved) || typeof reserved !== 'object'
                    || Object.values(reserved).some(value => !Number.isSafeInteger(value) || value < 0)) {
                    throw new AppError('The orchestra ticket counter needs review before importing.', 409);
                }
                capacity.set(id, { ref, exists: snap.exists, session, reserved: { ...reserved } });
            }
            const entry = capacity.get(id);
            entry.reserved[row.category] = (entry.reserved[row.category] || 0) + row.quantity;
            if (!Number.isSafeInteger(entry.reserved[row.category])) {
                throw new AppError('The orchestra ticket counter exceeds its supported range.', 409);
            }
        }
        const now = admin.firestore.FieldValue.serverTimestamp();
        for (const row of freshRows) {
            const session = sessions.get(row.sessionId);
            const capacityId = capacityDocumentId(input.eventId, session.venue, session.date, session.time);
            const tier = event.ticketTiers.find(item => String(item.id).toLowerCase() === row.category);
            transaction.set(db.collection('publicBookings').doc(row.bookingId), {
                eventId: input.eventId, ticketingVersion: 2, bookingType: 'public_orchestra', paymentMode: 'manual',
                seatingMode: 'free', isOrchestra: true, isMasterclass: false,
                buyerName: row.buyerName, userName: row.buyerName, userEmail: row.userEmail, userPhone: row.userPhone,
                venue: session.venue, venueName: session.venueName, date: session.date, session: session.time,
                orchestraSessionId: '', registrantId: '', registrantName: '', performerCount: 0,
                orchestraAttendanceTickets: 0, complimentaryTickets: 0, personalWinnerBonus: 0, freeMasterclassCount: 0,
                tickets: [{ id: row.category, name: tier.name || row.category, quantity: row.quantity, priceEach: row.totalPaid / row.quantity }],
                totalAmount: row.totalPaid, paymentCurrency: 'IDR', paymentStatus: 'PAID',
                selectedSeatIds: [], orchestraSelectedSeatIds: [], physicalSeatKeys: [], performanceSeatLabels: [], orchestraSeatLabels: [],
                addOnIds: [], seatsSelected: false, lockExpiresAt: null, emailSent: false,
                adminNote: row.notes, capacityReservation: { capacityId, byTier: { [row.category]: row.quantity } },
                importSource: 'paid_orchestra_excel',
                importAudit: { sessionId: row.sessionId, actorUid: actor.uid, actorEmail: actor.email, importedAt: now },
                createdAt: now, paidAt: now,
            });
        }
        for (const entry of capacity.values()) {
            const data = { eventId: input.eventId, venue: entry.session.venue, date: entry.session.date,
                session: entry.session.time, pool: 'paid', capacityByTier: null, capacityPolicy: 'staff_managed',
                reservedByTier: entry.reserved, updatedAt: now };
            if (entry.exists) transaction.update(entry.ref, data);
            else transaction.set(entry.ref, data);
        }
        return { imported: freshRows.length, skipped: rows.length - freshRows.length,
            bookingIds: rows.map(row => row.bookingId) };
    });
}

module.exports = { importPaidOrchestraBookings };
