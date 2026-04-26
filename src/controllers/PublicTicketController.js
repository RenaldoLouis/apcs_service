const PublicTicketService = require('../services/PublicTicketService');
const emailService = require('../services/EmailService');
const { logger } = require('../utils/Logger');
const nodemailer = require('nodemailer');
const { smtpConfig } = require('../configs/emailConfig');

const transporter = nodemailer.createTransport(smtpConfig);

/** GET /api/v1/apcs/public-ticket/event-data */
async function getPublicTicketEventData(req, res, next) {
    try {
        const data = await PublicTicketService.getPublicTicketEventData();
        res.status(200).json(data);
    } catch (err) {
        next(err);
    }
}

/** POST /api/v1/apcs/public-ticket/booking */
async function createPublicTicketBooking(req, res, next) {
    try {
        const data = await PublicTicketService.createPublicTicketBooking(req);
        // data = { bookingId, paymentUrl, lockExpiresAt }

        // Send "seats locked" holding email
        try {
            await sendSeatHoldEmail({
                to: req.body.userEmail,
                name: req.body.userName,
                venue: req.body.venue,
                date: req.body.date,
                session: req.body.session,
                paymentUrl: data.paymentUrl,
                lockExpiresAt: data.lockExpiresAt,
                totalAmount: req.body.totalAmount, // display only; server re-calculated
            });
        } catch (emailErr) {
            // Non-fatal: don't fail the booking if email fails
            logger.error(`Seat-hold email failed for ${req.body.userEmail}: ${emailErr.message}`);
        }

        res.status(201).json(data);
    } catch (err) {
        next(err);
    }
}

/** POST /api/v1/apcs/public-ticket/webhook — Paper.id calls this on payment success */
async function handlePublicTicketWebhook(req, res, next) {
    try {
        const payload = req.body;
        logger.info('Public ticket webhook received: ' + JSON.stringify(payload));

        // Paper.id wraps in payload.data on production
        const payloadData = payload.data || payload;
        const isPaid = payloadData.invoice && payloadData.invoice.status?.toLowerCase() === 'paid';

        if (isPaid) {
            const bookingId = payloadData.invoice.number; // we set number = bookingId
            logger.info(`Processing paid public booking: ${bookingId}`);

            const bookingData = await PublicTicketService.handlePublicTicketWebhookPaid(bookingId, payloadData);

            // Send booking confirmation email
            try {
                await sendBookingConfirmationEmail(bookingData);
            } catch (emailErr) {
                logger.error(`Confirmation email failed for ${bookingData.userEmail}: ${emailErr.message}`);
            }
        } else {
            logger.info('Public ticket webhook: status is not paid, ignoring.');
        }

        // Always respond 200 so Paper.id doesn't retry
        res.status(200).json({ status: 'OK' });
    } catch (err) {
        logger.error(`Public ticket webhook error: ${err.message}`);
        res.status(200).json({ status: 'Error handled' });
    }
}

// ---------------------------------------------------------------------------
// Email helpers
// ---------------------------------------------------------------------------

const formatRupiah = (amount) =>
    new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);

const venueLabel = (venueId) => venueId === 'Venue1' ? 'Jatayu Hall' : 'Melati Hall';

/**
 * Sent immediately after "Pay Now" — seat is locked, waiting for payment.
 */
