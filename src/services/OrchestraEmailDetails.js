const { getTemplate } = require('./EmailTemplateService');

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const ticketCount = booking => (booking.tickets || []).reduce((sum, ticket) => sum + Number(ticket.quantity || 0), 0);
function attendanceHtml(booking, assignment, { includeCompetition = true } = {}) {
    if (booking.ticketingVersion !== 2) return '';
    if (booking.seatingMode === 'free') return '<p><strong>Free seating within your Presto or Allegro category. No numbered seat selection.</strong></p>';
    const unassigned = Math.max(0, ticketCount(booking) - (booking.selectedSeatIds || []).length);
    const competition = includeCompetition && unassigned ? `<p>${unassigned} competition ticket(s) awaiting seat assignment.</p>` : '';
    if (!booking.registrantId || !booking.orchestraAttendanceTickets) return competition;
    if (!assignment || !(assignment.bookingIds || []).includes(booking.id)) return competition + '<p><strong>Orchestra &amp; Awarding Seating</strong></p><p><strong>Seating</strong>: Free Seating · Redeem your orchestra ticket at the venue.</p><p>The orchestra and awarding session assignments, including the venue, date, and time, are sent via email on <strong>19 October 2026</strong>.</p>';
    return competition + `<h3>Orchestra — Free seating</h3><p><strong>${escapeHtml(assignment.venueName)}</strong><br>${escapeHtml(assignment.date)} | ${escapeHtml(assignment.time)} WIB</p><p>Your booking includes <strong>${ticketCount(booking)} orchestra place(s)</strong>. This performance group has ${assignment.paidTicketCount} ticket places${assignment.performerCount ? ` + ${assignment.performerCount} performer places` : ''} = <strong>${assignment.quantity} attendees</strong>. Performer places are counted once only when a winner purchase exists; public bookings add no performer places.</p>`;
}
function assignmentEmail(booking, assignment) {
    const quantities = { presto: 0, allegro: 0 };
    for (const ticket of booking.tickets || []) {
        const category = String(ticket.id || ticket.name || 'orchestra').toLowerCase();
        quantities[category] = (quantities[category] || 0) + Number(ticket.quantity || 0);
    }
    const ticketRows = Object.entries(quantities)
        .map(([category, quantity]) => `<li>${escapeHtml(category.toUpperCase())}: ${quantity} tickets — Free Seating</li>`).join('');
    const savedDate = String(assignment.date || '');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(savedDate) ? new Date(`${savedDate}T00:00:00Z`) : null;
    const formattedDate = date && !Number.isNaN(date.getTime())
        ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
        : savedDate;
    const formattedTime = String(assignment.time || '').replace(/^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/, '$1–$2');
    const eventYear = /^APCS(\d{4})$/.exec(assignment.eventId || booking.eventId || '')?.[1] || '2026';
    const performerRedemption = assignment.performerCount > 0
        ? ' The performer’s complimentary ticket can also be redeemed at the same time.' : '';
    const assignmentDetails = `<p>Dear ${escapeHtml(booking.buyerName || booking.userName)},</p>
        <p>Your booking for the <strong>APCS ${eventYear} Orchestra &amp; Awarding Session</strong> is confirmed!</p>
        <p><strong>Booking ID:</strong> ${escapeHtml(booking.id)}<br>
        <strong>Winning Performer:</strong> ${escapeHtml(booking.registrantName)}</p>
        <p><strong>Session Details</strong></p>
        <ul><li><strong>Date</strong>: ${escapeHtml(formattedDate)}</li>
        <li><strong>Time</strong>: ${escapeHtml(formattedTime)}</li>
        <li><strong>Venue</strong>: ${escapeHtml(assignment.venueName)}</li></ul>
        <p><strong>Your Complimentary Tickets</strong></p>
        <ul>${ticketRows}</ul>
        <p>Please present your booking ID at the counter to redeem your tickets.${performerRedemption}</p>
        <p>Seating is on a first-come, first-served basis according to ticket category.</p>
        <p>We look forward to seeing you! ✨</p>
        <p>Warm regards,<br><strong>APCS Music Team</strong></p>`;
    return getTemplate('orchestraAssignment', { assignmentDetails });
}
module.exports = { escapeHtml, attendanceHtml, assignmentEmail };
