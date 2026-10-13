const { AppError } = require('../middlewares/ErrorHandlerMiddleware');

const fail = message => new AppError(message, 409);
const isPaid = booking => ['PAID', 'paid'].includes(booking.paymentStatus);
const validateKey = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('/');
const redemptionId = (eventId, bookingId, channel, registrantId) =>
    encodeURIComponent(JSON.stringify([eventId, channel, channel === 'performers' ? registrantId : bookingId]));
const sessionKey = session => session ? JSON.stringify([session.venue, session.date, session.time]) : '';
const count = value => Number.isSafeInteger(value) && value >= 0;
const total = quantities => Object.values(quantities).reduce((sum, quantity) => sum + quantity, 0);

function ticketBuckets(booking) {
    const buckets = {};
    for (const ticket of booking.tickets || []) {
        const id = String(ticket.id || '').toLowerCase();
        if (['masterclass', 'master_class'].includes(id)) continue;
        if (!['presto', 'allegro', 'lento'].includes(id) || !count(ticket.quantity)) {
            throw fail('This booking has invalid ticket quantities or categories. Please reconcile it in Public Customers.');
        }
        if (ticket.quantity) buckets[id] = (buckets[id] || 0) + ticket.quantity;
    }
    if (!count(total(buckets))) throw fail('Invalid total ticket quantity.');
    return buckets;
}

function allowancesFor(booking, event, assignment) {
    const main = { venue: booking.venue, venueName: booking.venueName ||
        (event.venues || []).find(venue => venue.id === booking.venue)?.label || booking.venue,
    date: booking.date, time: booking.session };
    const directOrchestra = booking.bookingType === 'public_orchestra' || booking.isOrchestra === true || booking.seatingMode === 'free';
    const mainIsOrchestra = (event.orchestraSessions || []).some(session => sessionKey(session) === sessionKey(main));
    const performanceExists = (event.venues || []).some(venue => venue.id === main.venue &&
        (venue.sessions?.[main.date] || []).includes(main.time));
    const paidReason = isPaid(booking) ? null : 'Payment is not confirmed. Verify payment in Public Customers first.';
    const tickets = ticketBuckets(booking);
    const make = (channel, quantities, session, reason) => ({
        id: redemptionId(booking.eventId, booking.id, channel, booking.registrantId), channel, quantities,
        session, sessionKey: sessionKey(session), blockedReason: paidReason || reason || null,
    });
    const allowances = [];
    if (!booking.isMasterclass && total(tickets)) {
        allowances.push(make(directOrchestra ? 'orchestra' : 'performance', tickets, main,
            directOrchestra ? (!mainIsOrchestra ? 'The purchased orchestra session needs review.' : null)
                : (!performanceExists || mainIsOrchestra ? 'The purchased performance session needs review.' : null)));
    }
    if (!directOrchestra && booking.ticketingVersion === 2 && booking.orchestraAttendanceTickets > 0) {
        if (!count(booking.orchestraAttendanceTickets) || booking.orchestraAttendanceTickets !== total(tickets)) {
            throw fail('The saved orchestra entitlement needs reconciliation.');
        }
        const covered = assignment?.eventId === booking.eventId && assignment.registrantId === booking.registrantId
            && (assignment.bookingIds || []).includes(booking.id);
        const session = covered ? (event.orchestraSessions || []).find(item => item.id === assignment.sessionId &&
            sessionKey(item) === sessionKey(assignment)) : null;
        const resolved = session ? { ...session, venueName: assignment.venueName || main.venueName } : null;
        const reason = !covered || !resolved ? 'Awaiting orchestra assignment. Save this booking in Orchestra Assignments first.' : null;
        allowances.push(make('orchestra', { orchestra: booking.orchestraAttendanceTickets }, resolved, reason));
        if (covered && count(assignment.performerCount) && assignment.performerCount > 0) {
            allowances.push(make('performers', { performers: assignment.performerCount }, resolved, reason));
        }
    } else if (!directOrchestra && booking.ticketingVersion !== 2 && Number(booking.complimentaryTickets || 0) > 0) {
        if (!count(booking.complimentaryTickets)) throw fail('The historical orchestra entitlement needs reconciliation.');
        const session = (event.orchestraSessions || []).find(item => item.id === booking.orchestraSessionId);
        allowances.push(make('orchestra', { orchestra: booking.complimentaryTickets }, session || null,
            session ? null : 'The historical orchestra assignment needs review.'));
    }
    return allowances;
}

function withState(allowance, state) {
    const redeemed = state?.redeemed || {};
    let blockedReason = allowance.blockedReason;
    if (Object.entries(redeemed).some(([tier, quantity]) => !count(quantity) || quantity > (allowance.quantities[tier] || 0)) ||
        (state && (!count(state.revision) || (total(redeemed) > 0 && state.sessionKey !== allowance.sessionKey)))) {
        blockedReason = 'The saved redemption and entitlement differ. Please review the claim history before continuing.';
    }
    return { ...allowance, redeemed, revision: state?.revision || 0, blockedReason,
        remaining: Object.fromEntries(Object.entries(allowance.quantities).map(([tier, quantity]) =>
            [tier, Math.max(0, quantity - (redeemed[tier] || 0))])) };
}

module.exports = { fail, isPaid, validateKey, redemptionId, sessionKey, count, total, ticketBuckets, allowancesFor, withState };