async function sendSeatHoldEmail({ to, name, venue, date, session, paymentUrl, lockExpiresAt }) {
    const deadline = new Date(lockExpiresAt).toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
        day: '2-digit', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    }) + ' WIB';

    const mailOptions = {
        from: '"APCS Music" <hello@apcsmusic.com>',
        to,
        subject: 'Your APCS 2026 Seat is Held – Complete Payment Within 30 Minutes',
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #0a0a0a; }
    .wrapper { width: 100%; background-color: #0a0a0a; padding: 32px 0; }
    .container { max-width: 600px; margin: 0 auto; background-color: #111111; border-radius: 12px; overflow: hidden; border: 1px solid #2a2a2a; }
    .header { background-color: #000; padding: 24px; text-align: center; }
    .header img { height: 48px; width: auto; }
    .body { padding: 36px 32px; color: #d4d4d4; font-size: 15px; line-height: 1.7; }
    .body p { margin: 0 0 16px; }
    .gold { color: #EBBC64; }
    .alert-box { background: #1a1500; border: 1px solid #EBBC64; border-radius: 8px; padding: 16px 20px; margin: 24px 0; }
    .alert-box p { margin: 0; color: #EBBC64; font-weight: 600; font-size: 14px; }
    .info-row { display: flex; margin-bottom: 8px; }
    .info-label { color: #888; min-width: 120px; font-size: 13px; }
    .info-value { color: #f0f0f0; font-size: 13px; font-weight: 600; }
    .cta-button { display: block; width: fit-content; margin: 28px auto; background: #EBBC64; color: #000; font-weight: 700; font-size: 16px; padding: 14px 40px; border-radius: 8px; text-decoration: none; text-align: center; }
    .footer { background: #000; padding: 20px; text-align: center; color: #555; font-size: 12px; }
    .footer a { color: #EBBC64; text-decoration: none; }
  </style>
</head>
<body>
<div class="wrapper">
  <div class="container">
    <div class="header">
      <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" alt="APCS Logo">
    </div>
    <div class="body">
      <p>Dear <strong class="gold">${name}</strong>,</p>
      <p>Your selected seat(s) are now <strong>temporarily reserved</strong> for you.</p>

      <div class="alert-box">
        <p>⏱ Complete your payment before <strong>${deadline}</strong>.<br>
        After this time, your seat reservation will be automatically released.</p>
      </div>

      <p><strong>Booking Details:</strong></p>
      <div class="info-row"><span class="info-label">Venue</span><span class="info-value">${venueLabel(venue)}</span></div>
      <div class="info-row"><span class="info-label">Date</span><span class="info-value">${date}</span></div>
      <div class="info-row"><span class="info-label">Session</span><span class="info-value">${session}</span></div>

      <a href="${paymentUrl}" class="cta-button">Complete Payment Now</a>

      <p style="color:#888; font-size:13px;">If the button doesn't work, copy and paste this link into your browser:<br>
      <a href="${paymentUrl}" style="color:#EBBC64; word-break:break-all;">${paymentUrl}</a></p>

      <p>If you did not initiate this booking, please ignore this email — your seats will be released automatically.</p>
      <p>Warm regards,<br><strong class="gold">The APCS Team</strong></p>
    </div>
    <div class="footer">
      <a href="https://www.apcsmusic.com">apcsmusic.com</a> &nbsp;|&nbsp;
      <a href="mailto:hello@apcsmusic.com">hello@apcsmusic.com</a><br>
      © ${new Date().getFullYear()} APCS Music. All rights reserved.
    </div>
  </div>
</div>
</body>
</html>`,
    };

    await transporter.sendMail(mailOptions);
    logger.info(`Seat-hold email sent to ${to}`);
}

/**
 * Sent after Paper.id webhook confirms payment — seats permanently reserved.
 */
async function sendBookingConfirmationEmail(bookingData) {
    const { userEmail, userName, venue, date, session, selectedSeatIds, tickets, totalAmount, id: bookingId } = bookingData;

    // Build a human-readable seat list (seat IDs contain the label, e.g. "presto-A1_APCS2026_...")
    const seatLabels = (selectedSeatIds || []).map(id => {
        const parts = id.split('_');
        return parts[0]; // e.g. "presto-A1"
    }).join(', ');

    const ticketSummary = (tickets || [])
        .filter(t => t.quantity > 0)
        .map(t => `${t.quantity}× ${t.name}`)
        .join(', ');

    const mailOptions = {
        from: '"APCS Music" <hello@apcsmusic.com>',
        to: userEmail,
        subject: 'Payment Confirmed — Your APCS 2026 Gala Concert Tickets',
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #0a0a0a; }
    .wrapper { width: 100%; background-color: #0a0a0a; padding: 32px 0; }
    .container { max-width: 600px; margin: 0 auto; background-color: #111111; border-radius: 12px; overflow: hidden; border: 1px solid #2a2a2a; }
    .header { background-color: #000; padding: 24px; text-align: center; }
    .header img { height: 48px; width: auto; }
    .body { padding: 36px 32px; color: #d4d4d4; font-size: 15px; line-height: 1.7; }
    .body p { margin: 0 0 16px; }
    .gold { color: #EBBC64; }
    .success-badge { background: #0a1f0a; border: 1px solid #22c55e; border-radius: 8px; padding: 12px 20px; margin: 0 0 24px; text-align: center; color: #22c55e; font-weight: 700; font-size: 15px; }
    .ticket-card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 8px; padding: 20px; margin: 16px 0; }
    .info-row { display: flex; margin-bottom: 8px; }
    .info-label { color: #888; min-width: 140px; font-size: 13px; }
    .info-value { color: #f0f0f0; font-size: 13px; font-weight: 600; }
    .divider { border: none; border-top: 1px solid #2a2a2a; margin: 20px 0; }
    .total-row { display: flex; justify-content: space-between; font-size: 16px; font-weight: 700; }
    .total-amount { color: #EBBC64; }
    .footer { background: #000; padding: 20px; text-align: center; color: #555; font-size: 12px; }
    .footer a { color: #EBBC64; text-decoration: none; }
  </style>
</head>
<body>
<div class="wrapper">
  <div class="container">
    <div class="header">
      <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" alt="APCS Logo">
    </div>
    <div class="body">
      <div class="success-badge">✓ Payment Confirmed</div>

      <p>Dear <strong class="gold">${userName}</strong>,</p>
      <p>Thank you! Your payment has been received and your seat(s) for the <strong>APCS 2026 Gala Concert</strong> are now <strong>permanently reserved</strong>.</p>

      <div class="ticket-card">
        <div class="info-row"><span class="info-label">Booking ID</span><span class="info-value">${bookingId}</span></div>
        <div class="info-row"><span class="info-label">Venue</span><span class="info-value">${venueLabel(venue)}</span></div>
        <div class="info-row"><span class="info-label">Date</span><span class="info-value">${date}</span></div>
        <div class="info-row"><span class="info-label">Session</span><span class="info-value">${session}</span></div>
        <div class="info-row"><span class="info-label">Tickets</span><span class="info-value">${ticketSummary}</span></div>
        ${seatLabels ? `<div class="info-row"><span class="info-label">Seats</span><span class="info-value">${seatLabels}</span></div>` : ''}
        <hr class="divider">
        <div class="total-row">
          <span>Total Paid</span>
          <span class="total-amount">${formatRupiah(totalAmount)}</span>
        </div>
      </div>

      <p>Please present this email or your Booking ID at the venue entrance. Our team will verify your booking.</p>
      <p>We look forward to seeing you at the concert!</p>
      <p>Warm regards,<br><strong class="gold">The APCS Team</strong></p>
    </div>
    <div class="footer">
      <a href="https://www.apcsmusic.com">apcsmusic.com</a> &nbsp;|&nbsp;
      <a href="mailto:hello@apcsmusic.com">hello@apcsmusic.com</a><br>
      © ${new Date().getFullYear()} APCS Music. All rights reserved.
    </div>
  </div>
</div>
</body>
</html>`,
    };

    await transporter.sendMail(mailOptions);
    logger.info(`Booking confirmation email sent to ${userEmail}`);
}

module.exports = {
    getPublicTicketEventData,
    createPublicTicketBooking,
    handlePublicTicketWebhook,
};
