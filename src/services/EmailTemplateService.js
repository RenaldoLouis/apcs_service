const commonCss = `
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; color:#333; }
    .email-wrapper { width: 100%; background-color: #f4f4f4; padding: 20px 0; }
    .email-container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; }
    .header { line-height: 0; }
    .content { padding: 30px; line-height: 1.6; }
    .content p { margin: 0 0 16px 0; }
    .content strong { color: #333333; }
    .footer { text-align: center; font-size: 12px; color: #7f8c8d; padding: 20px; }
    .content, .content p, .content strong { color: #333 !important; }
`;

const juryCss = `
    ${commonCss}
    .credential-box { 
        background-color: #f8f9fa; 
        border-left: 4px solid #EBBC64; /* Gold border */
        padding: 20px; 
        margin: 25px 0; 
        border-radius: 4px; 
    }
    .credential-row {
        margin-bottom: 10px;
        font-size: 16px;
    }
    .credential-label {
        font-weight: bold;
        color: #333;
        display: inline-block;
        width: 100px;
    }
    .credential-value {
        color: #555;
        font-family: monospace;
        font-size: 16px;
    }
    .warning-text {
        color: #e74c3c;
        font-size: 13px;
        font-style: italic;
        margin-top: 10px;
    }
    .action-button {
        display: inline-block;
        background-color: #EBBC64; /* Gold */
        color: #000000;
        padding: 14px 30px;
        text-decoration: none;
        border-radius: 5px;
        font-weight: bold;
        margin-top: 25px;
        text-align: center;
    }
    .action-button:hover {
        background-color: #d4a753;
    }
`;

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
        subject: 'APCS THE SOUND OF ASIA 2025 ANNOUNCEMENT',
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
                            <p style="font-size: 16px;"><strong>APCS Gala Concert 2025 – Winner Announcement</strong></p>
                            <p>Dear <strong>${data.winner}</strong>,</p>
                            <p>Congratulations!</p>
                            <p>
                                You have been awarded as a <strong>${data.award}</strong> Winner and are invited to perform at the<strong> Gala Concert APCS The Sound of Asia 2025</strong> , which will be held on:
                            </p>
                            <div class="info-box">
                                <p style="margin: 0;"><strong>Date:</strong> Sunday, 1 November 2025</p>
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
        subject: "APCS GALA CONCERT 2026",
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
    FAIL_ANNOUNCEMENT: (data) => ({
        subject: "APCS The Sound Of Asia 2026",
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
    }),
    STAGE_RESCHEDULE_UPDATE: (data) => ({
        subject: `Update on Your APCS Official Performance Stage`,
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>${commonCss}
                    .content { padding: 30px; line-height: 1.6; text-align: justify; }
                    .footer-contact { background-color: #f9f9f9; border-top: 1px solid #eeeeee; padding: 20px 30px; font-size: 13px; color: #555; }
                </style>
            </head>
            <body>
                <div class="email-wrapper">
                    <div class="email-container">
                        ${generateCommonHeader()}
                        <div class="content">
                            <p>Dear <strong>${data.winner}</strong>,</p>
                            <p>
                                I hope this message finds you well.
                            </p>
                            <p>
                                Once again, congratulations on being selected as the Winner of the Ensemble 2 Pianos category at APCS The Sound of Asia 2025 Preliminary. Your artistry and musical partnership truly made a lasting impression, and we remain very proud to celebrate your achievement.                            </p>
                            <p>
                                We would like to share an important update regarding your official performance stage.
                            </p>
                            <p>
                                While we were initially planning for your performance journey to take place at 2026, due to stage technicality your official stage appearance will now be rescheduled to <strong>2027</strong>.
                            </p>
                            <p>
                                We are fully committed to presenting your performance in a setting that reflects the significance of your accomplishment, and this adjustment allows us to prepare the most meaningful platform for you.
                            </p>
                            <p>
                                We will share further details regarding the 2027 stage schedule in due time and will continue to keep you informed along the way.
                            </p>
                            <p>
                                Thank you for your understanding and continued support. We truly look forward to welcoming you on stage in 2027 and celebrating this special musical milestone together.
                            </p>
                            <p style="margin-top: 24px;">
                                Warm regards,<br>
                                <strong>APCS Team</strong>
                            </p>
                        </div>
                        <div class="footer-contact">
                            <p style="margin: 0;">Tel +62 8221 3002 686</p>
                            <p style="margin: 4px 0 0 0;">Jakarta, Indonesia</p>
                            <p style="margin: 4px 0 0 0;"><a href="https://www.apcsmusic.com" style="color: #333; text-decoration: none;">www.apcsmusic.com</a></p>
                        </div>
                        ${generateCommonFooter()}
                    </div>
                </div>
            </body>
            </html>
        `
    }),
    JURY_ACCOUNT_CREATION: (data) => ({
        subject: `Welcome to APCS 2026 - Jury Access Credentials`,
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>${juryCss}</style>
            </head>
            <body>
                <div class="email-wrapper">
                    <div class="email-container">
                        ${generateCommonHeader()}
                        <div class="content">
                            <p>Dear <strong>${data.name}</strong>,</p>
                            
                            <p>
                                We are honored to welcome you as a Jury member for the <strong>${data.competitionCategory}</strong> category at APCS The Sound of Asia 2025.
                            </p>
                            
                            <p>
                                An account has been created for you to access the Jury Scoring Dashboard. Please find your login credentials below:
                            </p>

                            <div class="credential-box">
                                <div class="credential-row">
                                    <span class="credential-label">Email:</span>
                                    <span class="credential-value">${data.email}</span>
                                </div>
                                <div class="credential-row">
                                    <span class="credential-label">Password:</span>
                                    <span class="credential-value">${data.password}</span>
                                </div>
                                <p class="warning-text">
                                    *Please keep these credentials confidential and do not share them with anyone.
                                </p>
                            </div>

                            <p>
                                You can log in to view contestants and submit your scores using the link below:
                            </p>

                            <div style="text-align: center;">
                                <a href="https://www.apcsmusic.com/login" target="_blank" class="action-button">
                                    Access Jury Dashboard
                                </a>
                            </div>

                            <p style="margin-top: 30px;">
                                If you have any trouble logging in, please contact the committee immediately.
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
    SOUND_OF_ASIA_2026_INVITE: (data) => ({
        subject: "Invitation to Participate: The Sound of Asia 2026",
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>${commonCss}</style>
            </head>
            <body>
                <div class="email-wrapper">
                    <div class="email-container">
                        ${generateCommonHeader()}
                        <div class="content" style="text-align: justify;">
                            <p>Dear Talented Musicians,</p>
                            <p>Warm greetings from APCS Music 🤍</p>
                            <p>Thank you for being part of the APCS journey. It’s always a joy to have passionate musicians like you in our community.</p>
                            <p>This year, we’re excited to introduce a new experience through <strong>The Sound of Asia 2026</strong> 🎶</p>
                            <p>As part of this grand finale edition, our Sapphire Winner will be featured in a live orchestral performance. You will also have the opportunity to experience a <strong>live orchestral performance</strong> and meet our <strong>International Jury</strong> in person.</p>
                            <p>We would love to invite you to join us again and be part of this exciting chapter:</p>
                            <p>
                                ✨ Last video submission: <strong>1 August 2026</strong><br>
                                📍 Live stage: Jakarta <strong>14–15 November 2026</strong><br>
                                🎹 Categories: Piano, Strings, Woodwinds, Brass, Guitar, Percussion, Harp, Vocal & Choir, Guzheng, Electone<br>
                                🏆 Prizes up to <strong>IDR 50,000,000</strong> + opportunity to perform with the APCS Orchestra
                            </p>
                            <p>From online preliminary to a live international stage, this is your moment to grow, connect, and shine.</p>
                            <p>If you need any assistance or information, feel free to reach us anytime:<br>
                                <a href="https://wa.me/6282213002686" style="color: #1a73e8; text-decoration: none;">wa.me/6282213002686</a>
                            </p>
                            <p>See you again on the APCS stage 🙌🏻✨</p>
                            <p style="margin-top: 24px;">
                                Warm regards,<br>
                                <strong>APCS Music</strong>
                            </p>
                        </div>
                        ${generateCommonFooter()}
                    </div>
                </div>
            </body>
            </html>
        `
    }),
    GALA_CONCERT_UPDATE_2026: (data) => ({
        subject: "APCS Gala Concert 2026 – Official Update",
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>${commonCss}</style>
            </head>
            <body>
                <div class="email-wrapper">
                    <div class="email-container">
                        ${generateCommonHeader()}
                        <div class="content">
                            <p>Dear <strong>${data.name}</strong>,</p>
                            <p>Warm greetings from APCS.</p>
                            <p>Once again, congratulations on being awarded as a <strong>Winner of APCS The Sound of Asia 2026</strong>. We are truly honored to have you as part of the APCS Gala Concert 2026 in Jakarta.</p>
                            <p>We would like to share an important update regarding the Gala Concert. Due to a technical issue, your performance, which was <strong>previously scheduled for August</strong>, will now take place on <strong>14–15 November 2026 </strong>in Jakarta, Indonesia. The detailed rundown and exact venue location will be shared <strong> no later than two weeks before the event</strong>.</p>
                            <p>To help us arrange the performance schedule, <strong>please kindly contact our admin</strong> via WhatsApp at <a href="https://wa.me/6282213002686" style="color: #1a73e8; text-decoration: none;">+62 822-1300-2686</a> and let us know which date you would prefer to perform: <strong>14 November</strong> or <strong>15 November</strong>.</p>
                            <p>We are very much looking forward to welcoming you to Jakarta and celebrating this special musical moment together.</p>
                            <p>Thank you for being part of the APCS musical journey.</p>
                            <p style="margin-top: 24px;">
                                Warm regards,<br>
                                <strong>APCS Team</strong>
                            </p>
                        </div>
                        ${generateCommonFooter()}
                    </div>
                </div>
            </body>
            </html>
        `
    }),

    publicSeatHold: (data) => {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Your Seat is Held</title>
                <style>
                    ${commonCss}
                    .alert-box { background: #fff3cd; border: 1px solid #ffeeba; border-radius: 8px; padding: 16px 20px; margin: 24px 0; }
                    .alert-box p { margin: 0; color: #856404; font-weight: 600; font-size: 14px; }
                    .info-row { display: flex; margin-bottom: 8px; }
                    .info-label { color: #888; min-width: 120px; font-size: 13px; }
                    .info-value { color: #333; font-size: 13px; font-weight: 600; }
                    .cta-button { display: inline-block; width: fit-content; margin: 28px 0; background: #EBBC64; color: #000; font-weight: 700; font-size: 16px; padding: 14px 40px; border-radius: 8px; text-decoration: none; text-align: center; }
                </style>
            </head>
            <body>
                <div class="email-wrapper">
                    <div class="email-container">
                        ${generateCommonHeader()}
                        <div class="content">
                            <p>Dear <strong>${data.name}</strong>,</p>
                            ${data.registrantName ? `<p style="margin-top: -10px; color: #555; font-size: 14px;">Paying for Registrant: <strong>${data.registrantName}</strong></p>` : ''}
                            <p>Your selected seat(s) are now <strong>temporarily reserved</strong> for you.</p>

                            <div class="alert-box">
                                <p>Complete your payment before <strong>${data.deadline}</strong>.<br>
                                After this time, your seat reservation will be automatically released.</p>
                            </div>

                            <p><strong>Booking Details:</strong></p>
                            <div class="info-row"><span class="info-label">Venue</span><span class="info-value">${data.venueName}</span></div>
                            <div class="info-row"><span class="info-label">Date</span><span class="info-value">${data.date}</span></div>
                            <div class="info-row"><span class="info-label">Session</span><span class="info-value">${data.session}</span></div>

                            <div style="text-align: center;">
                                <a href="${data.paymentUrl}" class="cta-button">Complete Payment Now</a>
                            </div>

                            <p style="color:#888; font-size:13px;">If the button doesn't work, copy and paste this link into your browser:<br>
                            <a href="${data.paymentUrl}" style="color:#1a73e8; word-break:break-all;">${data.paymentUrl}</a></p>

                            <p>If you did not initiate this booking, please ignore this email — your seats will be released automatically.</p>
                            <p style="margin-top: 24px;">
                                Warm regards,<br>
                                <strong>APCS Team</strong>
                            </p>
                        </div>
                        ${generateCommonFooter()}
                    </div>
                </div>
            </body>
            </html>
        `;
    },

    publicBookingConfirmation: (data) => {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Payment Confirmed</title>
                <style>
                    ${commonCss}
                    .success-badge { background: #d4edda; border: 1px solid #c3e6cb; border-radius: 8px; padding: 12px 20px; margin: 0 0 24px; text-align: center; color: #155724; font-weight: 700; font-size: 15px; }
                    .ticket-card { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 8px; padding: 20px; margin: 16px 0; }
                    .info-row { display: flex; margin-bottom: 8px; }
                    .info-label { color: #888; min-width: 140px; font-size: 13px; }
                    .info-value { color: #333; font-size: 13px; font-weight: 600; }
                    .divider { border: none; border-top: 1px solid #e9ecef; margin: 20px 0; }
                    .total-row { display: flex; justify-content: space-between; font-size: 16px; font-weight: 700; }
                    .total-amount { color: #333; }
                </style>
            </head>
            <body>
                <div class="email-wrapper">
                    <div class="email-container">
                        ${generateCommonHeader()}
                        <div class="content">
                            <div class="success-badge">Payment Confirmed</div>

                            <p>Dear <strong>${data.userName}</strong>,</p>
                            ${data.registrantName ? `<p style="margin-top: -10px; color: #555; font-size: 14px;">Paying for Registrant: <strong>${data.registrantName}</strong></p>` : ''}
                            <p>Thank you! Your payment has been received and your seat(s) for the <strong>APCS 2026 Gala Concert</strong> are now <strong>permanently reserved</strong>.</p>

                            <div class="ticket-card">
                                <div class="info-row"><span class="info-label">Booking ID</span><span class="info-value">${data.bookingId}</span></div>
                                <div class="info-row"><span class="info-label">Venue</span><span class="info-value">${data.venueName}</span></div>
                                <div class="info-row"><span class="info-label">Date</span><span class="info-value">${data.date}</span></div>
                                <div class="info-row"><span class="info-label">Session</span><span class="info-value">${data.session}</span></div>
                                <div class="info-row"><span class="info-label">Tickets</span><span class="info-value">${data.ticketSummary}</span></div>
                                ${data.performanceSeatLabels ? `<div class="info-row"><span class="info-label">Competition Seats</span><span class="info-value">${data.performanceSeatLabels}</span></div>` : ''}
                                ${data.orchestraSeatLabels ? `<div class="info-row"><span class="info-label">Orchestra Seats</span><span class="info-value">${data.orchestraSeatLabels}</span></div>` : ''}
                                ${(!data.performanceSeatLabels && !data.orchestraSeatLabels && data.seatLabels) ? `<div class="info-row"><span class="info-label">Seats</span><span class="info-value">${data.seatLabels}</span></div>` : ''}
                                <hr class="divider">
                                <div class="total-row">
                                    <span>Total Paid</span>
                                    <span class="total-amount">${data.totalAmountFormatted}</span>
                                </div>
                            </div>

                            <p>Please present this email or your Booking ID at the venue entrance. Our team will verify your booking.</p>
                            <p>We look forward to seeing you at the concert!</p>
                            <p style="margin-top: 24px;">
                                Warm regards,<br>
                                <strong>APCS Team</strong>
                            </p>
                        </div>
                        ${generateCommonFooter()}
                    </div>
                </div>
            </body>
            </html>
        `;
    },
    PERFORMANCE_INVITATION: (data) => ({
        subject: `APCS Gala Concert 2026 – Performance Invitation`,
        html: `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <style>
                    ${commonCss}
                </style>
            </head>
            <body>
                <div class="email-wrapper">
                    <div class="email-container">
                        ${generateCommonHeader()}
                        <div class="content">
                            <p>Dear <strong>${data.name}</strong>,</p>
                            <p>Congratulations!</p>
                            <p>You have been awarded as a <strong>${data.awardTier ? data.awardTier.toUpperCase() : 'SILVER/GOLD/DIAMOND'} WINNER</strong> and are invited to perform at the APCS Gala Concert The Sound of Asia 2026.</p>
                            <p>Date: 14–15 November 2026<br>
                            Venue: Titan Center<br>
                            Address: Jln. Boulevard Bintaro, Block B7/B1 No.5, Bintaro Jaya, Sektor 7, Tangerang 15424, Indonesia</p>
                            <p>Please read the attached <strong>PDF</strong> carefully, as it contains all important event guidelines and performance information.</p>
                            <p>Kindly confirm your attendance by <strong>${data.confirmationDeadline}</strong>. After the deadline, no changes or performer substitutions can be made.</p>
                            <p>The final performance rundown will be shared on <strong>${data.rundownReleaseDate}</strong>.</p>
                            <p>If you have any questions, feel free to <a href="https://wa.me/6281222625296">contact our admin via WhatsApp</a>.</p>
                            <p>We look forward to seeing you at APCS The Sound of Asia 2026!</p>
                            <p>
                                Best regards,<br>
                                <strong>APCS Team</strong>
                            </p>
                        </div>
                        ${generateCommonFooter()}
                    </div>
                </div>
            </body>
            </html>
        `
    })
};

const getTemplate = (type, data) => {
    if (!templates[type]) {
        throw new Error(`Template type '${type}' not found.`);
    }
    return templates[type](data);
};

module.exports = { getTemplate };