const { db, admin } = require('../configs/firebase-init');
const { logger } = require('../utils/Logger');
const jwt = require('jsonwebtoken');
const PaperRepository = require('./PaperRepository');
const { failPublicTicketBooking, expirePublicTicketBooking } = require('./PublicTicketFailureRepository');

const JWT_SECRET = process.env.JWT_SECRET;
const LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes in milliseconds
const SEAT_OWNERSHIP_COLLECTION = 'ticketSeatOwnership';
const CAPACITY_COLLECTION = 'ticketCapacity';
const WINNER_CLAIM_COLLECTION = 'winnerOrchestraClaims';

const normalizeSeatPart = value => String(value ?? '').trim().toUpperCase();
const safeDocumentId = value => encodeURIComponent(String(value ?? '')).replace(/%/g, '_');
const physicalSeatKey = (eventId, seat) => [
    eventId,
    normalizeSeatPart(seat.venueId),
    normalizeSeatPart(seat.sessionId),
    normalizeSeatPart(seat.row),
    String(seat.number ?? '').trim(),
].join('|');
const capacityDocumentId = (eventId, venue, date, session) => safeDocumentId(`${eventId}|${venue}|${date}|${session}|paid`);
const winnerClaimDocumentId = (eventId, registrantId, orchestraSessionId) =>
    safeDocumentId(`${eventId}|${registrantId}|${orchestraSessionId}`);
const isMasterclassTicketId = ticketId => ['masterclass', 'master_class'].includes(String(ticketId || '').toLowerCase());
const normalizedCheckoutFingerprint = ({
    eventId, registrantId, buyerName, userEmail, userPhone, venue, date, session,
    orchestraSessionId, tickets, selectedSeatIds, orchestraSelectedSeatIds, addOnIds,
}) => JSON.stringify({
    eventId,
    registrantId: registrantId || '',
    buyerName: String(buyerName || '').trim(),
    userEmail: String(userEmail || '').trim().toLowerCase(),
    userPhone: String(userPhone || '').trim(),
    venue,
    date,
    session,
    orchestraSessionId: orchestraSessionId || '',
    tickets: Object.entries(tickets || {}).sort(([left], [right]) => left.localeCompare(right)),
    selectedSeatIds: [...(selectedSeatIds || [])].sort(),
    orchestraSelectedSeatIds: [...(orchestraSelectedSeatIds || [])].sort(),
    addOnIds: [...(addOnIds || [])].sort(),
});

const getAuthoritativeSessionType = (eventData, venue, date, session) => {
    const matches = (eventData.orchestraSessions || []).filter(item =>
        item.venue === venue && item.date === date && item.time === session);
    if (matches.length) return { type: 'orchestra', session: matches[0] };
    const masterclass = (eventData.masterclassSessions || []).find(item =>
        item.venue === venue && item.date === date && item.time === session);
    if (masterclass) return { type: 'masterclass', session: masterclass };
    return { type: 'competition', session: null };
};

const getPaidCapacityByTier = (venue, orchestraSession) => {
    const reservedRows = new Set((orchestraSession?.reservedRows || []).map(normalizeSeatPart));
    return (venue?.seatConfig || []).reduce((counts, config) => {
        const tierId = String(config.areaType || '').toLowerCase();
        if (!tierId || reservedRows.has(normalizeSeatPart(config.row))) return counts;
        counts[tierId] = (counts[tierId] || 0) + Number(config.seatCount || 0);
        return counts;
    }, {});
};

const getCurrentEventId = async () => {
    const docRef = db.collection('systemSettings').doc('global');
    const docSnap = await docRef.get();
    if (!docSnap.exists || !docSnap.data().currentEventId) {
        throw new Error('Active event is not configured. Public ticket checkout is unavailable.');
    }
    return docSnap.data().currentEventId;
};

/**
 * Returns today's allowed award tiers from the date-based eligibility schedule.
 * If eligibility is disabled or no schedule entry matches today, returns null (all tiers allowed).
 */
const getTodayAllowedTiers = async () => {
    try {
        const docRef = db.collection('systemSettings').doc('global');
        const docSnap = await docRef.get();
        if (!docSnap.exists) return null;

        const data = docSnap.data();
        const eligibility = data.ticketEligibility;
        if (!eligibility || !eligibility.enabled) return null;

        const schedule = eligibility.schedule || [];
        if (schedule.length === 0) return [];

        // Get today's date in Asia/Jakarta timezone (YYYY-MM-DD)
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });

        const todayEntries = schedule.filter(entry => entry.date === today);
        if (todayEntries.length === 0) {
            return []; // No entry for today = none allowed if enabled
        }

        const allTiers = todayEntries.reduce((acc, entry) => {
            if (entry.allowedTiers) {
                acc.push(...entry.allowedTiers);
            }
            return acc;
        }, []);

        return [...new Set(allTiers)];
    } catch (err) {
        logger.error(`Error fetching ticket eligibility: ${err.message}`);
        throw new Error('Ticket sale eligibility settings could not be verified.');
    }
};

/**
 * Returns the events config document for the frontend to render
 * pricing tiers, sessions, and add-ons.
 */
