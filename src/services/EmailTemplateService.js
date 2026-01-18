const generateCommonHeader = () => `
    <div class="header">
        <div style="width: 100%; background: black;">
            <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" style="display: block; height: auto; border: 0; width: 50%; max-width: 400px; margin: 0 auto;" alt="APCS Logo">
        </div>
    </div>`;

const generateCommonFooter = () => `
    <div class="footer">
        <p>&copy; ${new Date().getFullYear()} APCS Music</p>
    </div>`;

const templates = {
    PAYMENT_REQUEST: (data) => ({
        subject: `Payment Instructions – ${data.eventName || 'APCS Music Competition'}`,
        html: `
            <!DOCTYPE html>
            <html>
            <head>...</head> <body>
                <div class="email-wrapper">
                    <div class="email-container">
                        ${generateCommonHeader()}
                        <div class="content">
                            <p>Dear <strong>${data.name}</strong>,</p>
                            <p>Thank you for registering. Please proceed with payment.</p>
                            <div class="payment-details">
                                <div><strong>Amount:</strong> ${data.price}</div>
                                </div>
                        </div>
                        ${generateCommonFooter()}
                    </div>
                </div>
            </body>
            </html>
        `
    }),
    SEAT_BOOKING: (data) => {
        // Logic for seat booking template
        return {
            subject: "Your APCS Booking Confirmation",
            html: `...html content...` // Refactor your existing HTML into here
        };
    },
    CERTIFICATE_FAIL: (data) => ({
        subject: 'APCS E-Certificate and E-Comment Sheets',
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                  <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; color:#333; }
                    .email-wrapper { width: 100%; background-color: #f4f4f4; padding: 20px 0; }
                    .email-container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; }
                    .header { line-height: 0; }
                    .content { padding: 30px; line-height: 1.6; text-align: justify; }
                    .content p { margin: 0 0 16px 0; }
                    .content strong { color: #333333; }
                    .footer { text-align: center; font-size: 12px; color: #7f8c8d; padding: 20px; }
                    .content, .content p, .content strong {
                        color: #333 !important;
                    }
                </style>
            </head>
              <body>
                    <div class="email-wrapper">
                        <div class="email-container">
                            ${generateCommonHeader()}
                            <div class="content">
                                <p>Dear <strong>${data.name}</strong>,</p>
                                <p>
                                   Thank you for your participation in APCS The Sound of Asia 2025.
                                </p>
                                <p>
                                    We regret to inform you that your preliminary performance did not qualify for the APCS The Sound of Asia 2026 Gala Concert. However, we sincerely appreciate your hard work, dedication, and the passion you have shown throughout this competition. Each performance represents valuable progress in your musical journey, and we hope you take pride in your effort and growth.
                                </p>
                                <p>
                                    Please find below your e-certificate and e-comment sheets.
                                </p>
                                <p>
                                    We encourage you to continue pursuing your musical goals with the same enthusiasm and commitment. You have done an excellent job, and we look forward to seeing you again at our future events.
                                </p>
                                <p style="margin-top: 20px;">
                                    Best regards,<br>
                                    <strong>The APCS Team</strong>
                                </p>
                            </div>
                            ${generateCommonFooter()}
                        </div>
                    </div>
                </body>
            </html>
        `
    }),
    WINNER_ANNOUNCEMENT: (data) => ({
        subject: "APCS The Sound Of Asia 2026 Winner",
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                    <meta charset="utf-8">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; color:#000000; }
                        .email-wrapper { width: 100%; background-color: #f4f4f4; padding: 20px 0; }
                        .email-container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; }
                        .header { line-height: 0; }
                        .content { padding: 30px; line-height: 1.6; text-align: justify; }
                        .content p { margin: 0 0 16px 0; }
                        .content strong { color: #333333; }
                        .info-box { background-color: #f9f9f9; border: 1px solid #eeeeee; padding: 20px; border-radius: 5px; margin: 25px 0; }
                        .footer { text-align: center; font-size: 12px; color: #7f8c8d; padding: 20px; }
                    </style>
                </head>
            <body>
                <div class="email-wrapper">
                    <div class="email-container">
                        ${generateCommonHeader()}
                        <div class="content">
                            <p style="font-size: 16px;"><strong>APCS Gala Concert 2024 – Winner Announcement</strong></p>
                            <p>Dear <strong>${data.winner}</strong>,</p>
                            <p>Congratulations!</p>
                            <p>
                                You have been awarded as a <strong>${data.award}</strong> Winner and are invited to perform at the<strong> Gala Concert APCS The Sound of Asia 2025</strong> , which will be held on:
                            </p>
                            <div class="info-box">
                                <p style="margin: 0;"><strong>Date:</strong> Sunday, 2 November 2025</p>
                                <p style="margin: 5px 0 0 0;"><strong>Venue:</strong> Jakarta Intercultural School</p>
                                <p style="margin: 5px 0 0 0;"><strong>Address:</strong> Jl. Terogong Raya No. 33, Cilandak Barat, Kec. Cilandak, Kota Jakarta Selatan, DKI Jakarta 12430 </p>
                            </div>
                            <p>
                                Please take a moment to <strong>carefully read the attached PDF file for important guidelines</strong> and event details.
                            </p>
                            <p>
                                If you have any further questions, feel free to contact our admin via <a href="https://wa.me/6282213002686" style="color: #1a73e8; text-decoration: none;">WhatsApp.</a>
                            </p>
                            <p>
                                We look forward to welcoming you at the event & See you at APCS The Sound of Asia 2025!
                            </p>
                            <p>
                                <strong>Best regards,</strong> <br><strong>APCS Team</strong> 
                            </p>
                        </div>
                        ${generateCommonFooter()}
                    </div>
                </div>
            </body>
            </html>`
    }),
    WINNER_ANNOUNCEMENT_WITHOUT_VENUE: (data) => ({
        subject: "APCS The Sound Of Asia 2026 Winner",
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                    <meta charset="utf-8">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; color:#000000; }
                        .email-wrapper { width: 100%; background-color: #f4f4f4; padding: 20px 0; }
                        .email-container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; }
                        .header { line-height: 0; }
                        .content { padding: 30px; line-height: 1.6; }
                        .content p { margin: 0 0 16px 0; }
                        .content strong { color: #333333; }
                        .info-box { background-color: #f9f9f9; border: 1px solid #eeeeee; padding: 20px; border-radius: 5px; margin: 25px 0; }
                        .footer { text-align: center; font-size: 12px; color: #7f8c8d; padding: 20px; }
                    </style>
                </head>
            <body>
                <div class="email-wrapper">
                    <div class="email-container">
                        ${generateCommonHeader()}
                        <div class="content">
                            <p style="font-size: 16px;"><strong>APCS Gala Concert 2026 – Winner Announcement</strong></p>
                            <p>Dear <strong>${data.winner}</strong>,</p>
                            <p>Congratulations!</p>
                            <p>
                               We are delighted to inform you that you have been awarded as a <strong>${data.award}</strong> Winner of APCS The Sound of Asia 2025.
                            </p>
                            <p>
                                As a winner, you are officially invited to perform at the APCS Gala Concert 2026, which will be held in <strong>Jakarta</strong>. Further information regarding the performance date and venue will be announced later via email by <strong>June 30</strong>.
                            </p>
                            <p>
                                If you have any further questions, feel free to contact our admin via <a href="https://wa.me/6282213002686" style="color: #1a73e8; text-decoration: none;">WhatsApp.</a>
                            </p>
                            <p>
                                We look forward to welcoming you at the event & See you at APCS The Sound of Asia 2026!
                            </p>
                            <p>
                                <strong>Best regards,</strong> <br><strong>APCS Team</strong> 
                            </p>
                        </div>
                        ${generateCommonFooter()}
                    </div>
                </div>
            </body>
            </html>`
    }),

    WINNER_FAIL: (data) => ({
        subject: "APCS The Sound Of Asia 2025",
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                    <meta charset="utf-8">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; color:#000000; }
                        .email-wrapper { width: 100%; background-color: #f4f4f4; padding: 20px 0; }
                        .email-container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; }
                        .header { line-height: 0; }
                        .content { padding: 30px; line-height: 1.6; }
                        .content p { margin: 0 0 16px 0; }
                        .content strong { color: #333333; }
                        .info-box { background-color: #f9f9f9; border: 1px solid #eeeeee; padding: 20px; border-radius: 5px; margin: 25px 0; }
                        .footer { text-align: center; font-size: 12px; color: #7f8c8d; padding: 20px; }
                    </style>
                </head>
            <body>
                <div class="email-wrapper">
                    <div class="email-container">
                        ${generateCommonHeader()}
                        <div class="content">
                            <p style="font-size: 16px;"><strong>APCS Gala Concert 2024 – Winner Announcement</strong></p>
                            <p>Dear <strong>${data.winner}</strong>,</p>
                            <p>Thank you for your participation in <strong>APCS – The Sound of Asia.</strong></p>
                            <p>
                                We regret to inform you that your preliminary performance did not qualify for the <strong>Gala Concert APCS The Sound of Asia 2025.</strong> However, we sincerely appreciate your hard work, dedication, and the passion you have shown throughout this competition. Each performance represents valuable progress in your musical journey, and we hope you take pride in your effort and growth.
                            </p>
                            <p>
                                The comment sheets from the preliminary juries, along with your average score. Your <strong>E-Certificate and E-Comment Sheet</strong> will be delivered on <strong>30 October 2025 By Email.</strong>                                
                            </p>
                            <p>
                                We encourage you to continue pursuing your musical goals with the same enthusiasm and commitment. You have done an excellent job, and we look forward to seeing you again at our future events.
                            </p>
                            <p>
                                <strong>Best regards,</strong> <br><strong>APCS Team</strong> 
                            </p>
                        </div>
                        ${generateCommonFooter()}
                    </div>
                </div>
            </body>
            </html>`
    })
};

const getTemplate = (type, data) => {
    if (!templates[type]) {
        throw new Error(`Template type '${type}' not found.`);
    }
    return templates[type](data);
};

module.exports = { getTemplate };