const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const ticketCount = booking => (booking.tickets || []).reduce((sum, ticket) => sum + Number(ticket.quantity || 0), 0);
function attendanceHtml(booking, assignment, { includeCompetition = true } = {}) {
    if (booking.ticketingVersion !== 2) return '';
    if (booking.seatingMode === 'free') return '<p><strong>Free seating within your Presto/Allegro category. No numbered seat selection.</strong><br>Tempat duduk bebas dalam kategori tiket Anda, tanpa nomor kursi.</p>';
    const unassigned = Math.max(0, ticketCount(booking) - (booking.selectedSeatIds || []).length);
    const competition = includeCompetition && unassigned ? `<p>${unassigned} competition ticket(s) awaiting seat assignment. / Tiket pertunjukan menunggu penetapan kursi.</p>` : '';
    if (!booking.registrantId || !booking.orchestraAttendanceTickets) return competition;
    if (!assignment || !(assignment.bookingIds || []).includes(booking.id)) return competition + '<p><strong>Orchestra: free seating; session assignment pending.</strong> Our team will email the orchestra venue, date and time after assignment.<br>Orkestra: tempat duduk bebas; sesi menunggu penetapan. Detail tempat dan waktu akan dikirim melalui email.</p>';
    return competition + `<h3>Orchestra / Orkestra — Free seating</h3><p><strong>${escapeHtml(assignment.venueName)}</strong><br>${escapeHtml(assignment.date)} | ${escapeHtml(assignment.time)}</p><p>Your booking: ${ticketCount(booking)} purchased ticket(s). Whole winning performance: ${assignment.paidTicketCount} purchased tickets + ${assignment.performerCount} performer(s) = <strong>${assignment.quantity} attendees</strong>. Performer places are shared across the group and counted once per event.<br>Jumlah grup mencakup seluruh tiket lunas dan anggota penampil satu kali per acara.</p>`;
}
function assignmentEmail(booking, assignment) {
    return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto"><h2>APCS Orchestra Session Confirmed / Sesi Orkestra Ditetapkan</h2><p>Dear ${escapeHtml(booking.buyerName || booking.userName)},</p><p>Booking / Pesanan: <strong>${escapeHtml(booking.id)}</strong><br>Winning performance / Penampil: ${escapeHtml(booking.registrantName)}</p>${attendanceHtml(booking, assignment, { includeCompetition: false })}<p>Assignment reference / Referensi grup: ${escapeHtml(assignment.eventId)} / ${escapeHtml(assignment.registrantId)}. Please present your booking ID at entry. This email replaces earlier orchestra assignment details for this group.<br>Tunjukkan ID pesanan saat masuk. Email ini menggantikan detail penetapan sesi sebelumnya.</p></div>`;
}
module.exports = { escapeHtml, attendanceHtml, assignmentEmail };