const getPublicTicketEventData = async (_body, callback) => {
    try {
        const eventId = await getCurrentEventId();
        const docRef = db.collection('events').doc(eventId);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            throw new Error(`Event data for ${eventId} not found in events collection.`);
        }

        callback(null, { id: docSnap.id, ...docSnap.data() });
    } catch (error) {
        logger.error(`getPublicTicketEventData failed: ${error.message}`);
        callback(error);
    }
};

/**
 * Returns the seat layout for a specific venue and session.
 * Cleans up sensitive data and evaluates expired locks before returning.
 */
const getPublicTicketSeats = async (query, callback) => {
    try {
        const { venueId, sessionId } = query;
        if (!venueId || !sessionId) {
            return callback(new Error('venueId and sessionId are required.'));
        }

        const eventId = await getCurrentEventId();
        const seatsRef = db.collection(`seats${eventId}`);
        const q = seatsRef
            .where('venueId', '==', venueId)
            .where('sessionId', '==', sessionId);
        
        const snap = await q.get();
        const seats = snap.docs.map(doc => {
            const data = doc.data();
            
            // Clean up sensitive fields
            delete data.assignedTo;
            delete data.bookingId;
            delete data.lockedByBookingId;
            
            return { id: doc.id, ...data };
        });
        callback(null, seats);
    } catch (error) {
        logger.error(`getPublicTicketSeats failed: ${error.message}`);
        callback(error);
    }
};

/**
 * Creates a public ticket booking.
 * Steps:
 *  1. Server-side price recalculation (never trust client).
 *  2. Atomic Firestore transaction: check seats available → lock them → create booking doc.
 *  3. Call Paper.id to generate payment invoice.
 *  4. Send "seats locked" holding email to the user.
 * Returns { bookingId, paymentUrl }.
 */
