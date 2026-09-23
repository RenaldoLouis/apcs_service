const { getTemplate } = require('./EmailTemplateService');

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const ticketCount = booking => (booking.tickets || []).reduce((sum, ticket) => sum + Number(ticket.quantity || 0), 0);
function attendanceHtml(booking, assignment, { includeCompetition = true } = {}) {
    if (booking.ticketingVersion !== 2) return '';
    if (booking.seatingMode === 'free') return '<p><strong>Free seating within your Presto or Allegro category. No numbered seat selection.</strong></p>';
    const unassigned = Math.max(0, ticketCount(booking) - (booking.selectedSeatIds || []).length);
    const competition = includeCompetition && unassigned ? `<p>${unassigned} competition ticket(s) awaiting seat assignment.</p>` : '';
    if (!booking.registrantId || !booking.orchestraAttendanceTickets) return competition;
    if (!assignment || !(assignment.bookingIds || []).includes(booking.id)) return competition + '<p><strong>Orchestra: free seating; session assignment pending.</strong> Our team will email the orchestra venue, date and time after assignment.</p>';
    return competition + `<h3>Orchestra — Free seating</h3><p><strong>${escapeHtml(assignment.venueName)}</strong><br>${escapeHtml(assignment.date)} | ${escapeHtml(assignment.time)}</p><p>Your booking includes <strong>${ticketCount(booking)} orchestra place(s)</strong>. This performance group has ${assignment.paidTicketCount} ticket places${assignment.performerCount ? ` + ${assignment.performerCount} performer places` : ''} = <strong>${assignment.quantity} attendees</strong>. Performer places are counted once only when a winner purchase exists; public bookings add no performer places.</p>`;
}
function assignmentEmail(booking, assignment) {
    const assignmentDetails = `<h2>APCS Orchestra Session Confirmed</h2><p>Dear ${escapeHtml(booking.buyerName || booking.userName)},</p><p>Booking: <strong>${escapeHtml(booking.id)}</strong><br>Winning performance: ${escapeHtml(booking.registrantName)}</p>${attendanceHtml(booking, assignment, { includeCompetition: false })}<p>Assignment reference: event ${escapeHtml(assignment.eventId)}, performance ${escapeHtml(assignment.registrantId)}. Please present your booking ID at entry. This email replaces earlier orchestra assignment details for this group.</p>`;
    return getTemplate('orchestraAssignment', { assignmentDetails });
}
module.exports = { escapeHtml, attendanceHtml, assignmentEmail };
