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
        subject: 'APCS – E-Certificate and Comment Sheet',
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
                    .content { padding: 30px; line-height: 1.6; }
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
                                    Please find attached your E-Certificate and E-Comment Sheet from APCS <strong>“The Sound of Asia 2025”.</strong>
                                </p>
                                <p>
                                    We truly appreciate your effort and dedication throughout this journey. Every performance is a step forward, and you should be proud of your growth and hard work.
                                </p>
                                <p>
                                    Keep playing with passion, and we look forward to seeing you again in our future events.
                                </p>
                                <p style="margin-top: 20px;">
                                    Warm regards,<br>
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
    // Add other templates: WINNER, E_TICKET, INTERNAL_NOTIFY, etc.
};

const getTemplate = (type, data) => {
    if (!templates[type]) {
        throw new Error(`Template type '${type}' not found.`);
    }
    return templates[type](data);
};

module.exports = { getTemplate };