const createPublicTicketBooking = async (body, callback) => {
    const {
        registrantName, buyerName, userEmail, userPhone,
        venue, date, session,
        orchestraSessionId,
        isOrchestra, isMasterclass,
        tickets,      // [{ id, name, quantity, priceEach }]
        selectedSeatIds, // [seatDocumentId, ...]
        orchestraSelectedSeatIds, // [seatDocumentId, ...]
        performanceSeatLabels, // ['L9', 'G9', ...]
        orchestraSeatLabels, // ['A1', 'A2', ...]
        addOnIds,     // ['merchandise', ...]
        registrantId, // ID of the winner who initiated this booking
        idempotencyKey,
    } = body;

    // --- 1. Basic validation ---
    if (!buyerName || !userEmail || !userPhone || !venue || !date || !session || !tickets) {
        return callback(new Error('Missing required booking fields.'));
    }

    let bookingRef;
    let invoiceId;
    let invoiceCreationAttempted = false;
    let response;

    try {
        let F_expected = 0;
        // --- 2. Fetch authoritative pricing from Firestore ---
        const eventId = await getCurrentEventId();
        const eventRef = db.collection('events').doc(eventId);
        const eventSnap = await eventRef.get();
        if (!eventSnap.exists) {
            throw new Error(`Event ${eventId} not found.`);
        }
        const eventData = eventSnap.data();
        const allowedTiers = await getTodayAllowedTiers();

        if (!registrantId && allowedTiers && !allowedTiers.includes('Public')) {
            throw new Error('Public ticket sales are closed today.');
        }
        if (registrantId) {
            const regDoc = await db.collection('Registrants2025').doc(registrantId).get();
            if (!regDoc.exists || regDoc.data().eventId !== eventId) {
                throw new Error('Registrant not found for this event.');
            }
            const award = regDoc.data().finalAward || '';
            if (!award || award === 'Fail' || award === 'N/A') {
                throw new Error('Registrant is not eligible for winner ticket benefits.');
            }
            if (allowedTiers && !allowedTiers.includes(award)) {
                throw new Error(`Registrants with ${award} award are not eligible to purchase tickets today.`);
            }
            const assignmentDoc = await db.collection('sessionAssignments').doc(eventId).get();
            const assignmentKey = `${venue}_${date}_${session}`;
            const assigned = assignmentDoc.exists
                && (assignmentDoc.data().assignments?.[assignmentKey] || []).some(entry => entry.registrantId === registrantId);
            if (!assigned) throw new Error('Registrant is not assigned to the selected competition session.');
        }

        // Build a quick lookup: tierId → price for the selected venue
        const tierPriceMap = {};
        (eventData.ticketTiers || []).forEach(t => { 
            tierPriceMap[t.id] = t.venuePrices?.[venue] ?? null; 
        });

        const addOnPriceMap = {};
        (eventData.addOns || []).forEach(a => { addOnPriceMap[a.id] = { price: a.price, name: a.name }; });

        const venueMap = {};
        (eventData.venues || []).forEach(v => { venueMap[v.id] = v.label || v.id; });
        const selectedVenue = (eventData.venues || []).find(item => item.id === venue);
        if (!selectedVenue || !(selectedVenue.sessions?.[date] || []).includes(session)) {
            throw new Error('Selected venue session is unavailable.');
        }
        const authoritativeSession = getAuthoritativeSessionType(eventData, venue, date, session);
        const isAuthoritativeMasterclass = authoritativeSession.type === 'masterclass';
        const isAuthoritativeOrchestra = authoritativeSession.type === 'orchestra';
        if (isMasterclass !== undefined && Boolean(isMasterclass) !== isAuthoritativeMasterclass) {
            throw new Error('Ticket product does not match the selected session.');
        }
        if (isOrchestra !== undefined && Boolean(isOrchestra) !== isAuthoritativeOrchestra) {
            throw new Error('Ticket product does not match the selected session.');
        }

        // --- 3. Recalculate total server-side ---
        let totalAmount = 0;
        const lineItems = [];

        // Verify expected seat count vs paid tickets
        const isWinner = !!registrantId;
        const hasSeatSelectionAddon = (addOnIds || []).includes('seat_selection');
        const totalSelected = (selectedSeatIds || []).length;
        const allSelectedIds = [...(selectedSeatIds || []), ...(orchestraSelectedSeatIds || [])];
        if (new Set(allSelectedIds).size !== allSelectedIds.length) {
            throw new Error('A physical seat can only be selected once per booking.');
        }
        
        let osIndex = -1;
        if (isWinner) {
            osIndex = (eventData.orchestraSessions || []).findIndex(s => s.id === orchestraSessionId);
            if (osIndex === -1) throw new Error('Selected orchestra session is unavailable.');
        } else if ((orchestraSelectedSeatIds || []).length > 0 || orchestraSessionId) {
            throw new Error('Complimentary orchestra seats require an eligible winner.');
        }
        
        const ticketsQty = tickets.reduce((acc, t) => acc + (t.quantity > 0 ? t.quantity : 0), 0);
        const ticketQuantities = tickets.reduce((acc, ticket) => {
            if (!Number.isInteger(ticket.quantity) || ticket.quantity <= 0) {
                throw new Error('Ticket quantities must be positive whole numbers.');
            }
            const tierId = String(ticket.id || '').toLowerCase();
            acc[tierId] = (acc[tierId] || 0) + ticket.quantity;
            return acc;
        }, {});
        if (!ticketsQty) throw new Error('At least one ticket is required.');
        const containsMasterclassTicket = Object.keys(ticketQuantities).some(isMasterclassTicketId);
        if (isAuthoritativeMasterclass !== containsMasterclassTicket
            || (isAuthoritativeMasterclass && Object.keys(ticketQuantities).some(id => !isMasterclassTicketId(id)))) {
            throw new Error('Ticket tier does not match the selected session type.');
        }
        const unknownAddOn = (addOnIds || []).find(addOnId => !addOnPriceMap[addOnId]);
        if (unknownAddOn) throw new Error(`Unknown add-on: ${unknownAddOn}`);
        if (isAuthoritativeMasterclass && ((selectedSeatIds || []).length || (orchestraSelectedSeatIds || []).length || (addOnIds || []).length)) {
            throw new Error('Masterclass tickets cannot include seat selections or add-ons.');
        }
        const seatSelectionPerformerCount = (addOnIds || []).filter(id => id === 'seat_selection_performer').length;
        
        if (totalSelected > ticketsQty) {
            throw new Error(`Ticket quantity mismatch. You cannot select more seats (${totalSelected}) than paid tickets (${ticketsQty}).`);
        }
        if (totalSelected > seatSelectionPerformerCount) {
             throw new Error(`Seat selection mismatch. You selected ${totalSelected} seats, but your seat_selection_performer add-on only covers ${seatSelectionPerformerCount} seats.`);
        }
        
        F_expected = 0;
        if (!hasSeatSelectionAddon && (orchestraSelectedSeatIds || []).length > 0) {
            throw new Error('Complimentary orchestra seat selection requires the seat_selection add-on.');
        }

        tickets.forEach(ticket => {
            if (ticket.quantity > 0) {
                const price = tierPriceMap[ticket.id];
                if (price === undefined) throw new Error(`Unknown ticket tier: ${ticket.id}`);
                if (price === null) throw new Error(`Pricing not configured for tier ${ticket.id} at venue ${venueMap[venue] || venue}`);
                const subtotal = price * ticket.quantity;
                totalAmount += subtotal;
                lineItems.push({
                    name: `${ticket.name} Ticket`,
                    description: `${ticket.quantity}x ${ticket.name} – ${venueMap[venue] || venue} | ${date} ${session}`,
                    price: subtotal,
                    currency: 'IDR',
                });
            }
        });
        
        if (hasSeatSelectionAddon && F_expected > 0) {
            lineItems.push({
                name: `Complimentary Tickets Discount`,
                description: `${F_expected}x Free Tickets`,
                price: 0,
                currency: 'IDR',
            });
        }

        (addOnIds || []).forEach(addOnId => {
            const addOn = addOnPriceMap[addOnId];
            if (addOn) {
                totalAmount += addOn.price;
                lineItems.push({
                    name: addOn.name,
                    description: 'Add-on',
                    price: addOn.price,
                    currency: 'IDR',
                });
            }
        });

        const freeMasterclassCount = ticketQuantities.presto || 0;
        if (freeMasterclassCount > 0) {
            lineItems.push({
                name: `Free Master Class (Presto Benefit)`,
                description: `${freeMasterclassCount}x Free Master Class`,
                price: 0,
                currency: 'IDR',
            });
        }

        // --- 4. Atomic Firestore transaction: lock seats + create booking ---
        bookingRef = db.collection('publicBookings').doc();
        const bookingId = bookingRef.id;
        const lockedAt = admin.firestore.FieldValue.serverTimestamp();
        const lockExpiresAt = new Date(Date.now() + LOCK_DURATION_MS);
        const normalizedIdempotencyKey = String(idempotencyKey || '').trim();
        if (normalizedIdempotencyKey.length > 200) throw new Error('Invalid checkout idempotency key.');
        const idempotencyRef = normalizedIdempotencyKey
            ? db.collection('ticketCheckoutKeys').doc(safeDocumentId(`${eventId}|${normalizedIdempotencyKey}`))
            : null;
        const capacityRef = !isAuthoritativeMasterclass
            ? db.collection(CAPACITY_COLLECTION).doc(capacityDocumentId(eventId, venue, date, session))
            : null;
        const winnerClaimRef = isWinner
            ? db.collection(WINNER_CLAIM_COLLECTION).doc(winnerClaimDocumentId(eventId, registrantId, orchestraSessionId))
            : null;
        const checkoutFingerprint = normalizedCheckoutFingerprint({
            eventId, registrantId, buyerName, userEmail, userPhone, venue, date, session,
            orchestraSessionId, tickets: ticketQuantities, selectedSeatIds,
            orchestraSelectedSeatIds, addOnIds,
        });

        const transactionResult = await db.runTransaction(async (transaction) => {
            // --- READ PHASE ---
            const idempotencySnap = idempotencyRef ? await transaction.get(idempotencyRef) : null;
            if (idempotencySnap?.exists) {
                if (idempotencySnap.data().requestFingerprint !== checkoutFingerprint) {
                    throw new Error('Checkout idempotency key was already used for a different cart.');
                }
                const existingBookingId = idempotencySnap.data().bookingId;
                const existingBookingSnap = existingBookingId
                    ? await transaction.get(db.collection('publicBookings').doc(existingBookingId))
                    : null;
                if (existingBookingSnap?.exists) {
                    const existingBooking = existingBookingSnap.data();
                    if (['expired', 'failed'].includes(existingBooking.paymentStatus)) {
                        throw new Error(`Previous checkout attempt is ${existingBooking.paymentStatus}; start a new checkout attempt.`);
                    }
                    return {
                        existingBooking: true,
                        bookingId: existingBookingId,
                        paymentUrl: existingBooking.paymentStatus === 'pending'
                            ? existingBooking.paymentUrl || null : null,
                        paymentStatus: existingBooking.paymentStatus,
                        lockExpiresAt: existingBooking.lockExpiresAt?.toDate
                            ? existingBooking.lockExpiresAt.toDate().toISOString()
                            : existingBooking.lockExpiresAt || null,
                    };
                }
                throw new Error('Checkout idempotency record is incomplete and requires reconciliation.');
            }
            const currentEventDoc = await transaction.get(eventRef);
            const capacitySnap = capacityRef ? await transaction.get(capacityRef) : null;
            const winnerClaimSnap = winnerClaimRef ? await transaction.get(winnerClaimRef) : null;
            // Existing events may predate the transactional capacity record. Read historical bookings
            // only during that one-time migration; all later checkout requests use the counter record.
            const sessionBookingsSnap = capacityRef && !capacitySnap.exists
                ? await transaction.get(db.collection('publicBookings')
                    .where('eventId', '==', eventId)
                    .where('venue', '==', venue)
                    .where('date', '==', date)
                    .where('session', '==', session))
                : { docs: [] };

            const seatRefs = (selectedSeatIds && selectedSeatIds.length > 0)
                ? selectedSeatIds.map(id => db.collection(`seats${eventId}`).doc(id))
                : [];
            
            const orchRefs = (orchestraSelectedSeatIds && orchestraSelectedSeatIds.length > 0)
                ? orchestraSelectedSeatIds.map(id => db.collection(`seats${eventId}`).doc(id))
                : [];

            // Perform all remaining reads
            const allSeatRefs = [...seatRefs, ...orchRefs];
            let allSeatDocs = [];
            if (allSeatRefs.length > 0) {
                allSeatDocs = await transaction.getAll(...allSeatRefs);
            }
            const physicalKeys = allSeatDocs.map(seat => seat.exists ? physicalSeatKey(eventId, seat.data()) : null);
            if (physicalKeys.some(key => !key) || new Set(physicalKeys).size !== physicalKeys.length) {
                throw new Error('A physical seat can only be selected once per booking.');
            }
            const ownershipRefs = physicalKeys.map(key => db.collection(SEAT_OWNERSHIP_COLLECTION).doc(safeDocumentId(key)));
            const ownershipDocs = ownershipRefs.length ? await transaction.getAll(...ownershipRefs) : [];
            const physicalAliases = await Promise.all(allSeatDocs.map(seatDoc => {
                if (!seatDoc.exists) return Promise.resolve({ docs: [] });
                const seat = seatDoc.data();
                return transaction.get(db.collection(`seats${eventId}`)
                    .where('venueId', '==', seat.venueId)
                    .where('sessionId', '==', seat.sessionId)
                    .where('row', '==', seat.row)
                    .where('number', '==', seat.number));
            }));

            // --- VALIDATION & WRITE PREP PHASE ---
            
            const currentEventData = currentEventDoc.data();
            const currentVenue = (currentEventData.venues || []).find(item => item.id === venue);
            if (!currentVenue || !(currentVenue.sessions?.[date] || []).includes(session)) {
                throw new Error('Selected venue session is unavailable.');
            }
            const paidOrchestraSession = !isWinner && authoritativeSession.type === 'orchestra'
                ? authoritativeSession.session : null;
            const capacityCounts = getPaidCapacityByTier(currentVenue, paidOrchestraSession);
            const retainsCapacity = booking => booking.paymentStatus === 'pending'
                || booking.paymentStatus === 'PAID'
                || booking.paymentStatus === 'paid'
                || (booking.paymentStatus === 'failed' && booking.checkoutFailure?.cleanupStatus !== 'complete');
            const activeSessionBookings = sessionBookingsSnap.docs
                .map(doc => doc.data())
                .filter(booking => retainsCapacity(booking) && !booking.isMasterclass);
            const migratedReservedByTier = activeSessionBookings.reduce((counts, booking) => {
                (booking.tickets || []).forEach(ticket => {
                    const tierId = String(ticket.id || '').toLowerCase();
                    counts[tierId] = (counts[tierId] || 0) + Number(ticket.quantity || 0);
                });
                return counts;
            }, {});
            const reservedByTier = capacitySnap?.exists
                ? (capacitySnap.data().reservedByTier || {}) : migratedReservedByTier;
            if (!isAuthoritativeMasterclass) {
                Object.entries(ticketQuantities).forEach(([tierId, quantity]) => {
                    const capacity = capacityCounts[tierId] || 0;
                    if (quantity + (reservedByTier[tierId] || 0) > capacity) {
                        throw new Error(`Not enough ${tierId} capacity remains for this session.`);
                    }
                });
            }

            // 1. Validate complimentary quota and reserved-row capacity.
            if (isWinner && osIndex !== -1) {
                const currentOsIndex = (currentEventData.orchestraSessions || []).findIndex(item => item.id === orchestraSessionId);
                if (currentOsIndex === -1) throw new Error('Selected orchestra session is unavailable.');
                const currentSession = currentEventData.orchestraSessions[currentOsIndex];
                const claimed = Number(currentSession.complimentaryClaimed || 0);
                const personalWinnerBonus = winnerClaimSnap?.exists && winnerClaimSnap.data().active ? 0 : 1;
                const reservedRows = new Set((currentSession.reservedRows || []).map(row => String(row).toUpperCase()));
                const orchestraVenue = (currentEventData.venues || []).find(item => item.id === currentSession.venue);
                const reservedCapacity = (orchestraVenue?.seatConfig || []).reduce((total, config) =>
                    reservedRows.has(String(config.row).toUpperCase()) ? total + Number(config.seatCount || 0) : total, 0);
                if (!reservedRows.size) {
                    throw new Error('Complimentary orchestra seats require configured reserved rows.');
                }
                const remainingAllowance = Math.max(0, Math.min(
                    Number(currentSession.complimentaryQuota || 0) - claimed,
                    reservedCapacity - claimed,
                ));
                const perTicketAllowance = Math.min(ticketsQty, remainingAllowance);
                const awardedPersonalBonus = personalWinnerBonus && remainingAllowance > perTicketAllowance ? 1 : 0;
                const actualComplimentaryTickets = perTicketAllowance + awardedPersonalBonus;
                if (hasSeatSelectionAddon && actualComplimentaryTickets === 0) {
                    throw new Error('No complimentary orchestra seats remain; remove the seat-selection add-on and review the cart.');
                }
                if (hasSeatSelectionAddon && (orchestraSelectedSeatIds || []).length !== actualComplimentaryTickets) {
                    throw new Error(`Expected ${actualComplimentaryTickets} free orchestra seats to be selected for this purchase.`);
                }
                if (!hasSeatSelectionAddon && (orchestraSelectedSeatIds || []).length) {
                    throw new Error('Complimentary orchestra seat selection requires the seat_selection add-on.');
                }

                const updatedSessions = [...currentEventData.orchestraSessions];
                updatedSessions[currentOsIndex] = {
                    ...currentSession,
                    complimentaryClaimed: claimed + actualComplimentaryTickets,
                };
                transaction.update(eventRef, { orchestraSessions: updatedSessions });
                F_expected = actualComplimentaryTickets;
                if (awardedPersonalBonus) {
                    transaction.set(winnerClaimRef, {
                        eventId, registrantId, orchestraSessionId, bookingId,
                        active: true, createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    });
                }
            }

            // 2. Validate and Lock Seats
            const selectedByTier = {};
            const paidReservedRows = new Set((paidOrchestraSession?.reservedRows || [])
                .map(row => String(row).toUpperCase()));
            for (let i = 0; i < allSeatDocs.length; i++) {
                const seatDoc = allSeatDocs[i];
                if (!seatDoc.exists) {
                    throw new Error(`Seat ${seatDoc.id} does not exist.`);
                }
                const seatData = seatDoc.data();

                if (seatData.status !== 'available') {
                    throw new Error(`Seat ${seatData.seatLabel} is no longer available. Please go back and re-select.`);
                }
                const ownershipDoc = ownershipDocs[i];
                if (ownershipDoc?.exists && ownershipDoc.data().active !== false
                    && ownershipDoc.data().bookingId !== bookingId) {
                    throw new Error(`Physical seat ${seatData.seatLabel} is already held by another booking.`);
                }
                const occupiedAlias = (physicalAliases[i]?.docs || []).find(alias => alias.id !== seatDoc.id
                    && ['locked', 'booked', 'reserved'].includes(String(alias.data().status || '').toLowerCase())
                    && alias.data().lockedByBookingId !== bookingId && alias.data().bookingId !== bookingId);
                if (occupiedAlias) {
                    throw new Error(`Physical seat ${seatData.seatLabel} is already occupied by an existing seat record.`);
                }
                if (i < seatRefs.length) {
                    const tierId = String(seatData.areaType || '').toLowerCase();
                    selectedByTier[tierId] = (selectedByTier[tierId] || 0) + 1;
                    if (seatData.eventId !== eventId || seatData.venueId !== venue
                        || seatData.sessionId !== `${date}_${session}` || !ticketQuantities[tierId]
                        || selectedByTier[tierId] > ticketQuantities[tierId]) {
                        throw new Error('Selected seat does not match the purchased competition session and tier.');
                    }
                    if (paidReservedRows.has(String(seatData.row).toUpperCase())) {
                        throw new Error('Reserved orchestra rows are only available for complimentary winner seats.');
                    }
                } else {
                    const orchestraSession = currentEventData.orchestraSessions.find(item => item.id === orchestraSessionId);
                    const reservedRows = new Set((orchestraSession.reservedRows || []).map(row => String(row).toUpperCase()));
                    if (!isWinner || F_expected <= 0 || seatData.eventId !== eventId
                        || seatData.venueId !== orchestraSession.venue
                        || seatData.sessionId !== `${orchestraSession.date}_${orchestraSession.time}`
                        || !reservedRows.has(String(seatData.row).toUpperCase())) {
                        throw new Error('Selected orchestra seat is not an eligible complimentary reserved-row seat.');
                    }
                }
                
                transaction.update(seatDoc.ref, {
                    status: 'locked',
                    lockedAt: lockedAt,
                    lockedByBookingId: bookingId,
                });
                transaction.set(ownershipRefs[i], {
                    eventId, physicalSeatKey: physicalKeys[i], bookingId,
                    seatId: seatDoc.id, status: 'locked', active: true, updatedAt: lockedAt,
                });
            }

            if (capacityRef) {
                const updatedReservedByTier = { ...reservedByTier };
                Object.entries(ticketQuantities).forEach(([tierId, quantity]) => {
                    updatedReservedByTier[tierId] = Number(updatedReservedByTier[tierId] || 0) + quantity;
                });
                const capacityData = {
                    eventId, venue, date, session, pool: 'paid', capacityByTier: capacityCounts,
                    reservedByTier: updatedReservedByTier, updatedAt: lockedAt,
                };
                if (capacitySnap?.exists) transaction.update(capacityRef, capacityData);
                else transaction.set(capacityRef, capacityData);
            }

            // --- FINALIZE WRITE PHASE ---
            // Create the booking document
            transaction.set(bookingRef, {
                eventId: eventId,
                registrantId: registrantId || '',
                registrantName: registrantName || '',
                buyerName,
                userName: buyerName, // For backwards compatibility
                userEmail,
                userPhone,
                venue,
                date,
                session,
                orchestraSessionId: orchestraSessionId || '',
                isOrchestra: !!isOrchestra,
                isMasterclass: isAuthoritativeMasterclass,
                tickets,
                selectedSeatIds: selectedSeatIds || [],
                orchestraSelectedSeatIds: orchestraSelectedSeatIds || [],
                physicalSeatKeys: physicalKeys,
                performanceSeatLabels: performanceSeatLabels || [],
                orchestraSeatLabels: orchestraSeatLabels || [],
                addOnIds: addOnIds || [],
                freeMasterclassCount: freeMasterclassCount,
                totalAmount,
                paymentCurrency: 'IDR',
                complimentaryTickets: F_expected,
                personalWinnerBonus: isWinner ? Math.max(0, F_expected - ticketsQty) : 0,
                winnerClaimId: isWinner && F_expected > ticketsQty ? winnerClaimRef.id : '',
                capacityReservation: capacityRef ? { capacityId: capacityRef.id, byTier: ticketQuantities } : null,
                idempotencyKey: normalizedIdempotencyKey || null,
                paymentStatus: 'pending',
                seatsSelected: (selectedSeatIds || []).length > 0,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lockExpiresAt: lockExpiresAt,
            });
            if (idempotencyRef) transaction.set(idempotencyRef, {
                bookingId, eventId, requestFingerprint: checkoutFingerprint, createdAt: lockedAt,
            });
            return { existingBooking: false };
        });

        if (transactionResult.existingBooking) {
            response = transactionResult;
            return callback(null, response);
        }

        logger.info(`Public booking ${bookingId} created. Seats locked: ${(selectedSeatIds || []).join(', ')}`);

        // --- 5. Create Paper.id invoice ---
        // Format deadline string for display in invoice notes
        const deadlineStr = lockExpiresAt.toLocaleString('id-ID', {
            timeZone: 'Asia/Jakarta',
            day: '2-digit', month: 'long', year: 'numeric',
            hour: '2-digit', minute: '2-digit',
        }) + ' WIB (UTC+7)';

        const invoiceBody = {
            externalId: bookingId,
            user: {
                name: buyerName,
                email: userEmail,
                phone: userPhone.replace('+', ''),
            },
            items: lineItems,
            notes: `Buyer: ${buyerName}${registrantName ? ` | Paying for: ${registrantName}` : ''}\n\nPlease complete payment before ${deadlineStr}. After this local deadline, APCS will request invoice cancellation; seats remain held until Paper.id confirms payment or cancellation.`,
        };

        // Use PaperRepository directly (same pattern it already uses)
        invoiceCreationAttempted = true;
        const paperResult = await new Promise((resolve, reject) => {
            Promise.resolve(PaperRepository.createInvoice(invoiceBody, (err, result) => {
                invoiceId = result?.invoiceId || err?.invoiceId || invoiceId;
                if (err) reject(err);
                else resolve(result);
            })).catch(error => {
                invoiceId = error?.invoiceId || invoiceId;
                reject(error);
            });
        });
        // Store the invoiceId on the booking
        await bookingRef.update({
            invoiceId: paperResult.invoiceId,
            paymentUrl: paperResult.paymentUrl,
            invoiceCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // A local deadline requests cancellation; inventory remains locked until Paper confirms it.
        setTimeout(async () => {
            try {
                await expirePublicTicketBooking(bookingId);
            } catch (timeoutErr) {
                logger.error(`Error in expiry timeout for booking ${bookingId}: ${timeoutErr.message}`);
            }
        }, LOCK_DURATION_MS + 2000); // add 2s buffer to ensure it is fully expired

        response = {
            bookingId,
            paymentUrl: paperResult.paymentUrl,
            lockExpiresAt: lockExpiresAt.toISOString(),
        };

    } catch (error) {
        logger.error(`createPublicTicketBooking failed: ${error.message}`);

        // Failed transactions persist no booking, so this helper makes no changes.
        if (bookingRef) {
            try {
                await failPublicTicketBooking(bookingRef.id, {
                    reason: error.message,
                    invoiceId,
                    invoiceCreationAttempted,
                });
            } catch (cleanupError) {
                logger.error(`Checkout cleanup failed for booking ${bookingRef.id}: ${cleanupError.message}`);
            }
        }
        return callback(error);
    }
    // Outside the error boundary: a caller exception must not trigger rollback.
    return callback(null, response);
};

/**
 * Called by the Paper.id webhook when payment is confirmed (isPaid = true).
 * Upgrades seat status from 'locked' → 'reserved' and marks booking as PAID.
 * Returns the booking data for the caller to use when sending the confirmation email.
 */
const handlePublicTicketWebhookPaid = async (bookingId, payloadData) => {
    const bookingRef = db.collection('publicBookings').doc(bookingId);
    const bookingData = await db.runTransaction(async transaction => {
        const bookingSnap = await transaction.get(bookingRef);
        if (!bookingSnap.exists) throw new Error(`Public booking ${bookingId} not found.`);
        const booking = bookingSnap.data();
        if (booking.paymentStatus === 'failed') {
            throw new Error(`Booking ${bookingId} checkout failed; payment requires reconciliation.`);
        }
        const providerInvoiceId = payloadData?.invoice?.id;
        if (!providerInvoiceId || providerInvoiceId !== booking.invoiceId) {
            throw new Error(`Payment invoice does not match booking ${bookingId}.`);
        }
        const providerCurrency = payloadData?.invoice?.currency || payloadData?.invoice?.currency_code;
        if (providerCurrency && String(providerCurrency).toUpperCase() !== String(booking.paymentCurrency || 'IDR').toUpperCase()) {
            throw new Error(`Payment currency does not match booking ${bookingId}.`);
        }
        if (booking.paymentStatus === 'PAID' || booking.paymentStatus === 'paid') return booking;
        if (booking.paymentStatus === 'expired') throw new Error(`Booking ${bookingId} was canceled before payment confirmation.`);

        const amountPaid = Number(payloadData?.invoice?.total_amount);
        if (!Number.isFinite(amountPaid) || amountPaid !== Number(booking.totalAmount)) {
            throw new Error(`Payment amount does not match booking ${bookingId}.`);
        }

        const seatIds = [...new Set([...(booking.selectedSeatIds || []), ...(booking.orchestraSelectedSeatIds || [])])];
        const seatRefs = seatIds.map(seatId => db.collection(`seats${booking.eventId}`).doc(seatId));
        const seats = seatRefs.length ? await transaction.getAll(...seatRefs) : [];
        const ownershipRefs = (booking.physicalSeatKeys || []).map(key =>
            db.collection(SEAT_OWNERSHIP_COLLECTION).doc(safeDocumentId(key)));
        const ownershipDocs = ownershipRefs.length ? await transaction.getAll(...ownershipRefs) : [];
        for (const seat of seats) {
            if (!seat.exists || seat.data().status !== 'locked' || seat.data().lockedByBookingId !== bookingId) {
                throw new Error(`Booking ${bookingId} no longer owns every selected seat.`);
            }
        }

        for (const seat of seats) {
            transaction.update(seat.ref, {
                status: 'booked', bookingId,
                lockedAt: admin.firestore.FieldValue.delete(),
                lockedByBookingId: admin.firestore.FieldValue.delete(),
                assignedTo: {
                    userName: booking.userName || '', userEmail: booking.userEmail || '',
                    registrantName: booking.registrantName || '',
                },
            });
        }
        for (let i = 0; i < ownershipDocs.length; i++) {
            const ownership = ownershipDocs[i];
            if (!ownership.exists || ownership.data().bookingId !== bookingId) {
                throw new Error(`Booking ${bookingId} no longer owns every physical seat.`);
            }
            transaction.update(ownership.ref, {
                status: 'booked', active: true, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }
        transaction.update(bookingRef, {
            paymentStatus: 'PAID', paidAt: admin.firestore.FieldValue.serverTimestamp(),
            amountPaid, paymentDetails: payloadData,
        });
        return booking;
    });
    logger.info(`Booking ${bookingId} marked PAID. Seats permanently reserved.`);

    return { id: bookingId, ...bookingData };
};

/**
 * Returns the list of eligible winners who can purchase tickets today.
 * Joins sessionAssignments + Registrants2025 + systemSettings (date-based schedule).
 * Only returns registrants who:
 *   (a) are assigned to a session in SessionAssignmentManager
 *   (b) have a finalAward matching today's allowed tiers (or all if no schedule)
 */
const getEligibleWinners = async (_query, callback) => {
    try {
        const eventId = await getCurrentEventId();
        const allowedTiers = await getTodayAllowedTiers();

        // 1. Fetch session assignments
        const assignmentsDoc = await db.collection('sessionAssignments').doc(eventId).get();
        if (!assignmentsDoc.exists) {
            return callback(null, { winners: [], allowedTiers: allowedTiers || [], eligibilityEnabled: !!allowedTiers });
        }
        const assignmentsData = assignmentsDoc.data().assignments || {};

        // 2. Build a map of registrantId → session info from assignments
        //    Assignment shape: { [sessionId]: [ { registrantId, name, ... }, ... ] }
        const registrantSessionMap = {};
        Object.keys(assignmentsData).forEach(sessionId => {
            // Session ID format: "Venue_uuid_2026-07-01_09:00-10:00"
            const parts = sessionId.split('_');
            const time = parts.pop() || '';
            const date = parts.pop() || '';
            const venue = parts.join('_') || '';

            (assignmentsData[sessionId] || []).forEach(entry => {
                if (entry.registrantId) {
                    registrantSessionMap[entry.registrantId] = {
                        sessionId,
                        venue,
                        date,
                        time,
                    };
                }
            });
        });

        const assignedRegistrantIds = Object.keys(registrantSessionMap);
        if (assignedRegistrantIds.length === 0) {
            return callback(null, { winners: [], allowedTiers: allowedTiers || [], eligibilityEnabled: !!allowedTiers });
        }

        // 3. Fetch registrant docs (Firestore 'in' supports max 30 at a time)
        const winners = [];
        const batchSize = 30;
        for (let i = 0; i < assignedRegistrantIds.length; i += batchSize) {
            const batch = assignedRegistrantIds.slice(i, i + batchSize);
            const snap = await db.collection('Registrants2025')
                .where(admin.firestore.FieldPath.documentId(), 'in', batch)
                .get();

            snap.docs.forEach(doc => {
                const data = doc.data();
                const award = data.finalAward || '';

                // Filter by allowed tiers if eligibility is enabled
                if (allowedTiers && !allowedTiers.includes(award)) {
                    return; // skip
                }

                // Skip non-winners (Fail or N/A)
                if (!award || award === 'Fail' || award === 'N/A') {
                    return;
                }

                const performer = data.performers?.[0];
                const name = performer
                    ? (performer.fullName || `${performer.firstName || ''} ${performer.lastName || ''}`.trim())
                    : (data.name || 'Unknown');
                const email = performer?.email || data.email || '';

                winners.push({
                    registrantId: doc.id,
                    name,
                    email,
                    finalAward: award,
                    competitionCategory: data.competitionCategory || '',
                    teacherName: data.teacherName || '',
                    repertoireTitle: data.repertoireTitle || '',
                    session: registrantSessionMap[doc.id],
                });
            });
        }

        // Sort by name
        winners.sort((a, b) => a.name.localeCompare(b.name));
        const activeClaimsSnapshot = await db.collection(WINNER_CLAIM_COLLECTION)
            .where('eventId', '==', eventId)
            .where('active', '==', true)
            .get();
        const claimedSessionsByRegistrant = activeClaimsSnapshot.docs.reduce((claims, claimDoc) => {
            const claim = claimDoc.data();
            if (!claim.registrantId || !claim.orchestraSessionId) return claims;
            if (!claims[claim.registrantId]) claims[claim.registrantId] = [];
            claims[claim.registrantId].push(claim.orchestraSessionId);
            return claims;
        }, {});
        winners.forEach(winner => {
            winner.claimedOrchestraSessionIds = claimedSessionsByRegistrant[winner.registrantId] || [];
        });

        callback(null, {
            winners,
            allowedTiers: allowedTiers || [],
            eligibilityEnabled: !!allowedTiers,
        });
    } catch (error) {
        logger.error(`getEligibleWinners failed: ${error.message}`);
        callback(error);
    }
};

module.exports = {
    getPublicTicketEventData,
    createPublicTicketBooking,
    handlePublicTicketWebhookPaid,
    getPublicTicketSeats,
    getEligibleWinners,
};
