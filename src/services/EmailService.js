const nodemailer = require("nodemailer");
const Queue = require('bull');
const { logger } = require('../utils/Logger');
const jwt = require('jsonwebtoken');
const path = require('path');

// IMPORTANT: Store this secret in your .env file!
const JWT_SECRET = process.env.JWT_SECRET;


const defaultJobOptions = {
    removeOnComplete: true,
    removeOnFail: false,
    attempts: 5, // retry up to 3 times if failed
    backoff: {
        type: 'exponential',
        delay: 2000, // initial delay of 1 second before retrying
    },
};

// const redisConfig = {
//     redis: {
//         path: '/home/apcc8119/tmp/redis.sock'
//     },
//     limiter: {
//         max: 5,         // Maximum number of jobs processed per duration
//         duration: 60000 // Time window in milliseconds (1 minute)
//     }
// };

/* DONT FORGET TO REVERT THE CONFIG */
// for local dev only 
const redisConfig = {
    redis: {
        host: "127.0.0.1",
        port: 6379
    },
    limiter: {
        max: 3,         // Maximum number of jobs processed per duration
        duration: 30000 // Time window in milliseconds (1 minute)
    }
};

const emailQueue = new Queue('emailQueue', redisConfig, { defaultJobOptions });

// Create a nodemailer transporter with TLS enforced
const transporter = nodemailer.createTransport({
    pool: true,
    maxConnections: 10,
    // maxMessages: 5,            // Close connection after 5 messages to avoid stale connections
    connectionTimeout: 120000, // Increase connection timeout to 120 seconds
    socketTimeout: 120000,     // Increase socket timeout to 120 seconds
    service: "Gmail",
    host: "smtp-relay.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// Verify SMTP connection once on startup
transporter.verify((error, success) => {
    if (error) {
        logger.error("SMTP Connection Error on startup:", error);
    } else {
        logger.info("SMTP Connection Successful on startup!");
    }
});

const ATTACHMENT_FILE_PATH = path.join(__dirname, 'attachments/APCS_WINNER_ANNOUNCEMENT.pdf');
const ATTACHMENT_FILENAME = 'APCS_WINNER_ANNOUNCEMENT.pdf';

// Enqueue a single email job (if needed)
const enqueueEmailJob = (data) => {
    emailQueue.add({ emailData: data });
};

// Bulk enqueue emails using addBulk for better performance
const enqueueBulkEmails = (emailsArray) => {
    const jobs = emailsArray.map(data => ({ data: { emailData: data } }));
    emailQueue.addBulk(jobs);
};

const processEmailQueue = async (job) => {
    logger.info(`Processing email job id: ${job.id}`);
    const { emailData } = job.data;
    const { email: to, name: participant } = emailData;
    try {
        const mailOptions = {
            from: "hello@apcsmusic.com",
            to: to,
            subject: "APCS Gala Concert 2024 - Winner Announcement",
            text: `
            Dear ${participant},

            Congratulations! You have won the Silver Category and earned the opportunity to perform at the APCS Gala Concert 2024, which will be held on:

            Day/Date: Saturday, October 19, 2024
            Location: Galeri Salihara, South Jakarta

            Kindly take a moment to review the terms and conditions provided in the attached PDF file. If you have further questions, please contact the admin via the following WhatsApp:

            Silver & Gold Admin: https://wa.me/6281528885132

            See you at the event! :)
            `,
            attachments: [
                {
                    filename: 'license.txt',
                    path: 'https://raw.github.com/nodemailer/nodemailer/master/LICENSE'
                },
            ]
        };

        const result = await transporter.sendMail(mailOptions);
        logger.info(`Successfully sent email to ${to} for job id: ${job.id}`);
        console.log(`Message sent to ${to}: ${result.messageId}`);
        return result;
    } catch (error) {
        if (error.message.includes("Socket connection timeout")) {
            logger.warn(`Socket connection timeout for job id: ${job.id}. Retrying...`);
            // Manually trigger a retry; note that job.retry() will work if your job hasn't exhausted its attempts.
            await job.retry();
        } else {
            logger.error(`Failed to send email to ${to} for job id: ${job.id}: ${error.message}`);
            throw error; // rethrow to allow Bull to handle retries
        }
    }
};

const sendEmailFunc = async (data) => {
    logger.info(`Processing email: ${data.email}`);
    const participant = data.name
    const to = data.email
    try {
        const mailOptions = {
            from: "hello@apcsmusic.com",
            to: to,
            subject: "APCS Registration Confirmation",
            html: `<!DOCTYPE html>
            <html xmlns:v="
            urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">

            <head>
                <title></title>
                <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0"><!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--><!--[if !mso]><!-->
                <link href="https://fonts.googleapis.com/css?family=Open+Sans" rel="stylesheet" type="text/css"><!--<![endif]-->
                <style>
                    * {
                        box-sizing: border-box;
                    }

                    body {
                        margin: 0;
                        padding: 0;
                    }

                    a[x-apple-data-detectors] {
                        color: inherit !important;
                        text-decoration: inherit !important;
                    }

                    #MessageViewBody a {
                        color: inherit;
                        text-decoration: none;
                    }

                    p {
                        line-height: inherit
                    }

                    .desktop_hide,
                    .desktop_hide table {
                        mso-hide: all;
                        display: none;
                        max-height: 0px;
                        overflow: hidden;
                    }

                    .image_block img+div {
                        display: none;
                    }

                    sup,
                    sub {
                        font-size: 75%;
                        line-height: 0;
                    }

                    .menu_block.desktop_hide .menu-links span {
                        mso-hide: all;
                    }

                    @media (max-width:700px) {

                        .desktop_hide table.icons-inner,
                        .social_block.desktop_hide .social-table {
                            display: inline-block !important;
                        }

                        .icons-inner {
                            text-align: center;
                        }

                        .icons-inner td {
                            margin: 0 auto;
                        }

                        .mobile_hide {
                            display: none;
                        }

                        .row-content {
                            width: 100% !important;
                        }

                        .stack .column {
                            width: 100%;
                            display: block;
                        }

                        .stackFooter{
                            width: 50% !important;
                            display: table-cell !important
                        }

                        .mobile_hide {
                            min-height: 0;
                            max-height: 0;
                            max-width: 0;
                            overflow: hidden;
                            font-size: 0px;
                        }

                        .desktop_hide,
                        .desktop_hide table {
                            display: table !important;
                            max-height: none !important;
                        }

                        .reverse {
                            display: table;
                            width: 100%;
                        }

                        .reverse .column.first {
                            display: table-footer-group !important;
                        }

                        .reverse .column.last {
                            display: table-header-group !important;
                        }

                        .row-5 td.column.first .border {
                            padding: 0;
                            border-top: 0;
                            border-right: 0px;
                            border-bottom: 0;
                            border-left: 0;
                        }

                        .row-5 td.column.last .border {
                            padding: 25px 0 0;
                            border-top: 0;
                            border-right: 0px;
                            border-bottom: 0;
                            border-left: 0;
                        }
                    }
                </style><!--[if mso ]><style>sup, sub { font-size: 100% !important; } sup { mso-text-raise:10% } sub { mso-text-raise:-10% }</style> <![endif]-->
            </head>

            <body class="body" style="background-color: #fbfcfc; margin: 0; padding: 0; -webkit-text-size-adjust: none; text-size-adjust: none;">
                <table class="nl-container" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #fbfcfc;">
                    <tbody>
                        <tr>
                            <td>
                                <table class="row row-4" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="50%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-top: 30px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="paragraph_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Georgia,Times,'Times New Roman',serif;font-size:24px;line-height:120%;text-align:left;mso-line-height-alt:28.799999999999997px;">
                                                                                <div style="max-width: 126.667px;"><img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" style="display: block; border-radius:16px; height: auto; border: 0; width: 100%;" width="126.667" alt="APCS Logo" title="APCS Logo" height="auto"></div>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="paragraph_block block-3" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad" style="padding-top:4px;">
                                                                            <div style="color:#393d47;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:14px;line-height:1.6;text-align:left;">
                                                                                <p style="margin: 0 0 16px 0;"><em>Dear <strong>${participant}</strong>,</em></p>

                                                                                <p style="margin: 0 0 16px 0; text-align:justify;">
                                                                                    Welcome to the APCS Family! We are pleased to confirm your registration for <strong>The Sound of Asia</strong>. 
                                                                                    We look forward to seeing you on the APCS stage as we celebrate music, culture, and extraordinary talent from around the world.
                                                                                </p>

                                                                                <p style="margin: 0 0 16px 0; text-align-last:justify; text-align:justify;">
                                                                                    All winners will be notified via email, so please stay tuned. <strong>The Sapphire Winner</strong> will be announced live on stage during the APCS event, 
                                                                                    and we’re excited to celebrate every outstanding performance.
                                                                                </p>

                                                                                <p style="margin: 0 0 16px 0;">
                                                                                    Thank you for being a part of this incredible experience.<br><br>
                                                                                    We can’t wait to welcome you at the event!
                                                                                </p>

                                                                                <p style="margin: 0;">
                                                                                    Warm regards,<br>
                                                                                    <strong>The APCS Team</strong>
                                                                                </p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-9" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stackFooter" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: black; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="50%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 10px; padding-left: 10px; padding-right: 20px; padding-top: 10px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="image_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad" style="padding-right:30px;padding-top:10px;width:100%;">
                                                                            <div class="alignment" align="left" style="line-height:10px;text-align:left;">
                                                                                <div style="max-width: 126.667px;"><img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" style="display: block; border-radius:16px; height: auto; border: 0; width: 100%;" width="126.667" alt="APCS Logo" title="APCS Logo" height="auto"></div>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="social_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad" style="padding-left:0px;">
                                                                            <div class="alignment" align="left">
                                                                                <table class="social-table" width="108px" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; display: inline-block;">
                                                                                    <tr>
                                                                                        <td style="padding:0px 4px 0px 0px; background:transparent; border-radius:35px;">
                                                                                            <a href="https://www.youtube.com/@apcsmusic" target="_blank">
                                                                                                <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/icon-youtubewhite.png" width="32" height="auto" alt="YouTube" title="youtube" style="border-radius:35px;display: block; height: auto; border: 0;">
                                                                                            </a>
                                                                                        </td>
                                                                                        <td style="padding:0px 4px 0px 4px; background:transparent; border-radius:35px;">
                                                                                            <a href="https://www.instagram.com/apcs.music" target="_blank">
                                                                                                <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/icon-instagram.png" width="32" height="auto" alt="Instagram" title="instagram" style="border-radius:35px;display: block; height: auto; border: 0;">
                                                                                            </a>
                                                                                        </td>
                                                                                        <td style="padding:0px 4px 0px 4px; background:transparent; border-radius:35px;">
                                                                                            <a href="https://api.whatsapp.com/send/?phone=6282213002686" target="_blank">
                                                                                                <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/icon-whatsapp.png" width="32" height="auto" alt="WhatsApp" title="whatsapp" style="border-radius:35px;display: block; height: auto; border: 0;">
                                                                                            </a>
                                                                                        </td>
                                                                                    </tr>
                                                                                </table>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                            <td class="column column-2" width="50%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 30px; padding-left: 10px; padding-right: 10px; padding-top: 20px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="paragraph_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#ffffff;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:14px;line-height:120%; mso-line-height-alt:16.8px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;"><strong><span style="word-break: break-word;">Contact Us</span></strong></span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="paragraph_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:12px;line-height:120%;mso-line-height-alt:14.399999999999999px;">
                                                                                <p style="margin: 0; word-break: break-word;">
                                                                                    <a href="https://www.apcsmusic.com/" style="color: #ffffff; text-decoration: none;" target="_blank">
                                                                                        apcsmusic.com
                                                                                    </a>
                                                                                </p>                                                                                
                                                                                <p style="margin: 0; word-break: break-word;">
                                                                                    <a href="mailto:hello@apcsmusic.com" style="color: #ffffff; text-decoration: none;">
                                                                                        hello@apcsmusic.com
                                                                                    </a>
                                                                                </p>                                                                                
                                                                                <p style="margin: 0;margin-top:4px; word-break: break-word;"><span style="word-break: break-word; color: #ffffff;">(+62) 822-1300-2686</span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-9" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stackFooter" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: black; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td colspan="1" width="100%" align="left" style="padding: 0px 0px 10px 10px; text-align: left; color: #ffffff; font-family: Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.5;">
                                                                ©️ 2025 APCS Music, All rights reserved.
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </td>
                        </tr>
                    </tbody>
                </table><!-- End -->
            </body>

            </html>`,
        };

        const result = await transporter.sendMail(mailOptions);
        logger.info(`Successfully sent email to ${to}`);
        return result;
    } catch (error) {
        logger.error(`Failed to send email to ${to}: ${error.message}`);
        throw error; // rethrow to allow Bull to handle retries
    }
}

const sendEmailWinnerFunc = async (data) => {
    logger.info(`Processing email Winner: ${data.email}`);
    const winner = data.name;
    const to = data.email;
    const award = data.award;
    const isFail = award === "FAIL"

    let mailOptions;

    try {
        if (!isFail) {
            mailOptions = {
                from: '"APCS Music" <hello@apcsmusic.com>',
                to: to,
                subject: "APCS The Sound Of Asia 2025 Winner",
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
                            <div class="header">
                                <div style="width: 100%; background: black;">
                                    <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" style="display: block; height: auto; border: 0; width: 50%; max-width: 400px; margin: 0 auto;" alt="APCS Logo" title="APCS Logo">
                                </div>
                            </div>
                            <div class="content">
                                <p style="font-size: 16px;"><strong>APCS Gala Concert 2024 – Winner Announcement</strong></p>
                                <p>Dear <strong>${winner}</strong>,</p>
                                <p>Congratulations!</p>
                                <p>
                                    You have been awarded as a <strong>${award}</strong> Winner and are invited to perform at the<strong> Gala Concert APCS The Sound of Asia 2025</strong> , which will be held on:
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
                            <div class="footer">
                                <p>&copy; ${new Date().getFullYear()} APCS Music</p>
                            </div>
                        </div>
                    </div>
                </body>
                </html>`,
                attachments: [
                    {
                        filename: ATTACHMENT_FILENAME, // e.g., 'APCS_Winner_Information.pdf'
                        path: ATTACHMENT_FILE_PATH     // e.g., './attachments/winner_guide.pdf'
                    }
                ]
            };
        } else if (isFail) {
            mailOptions = {
                from: '"APCS Music" <hello@apcsmusic.com>',
                to: to,
                subject: "APCS The Sound Of Asia 2025 Winner",
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
                            <div class="header">
                                <div style="width: 100%; background: black;">
                                    <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" style="display: block; height: auto; border: 0; width: 50%; max-width: 400px; margin: 0 auto;" alt="APCS Logo" title="APCS Logo">
                                </div>
                            </div>
                            <div class="content">
                                <p style="font-size: 16px;"><strong>APCS Gala Concert 2024 – Winner Announcement</strong></p>
                                <p>Dear <strong>${winner}</strong>,</p>
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
                            <div class="footer">
                                <p>&copy; ${new Date().getFullYear()} APCS Music</p>
                            </div>
                        </div>
                    </div>
                </body>
                </html>`
            };
        }
        const result = await transporter.sendMail(mailOptions);
        logger.info(`Successfully sent email to ${to}`);
        return result;
    } catch (error) {
        logger.error(`Failed to send email to ${to}: ${error.message}`);
        throw error;
    }
}

const sendEmailWinnerSessionFunc = async (data) => {
    logger.info(`Processing email Winner: ${data.email}`);
    const winner = data.name;
    const to = data.email;

    let mailOptions;

    try {
        mailOptions = {
            from: '"APCS Music" <hello@apcsmusic.com>',
            to: "renaldolouis555@gmail.com",
            subject: "APCS The Sound of Asia – Rundown (1–2 November 2025)",
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
                            <div class="header">
                                <div style="width: 100%; background: black;">
                                    <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" style="display: block; height: auto; border: 0; width: 50%; max-width: 400px; margin: 0 auto;" alt="APCS Logo" title="APCS Logo">
                                </div>
                            </div>
                            <div class="content">
                                <p>Dear <strong>${winner}</strong>,</p>
                                <p>
                                    Thank you for confirming your participation in the APCS Stage.
                                    Please find attached the Rundown for APCS The Sound of Asia (1–2 November 2025).                               
                                </p>
                                <p>
                                    We look forward to welcoming you and celebrating your achievements at the APCS Gala Concert 2025, which will be held at Jakarta Intercultural School.
                                </p>
                                <p>
                                    <strong>Best regards,</strong> <br><strong>APCS Team</strong> 
                                </p>
                            </div>
                            <div class="footer">
                                <p>&copy; ${new Date().getFullYear()} APCS Music</p>
                            </div>
                        </div>
                    </div>
                </body>
                </html>`,
            attachments: [
                {
                    filename: ATTACHMENT_FILENAME, // e.g., 'APCS_Winner_Information.pdf'
                    path: ATTACHMENT_FILE_PATH     // e.g., './attachments/winner_guide.pdf'
                }
            ]
        };

        const result = await transporter.sendMail(mailOptions);
        logger.info(`Successfully sent email to ${to}`);
        return result;
    } catch (error) {
        logger.error(`Failed to send email to ${to}: ${error.message}`);
        throw error;
    }
}

const sendEmailMarketingFunc = async (data) => {
    logger.info(`Processing email: ${data.email}`);
    const winner = data.name
    const to = data.email
    try {
        const mailOptions = {
            from: "hello@apcsmusic.com",
            to: to,
            subject: "APCS The Sound Of Asia 2025 Winner",
            html: `<!DOCTYPE html>
                    <html>
                    <body style="font-family: Arial, sans-serif; color: #000; font-size: 14px; line-height: 1.6; margin: 0; padding: 20px;">
                        <p><strong>APCS Gala Concert 2024 – Winner Announcement – ${winner}</strong></p>

                        <p>Dear <strong>${winner}</strong>,</p>

                        <p>
                        Selamat! Kamu telah memenangkan kategori Diamond dan dapat tampil pada panggung event 
                        <strong>APCS Gala Concert 2024</strong> yang akan diselenggarakan pada:
                        </p>

                        <p>
                        <strong>Hari/Tanggal:</strong> Sabtu, 19 Oktober <strong>2024</strong><br />
                        <strong>Lokasi:</strong> Jakarta Intercultural School
                        </p>

                        <p>
                        Pemenang diharapkan untuk membaca ketentuan yang terlampir pada email ini berupa attachment file PDF. 
                        Apabila ada pertanyaan lebih lanjut, harap menghubungi admin melalui WhatsApp berikut:
                        </p>

                        <p>
                        <strong>Diamond Admin:</strong> 
                        <a href="https://wa.me/6282213002686" style="color: #1a73e8;">https://wa.me/6282213002686</a>
                        </p>

                        <p>See you at the event! :)</p>
                    </body>
                    </html>`,
            attachments: [
                {
                    filename: 'Diamond-Winner.txt',
                    path: 'https://raw.github.com/nodemailer/nodemailer/master/LICENSE'
                },
            ]
        };

        const result = await transporter.sendMail(mailOptions);
        logger.info(`Successfully sent email to ${to}`);
        return result;
    } catch (error) {
        logger.error(`Failed to send email to ${to}: ${error.message}`);
        throw error; // rethrow to allow Bull to handle retries
    }
}


const sendEmailPaymentRequest = async (data) => {
    logger.info(`Sending payment request to: ${data.email}`);
    const registrantName = data.name;
    const to = data.email;
    const price = data.price ?? "Please Check PDF on website"

    try {
        const mailOptions = {
            from: '"APCS Music" <hello@apcsmusic.com>',
            to: to,
            subject: `Payment Instructions – APCS Music Competition`, // Updated Subject
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
                        .email-wrapper { width: 100%; background-color: #f4f4f4; }
                        .email-container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; }
                        .header {color: #333333; text-align: center; }
                        .header h1 { margin: 0; font-size: 24px; }
                        .content { padding: 30px; line-height: 1.6; color: #555555; }
                        .content p { margin: 0 0 20px 0; }
                        .content h3 { color: #333333; margin-top: 30px; margin-bottom: 15px; border-bottom: 1px solid #eeeeee; padding-bottom: 5px; }
                        .payment-details { background-color: #f9f9f9; border: 1px solid #eeeeee; padding: 20px; border-radius: 5px; margin-bottom: 25px; }
                        .payment-details div { margin-bottom: 10px; }
                        .payment-details strong { color: #333333; width: 180px; display: inline-block; }
                        .important-notes ul { padding-left: 20px; }
                        .important-notes li { margin-bottom: 10px; }
                        .footer { text-align: center; font-size: 12px; color: #7f8c8d; padding: 20px; }
                        .ps-note { font-size: 12px; color: #7f8c8d; }
                    </style>
                </head>
                <body>
                    <div class="email-wrapper">
                        <div class="email-container">
                              <div class="header">
                                <div style="color:#393d47;font-family:Georgia,Times,'Times New Roman',serif;font-size:24px;line-height:120%;text-align:left;mso-line-height-alt:28.799999999999997px;">

                                    <div style="width: 100%;background: black;">

                                        <img
                                            src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png"
                                            style="display: block; height: auto; border: 0; width: 50%; max-width: 400px; margin: 0 auto;"
                                            alt="APCS Logo"
                                            title="APCS Logo">

                                    </div>
                                </div>
                            </div>
                            <div class="content">
                                <p>Dear <strong>${registrantName}</strong>,</p>
                                <p>Thank you for registering for the APCS Music Competition.</p>
                                <p>To complete your registration, please proceed with the payment. The fee for your category is listed in the <strong>Registration Guide PDF</strong> available on our <a href="https://www.apcsmusic.com/register" target="_blank" style="color: #3498db;">website</a>.</p>
                                
                                <h3>Payment Details</h3>
                                <div class="payment-details">
                                    <div><strong>Bank Name:</strong> Bank Central Asia (BCA)</div>
                                    <div><strong>Account Number:</strong> 8200409915</div>
                                    <div><strong>Account Holder Name:</strong> Michaela Sutejo</div>
                                    <div><strong>SWIFT CODE:</strong> CENAIDJA</div>
                                    <div><strong>Branch Address:</strong> BCA KCU Pematang Siantar, Indonesia</div>
                                    <div><strong>Category:</strong> ${data.competitionCategory}</div>
                                    <div><strong>Amount:</strong> ${price}</div>
                                    <div><strong>Payment Reference:</strong> Your Full Name – Category</div>
                                    <div style="font-size: 13px; color: #777;"><em>Example: Jason Smith – Violin</em></div>
                                </div>

                                <h3>Important Notes</h3>
                                <div class="important-notes">
                                    <ul>
                                        <li>Please double-check that the account number is entered correctly.</li>
                                        <li>For international transfers, ensure all associated bank fees are covered so we receive the full amount.</li>
                                    </ul>
                                </div>

                                <h3>What's Next?</h3>
                                <p>Once you've completed the transfer, kindly reply to this email with your payment proof (transfer receipt).</p>
                                <p>If you have any questions, feel free to contact us.</p>
                                <p>Best regards,<br>APCS Music Team</p>
                                <br>
                                <p class="ps-note">P.S. A confirmation email will be sent once your payment has been verified by our team.</p>
                            </div>
                            <div class="footer">
                                <p>&copy; ${new Date().getFullYear()} APCS Music</p>
                            </div>
                        </div>
                    </div>
                </body>
                </html>
                `
        };

        const result = await transporter.sendMail(mailOptions);
        logger.info(`Successfully sent payment request to ${to}`);
        return result;
    } catch (error) {
        logger.error(`Failed to send payment request to ${to}: ${error.message}`);
        throw error;
    }
}

const sendSeatBookingEmail = async (data) => {
    logger.info(`Sending seat booking email to: ${data.userEmail}`);
    const registrantName = data.userName;
    const to = data.userEmail;

    // First, calculate the total number of seats the user wants to manually select.
    const totalSeatSelection = data.tickets.reduce((total, ticket) => total + (ticket.seatQuantity || 0), 0);

    const ticketSummary = data.tickets.map(ticket => `${ticket.quantity}x ${ticket.name} Ticket`).join(', ');
    const seatSelectionLink = `https://www.apcsmusic.com/select-seat?token=${data.seatSelectionToken}`;

    let mailOptions;


    const ticketAdsonSummary = data.tickets
        .filter(ticket => ticket.seatQuantity > 0)
        .map(ticket => `${ticket.seatQuantity}x Seat Selection for ${ticket.name}`)
        .join(', ');
    try {
        if (totalSeatSelection > 0) {
            // --- CASE 1: User WANTS to select their seats ---
            // The email will contain the "Select Your Seat" button.

            mailOptions = {
                from: '"APCS Music" <hello@apcsmusic.com>',
                // TODO : update to use real TO email
                to: "renaldolouis555@gmail.com",
                subject: `Your APCS Booking Confirmation & Seat Selection`,
                html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <style>
                            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
                            .email-wrapper { width: 100%; background-color: #f4f4f4; }
                            .email-container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; }
                            .header {color: #333333; text-align: center; }
                            .content { padding: 30px; line-height: 1.6; color: #555555; }
                            .content p { margin: 0 0 20px 0; }
                            .content h3 { color: #333333; margin-top: 30px; margin-bottom: 15px; border-bottom: 1px solid #eeeeee; padding-bottom: 5px; }
                            .booking-details { background-color: #f9f9f9; border: 1px solid #eeeeee; padding: 20px; border-radius: 5px; margin-bottom: 25px; }
                            .booking-details div { margin-bottom: 10px; }
                            .booking-details strong { color: #333333; width: 120px; display: inline-block; }
                            .cta-button { display: inline-block; background-color: #e5cc92; color: #2c3e50; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px; }
                            .footer { text-align: center; font-size: 12px; color: #7f8c8d; padding: 20px; }
                        </style>
                    </head>
                    <body>
                        <div class="email-wrapper">
                            <div class="email-container">
                                <div class="header">
                                    <div style="width: 100%;background: black;">
                                        <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" style="display: block; height: auto; border: 0; width: 50%; max-width: 400px; margin: 0 auto;" alt="APCS Logo" title="APCS Logo">
                                    </div>
                                </div>
                                <div class="content">
                                    <p>Dear <strong>${registrantName}</strong>,</p>
                                    <p>Thank you for your booking! We have successfully received your order details and are excited for you to join us at the event.</p>
                                    
                                    <h3>Your Booking Details</h3>
                                    <div class="booking-details">
                                        <div><strong>Venue:</strong> ${data.venue}</div>
                                        <div><strong>Date:</strong> ${data.date ? new Date(data.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'N/A'}</div>
                                        <div><strong>Session:</strong> ${data.session || 'N/A'}</div>
                                        <div><strong>Tickets:</strong> ${ticketSummary}</div>
                                        <div><strong>Seating Tickets:</strong> ${ticketAdsonSummary}</div>
                                    </div>

                                    <h3>Select Your Seats</h3>
                                    <p>As part of your order, you've chosen to select your specific seats. Please click the button below to open the seating map and make your selection. This will ensure you get the best spot available!</p>
                                    <p style="text-align:center; margin-top: 30px; margin-bottom: 30px;">
                                        <a href="${seatSelectionLink}" target="_blank" class="cta-button">
                                            Click Here to Select Your Seat
                                        </a>
                                    </p>
                                    <p style="font-size: 12px; text-align: center; color: #777;">Please note: This link is unique to you and will expire in 7 days.</p>
                                    
                                    <p style="margin-top: 30px;">If you have any questions, please don't hesitate to contact us.</p>
                                    <p>Best regards,<br>The APCS Music Team</p>
                                </div>
                                <div class="footer">
                                    <p>&copy; ${new Date().getFullYear()} APCS Music</p>
                                </div>
                            </div>
                        </div>
                    </body>
                    </html>
                    `
            };

        } else {
            // --- CASE 2: User does NOT want to select seats ---
            // A new version of the email is sent.

            mailOptions = {
                from: '"APCS Music" <hello@apcsmusic.com>',
                // TODO : update to use real TO email
                to: "renaldolouis555@gmail.com",
                subject: `Your APCS Booking Confirmation & Seat Selection`,
                html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <style>
                            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
                            .email-wrapper { width: 100%; background-color: #f4f4f4; }
                            .email-container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; }
                            .header {color: #333333; text-align: center; }
                            .content { padding: 30px; line-height: 1.6; color: #555555; }
                            .content p { margin: 0 0 20px 0; }
                            .content h3 { color: #333333; margin-top: 30px; margin-bottom: 15px; border-bottom: 1px solid #eeeeee; padding-bottom: 5px; }
                            .booking-details { background-color: #f9f9f9; border: 1px solid #eeeeee; padding: 20px; border-radius: 5px; margin-bottom: 25px; }
                            .booking-details div { margin-bottom: 10px; }
                            .booking-details strong { color: #333333; width: 120px; display: inline-block; }
                            .cta-button { display: inline-block; background-color: #e5cc92; color: #2c3e50; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 16px; }
                            .footer { text-align: center; font-size: 12px; color: #7f8c8d; padding: 20px; }
                        </style>
                    </head>
                    <body>
                        <div class="email-wrapper">
                            <div class="email-container">
                                <div class="header">
                                    <div style="width: 100%;background: black;">
                                        <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" style="display: block; height: auto; border: 0; width: 50%; max-width: 400px; margin: 0 auto;" alt="APCS Logo" title="APCS Logo">
                                    </div>
                                </div>
                                <div class="content">
                                    <p>Dear <strong>${registrantName}</strong>,</p>
                                    <p>Thank you for your booking! We have successfully received your order details and are excited for you to join us at the event.</p>
                                    
                                    <h3>Your Booking Details</h3>
                                    <div class="booking-details">
                                        <div><strong>Venue:</strong> ${data.venue}</div>
                                        <div><strong>Date:</strong> ${data.date ? new Date(data.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'N/A'}</div>
                                        <div><strong>Session:</strong> ${data.session || 'N/A'}</div>
                                        <div><strong>Tickets:</strong> ${ticketSummary}</div>
                                        <div><strong>Seating Tickets:</strong> ${ticketAdsonSummary}</div>
                                    </div>

                                    <h3>Your Seat Assignment</h3>
                                    <p>Your seat(s) will be assigned to you automatically. You will receive a separate email for your seat number(s) on <strong>October 29, 2025</strong>.</p>
                                    
                                    <p style="margin-top: 30px;">If you have any questions, please don't hesitate to contact us.</p>
                                    <p>Best regards,<br>The APCS Music Team</p>
                                </div>
                                <div class="footer">
                                    <p>&copy; ${new Date().getFullYear()} APCS Music</p>
                                </div>
                            </div>
                        </div>
                    </body>
                    </html>
                    `
            };
        }

        // Send whichever email was prepared
        await transporter.sendMail(mailOptions);
        logger.info(`Successfully sent booking email to ${to}`);

    } catch (error) {
        logger.error(`Failed to send booking email to ${to}: ${error.message}`);
        throw error;
    }
}

const sendEmailConfirmSeatSelection = async (bookingData, selectedSeatLabels) => {
    logger.info(`Sending seat confirmation email to: ${bookingData.userEmail}`);
    const registrantName = bookingData.userName;
    const to = bookingData.userEmail;

    // Format the list of selected seats for display
    const seatSummary = selectedSeatLabels.join(', ');

    try {
        const mailOptions = {
            from: '"APCS Music" <hello@apcsmusic.com>',
            // TODO : update to use real TO email
            to: "renaldolouis555@gmail.com",
            subject: `Your E-Ticket for the APCS Event is Here!`,
            html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <style>
                            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
                            .email-wrapper { width: 100%; background-color: #f4f4f4; }
                            .email-container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; }
                            .header {color: #333333; text-align: center; }
                            .content { padding: 30px; line-height: 1.6; color: #555555; }
                            .content p { margin: 0 0 20px 0; }
                            .content h3 { color: #333333; margin-top: 30px; margin-bottom: 15px; border-bottom: 1px solid #eeeeee; padding-bottom: 5px; }
                            .booking-details { background-color: #f9f9f9; border: 1px solid #eeeeee; padding: 20px; border-radius: 5px; margin-bottom: 25px; }
                            .booking-details div { margin-bottom: 10px; }
                            .booking-details strong { color: #333333; width: 140px; display: inline-block; }
                            .seats-confirmed { font-size: 18px; font-weight: bold; color: #27ae60; }
                            .footer { text-align: center; font-size: 12px; color: #7f8c8d; padding: 20px; }
                            .e-ticket { border: 2px dashed #EBBC64; padding: 20px; border-radius: 8px; margin-top: 30px; text-align: left; }
                            .e-ticket h2 { text-align: center; color: #EBBC64; margin-top: 0; }
                        </style>
                    </head>
                    <body>
                        <div class="email-wrapper">
                            <div class="email-container">
                                <div class="header">
                                    <div style="width: 100%;background: black;">
                                        <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" style="display: block; height: auto; border: 0; width: 50%; max-width: 400px; margin: 0 auto;" alt="APCS Logo" title="APCS Logo">
                                    </div>
                                </div>
                                <div class="content">
                                    <p>Dear <strong>${registrantName}</strong>,</p>
                                    <p>Your seat selection is confirmed! This email is your official E-Ticket. Please present it at the venue entrance for verification.</p>

                                    <div class="e-ticket">
                                        <h2>Your E-Ticket / Entry Pass</h2>
                                        <div class="booking-details" style="background-color: #fff; margin-bottom: 0;">
                                            <div><strong>Booking ID:</strong> ${bookingData.id}</div>
                                            <div><strong>Name:</strong> ${registrantName}</div>
                                            <hr style="border: 1px solid #eee; margin: 10px 0;">
                                            <div><strong>Venue:</strong> ${bookingData.venue}</div>
                                            <div><strong>Date:</strong> ${bookingData.date ? new Date(bookingData.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'N/A'}</div>
                                            <div><strong>Session:</strong> ${bookingData.session || 'N/A'}</div>
                                            <div class="seats-confirmed"><strong>Seats:</strong> ${seatSummary}</div>
                                        </div>
                                    </div>
                                
                                    <p style="margin-top: 30px;">We look forward to seeing you at the event!</p>
                                    <p>Best regards,<br>The APCS Music Team</p>
                                </div>
                                <div class="footer">
                                    <p>&copy; ${new Date().getFullYear()} APCS Music</p>
                                </div>
                            </div>
                        </div>
                    </body>
                    </html>
                `
        };

        const result = await transporter.sendMail(mailOptions);
        logger.info(`Successfully sent seat confirmation email to ${to}`);
        return result;
    } catch (error) {
        logger.error(`Failed to send seat confirmation email to ${to}: ${error.message}`);
        throw error;
    }
}

const sendGeneralSeatingEmail = async (bookingData) => {
    logger.info(`Sending E-Ticket email to: ${bookingData.userEmail}`);
    const registrantName = bookingData.userName;
    const to = bookingData.userEmail;

    let subject = 'Your APCS Gala Concert E-Ticket & Seating Information';
    let seatingInfoText = '';

    // Check if specific seats have been assigned and create the summary text
    if (bookingData.selectedSeats && bookingData.selectedSeats.length > 0) {
        subject = '✅ Your APCS Gala Concert Seats are Confirmed!';
        seatingInfoText = bookingData.selectedSeats.map(seatId => {
            return seatId.split('_')[0].split('-').slice(1).join('-'); // Extracts "F11" from "lento-F11_..."
        }).join(', ');
    } else {
        seatingInfoText = 'General Seating';
    }

    try {
        const mailOptions = {
            from: '"APCS Music" <hello@apcsmusic.com>',
            //TODO: Update to real email
            to: "renaldolouis555@gmail.com",
            subject: subject,
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="utf-8">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4; }
                        .email-wrapper { width: 100%; background-color: #f4f4f4; padding: 20px 0; }
                        .email-container { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; }
                        .header { line-height: 0; }
                        .content { padding: 30px; line-height: 1.6; color: #555555; }
                        .content p { margin: 0 0 16px 0; }
                        .content h3 { color: #333333; margin-top: 25px; margin-bottom: 15px; }
                        .e-ticket { border: 2px dashed #EBBC64; padding: 20px; border-radius: 8px; margin-top: 25px; text-align: left; }
                        .e-ticket h2 { text-align: center; color: #EBBC64; margin-top: 0; margin-bottom: 20px; }
                        .booking-details div { margin-bottom: 10px; font-size: 16px; }
                        .booking-details strong { color: #333333; }
                        .seats-info { font-size: 18px; font-weight: bold; color: #27ae60; }
                        .footer { text-align: center; font-size: 12px; color: #7f8c8d; padding: 20px; }
                    </style>
                </head>
                <body>
                    <div class="email-wrapper">
                        <div class="email-container">
                            <div class="header">
                                <div style="width: 100%; background: black;">
                                    <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" alt="APCS Logo" style="display: block; height: auto; border: 0; width: 50%; max-width: 400px; margin: 0 auto;">
                                </div>
                            </div>
                            <div class="content">
                                <p>Dear <strong>${registrantName}</strong>,</p>
                                <p>Your tickets for the APCS Gala Concert are confirmed! This email is your official E-Ticket. Please present it at the venue entrance for verification.</p>
                                
                                <div class="e-ticket">
                                    <h2>Your E-Ticket / Entry Pass</h2>
                                    <div class="booking-details" style="background-color: #fff; margin: 0; padding: 0; border: none;">
                                        <div><strong>Booking ID:</strong> ${bookingData.id}</div>
                                        <div><strong>Name:</strong> ${registrantName}</div>
                                        <hr style="border: 0; border-top: 1px solid #eeeeee; margin: 15px 0;">
                                        <div><strong>Venue:</strong> ${bookingData.venue}</div>
                                        <div><strong>Date:</strong> ${new Date(bookingData.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
                                        <div><strong>Session:</strong> ${bookingData.session}</div>
                                        <div class="seats-info"><strong>Seats:</strong> ${seatingInfoText}</div>
                                    </div>
                                </div>
                                
                                <p style="margin-top: 30px;">We look forward to seeing you at the event!</p>
                                <p>Best regards,<br>The APCS Music Team</p>
                            </div>
                            <div class="footer">
                                <p>&copy; ${new Date().getFullYear()} APCS Music</p>
                            </div>
                        </div>
                    </div>
                </body>
                </html>
            `
        };

        await transporter.sendMail(mailOptions);
        logger.info(`Successfully sent E-Ticket to ${to}`);
        return true;
    } catch (error) {
        logger.error(`Failed to send E-Ticket to ${to}: ${error.message}`);
        return false;
    }
}

const sendEmailNotifyApcs = async (data) => {
    logger.info(`Sending internal notification for: ${data.name}`);

    try {
        const mailOptions = {
            from: '"APCS Registration System" <hello@apcsmusic.com>', // Sender name is helpful
            to: "hello@apcsmusic.com", // Sending to your own company
            subject: `New Registration: ${data.name} - ${data.competitionCategory}`,
            html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <style>
                            /* Basic styles for email clients */
                            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
                            .container { width: 100%; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9; border-radius: 8px; }
                            .header { background-color: #2c3e50; color: #ffffff; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
                            .content { padding: 30px; background-color: #ffffff; }
                            .info-item { margin-bottom: 15px; font-size: 16px; }
                            .info-item strong { color: #34495e; }
                            .footer { text-align: center; font-size: 12px; color: #7f8c8d; margin-top: 20px;}
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="header">
                                <h1>New Event Registration</h1>
                            </div>
                            <div class="content">
                                <p style="font-size: 18px;">A new participant has registered for an APCS 2025 event.</p>
                                <hr>
                                <div class="info-item">
                                    <strong>Participant Name:</strong> ${data.name}
                                </div>
                                <div class="info-item">
                                    <strong>Email:</strong> <a href="mailto:${data.email}" style="color: #3498db;">${data.email}</a>
                                </div>
                                <div class="info-item">
                                    <strong>Competition Category:</strong> ${data.competitionCategory || 'N/A'}
                                </div>
                                <div class="info-item">
                                    <strong>Instrument:</strong> ${data.instrumentCategory || 'N/A'}
                                </div>
                                <div class="info-item">
                                    <strong>Registration Time:</strong> ${new Date().toUTCString()}
                                </div>
                            </div>
                            <div class="footer">
                                <p>&copy; ${new Date().getFullYear()} APCS Music. This is an automated notification.</p>
                            </div>
                        </div>
                    </body>
                    </html>
                    `
        };

        const result = await transporter.sendMail(mailOptions);
        logger.info(`Successfully sent internal notification for ${data.name}`);
        return result;
    } catch (error) {
        logger.error(`Failed to send internal notification: ${error.message}`);
        throw error;
    }
};

const sendEmailNotifyBulkUpdateRegistrant = async (data) => {
    // --- NEW LOGIC TO HANDLE SINGLE OR MULTIPLE NAMES ---
    let greetingName = 'Participant';
    const teacherName = data.teacherName;
    const to = data.email

    console.log("data.names", data.names)

    // if (data.names && data.names.length > 1) {
    // If there are multiple names, create a list
    greetingName = 'Teacher/Parent'; // Or a more generic greeting
    const participantListHtml = `
        <p style="margin: 0 0 16px 0; text-align:justify;">
            Welcome to the APCS Family! We are pleased to confirm your registration for The Sound of Asia. We look forward to seeing you on the APCS stage as we celebrate music, culture, and extraordinary talent from around the world.
        </p>
        <p style="margin: 0 0 16px 0; text-align:justify;">
            <strong>Registered Students</strong>:
        </p>
        <ul style="padding-left: 20px;">
            ${data.names.map(name => `<li>${name}</li>`).join('')}
        </ul>
    `;
    // } else {
    //     // If there is only one name, use it directly
    //     greetingName = data.names[0] || 'Participant';
    //     participantListHtml = `
    //         <p style="margin: 0 0 16px 0; text-align:justify;">
    //             Welcome to the APCS Family! We are pleased to confirm your registration for <strong>The Sound of Asia</strong>. 
    //         </p>
    //     `;
    // }
    // --- END OF NEW LOGIC ---

    try {
        const mailOptions = {
            from: "hello@apcsmusic.com",
            to: to,
            subject: "APCS Registration Confirmation",
            html: `<!DOCTYPE html>
            <html xmlns:v="
            urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">

            <head>
                <title></title>
                <meta http-equiv="Content-Type" content="text/html; charset=utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0"><!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--><!--[if !mso]><!-->
                <link href="https://fonts.googleapis.com/css?family=Open+Sans" rel="stylesheet" type="text/css"><!--<![endif]-->
                <style>
                    * {
                        box-sizing: border-box;
                    }

                    body {
                        margin: 0;
                        padding: 0;
                    }

                    a[x-apple-data-detectors] {
                        color: inherit !important;
                        text-decoration: inherit !important;
                    }

                    #MessageViewBody a {
                        color: inherit;
                        text-decoration: none;
                    }

                    p {
                        line-height: inherit
                    }

                    .desktop_hide,
                    .desktop_hide table {
                        mso-hide: all;
                        display: none;
                        max-height: 0px;
                        overflow: hidden;
                    }

                    .image_block img+div {
                        display: none;
                    }

                    sup,
                    sub {
                        font-size: 75%;
                        line-height: 0;
                    }

                    .menu_block.desktop_hide .menu-links span {
                        mso-hide: all;
                    }

                    @media (max-width:700px) {

                        .desktop_hide table.icons-inner,
                        .social_block.desktop_hide .social-table {
                            display: inline-block !important;
                        }

                        .icons-inner {
                            text-align: center;
                        }

                        .icons-inner td {
                            margin: 0 auto;
                        }

                        .mobile_hide {
                            display: none;
                        }

                        .row-content {
                            width: 100% !important;
                        }

                        .stack .column {
                            width: 100%;
                            display: block;
                        }

                        .stackFooter{
                            width: 50% !important;
                            display: table-cell !important
                        }

                        .mobile_hide {
                            min-height: 0;
                            max-height: 0;
                            max-width: 0;
                            overflow: hidden;
                            font-size: 0px;
                        }

                        .desktop_hide,
                        .desktop_hide table {
                            display: table !important;
                            max-height: none !important;
                        }

                        .reverse {
                            display: table;
                            width: 100%;
                        }

                        .reverse .column.first {
                            display: table-footer-group !important;
                        }

                        .reverse .column.last {
                            display: table-header-group !important;
                        }

                        .row-5 td.column.first .border {
                            padding: 0;
                            border-top: 0;
                            border-right: 0px;
                            border-bottom: 0;
                            border-left: 0;
                        }

                        .row-5 td.column.last .border {
                            padding: 25px 0 0;
                            border-top: 0;
                            border-right: 0px;
                            border-bottom: 0;
                            border-left: 0;
                        }
                    }
                </style><!--[if mso ]><style>sup, sub { font-size: 100% !important; } sup { mso-text-raise:10% } sub { mso-text-raise:-10% }</style> <![endif]-->
            </head>

            <body class="body" style="background-color: #fbfcfc; margin: 0; padding: 0; -webkit-text-size-adjust: none; text-size-adjust: none;">
                <table class="nl-container" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: #fbfcfc;">
                    <tbody>
                        <tr>
                            <td>
                                <table class="row row-4" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stack" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="50%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-top: 30px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="paragraph_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Georgia,Times,'Times New Roman',serif;font-size:24px;line-height:120%;text-align:left;mso-line-height-alt:28.799999999999997px;">
                                                                                <div style="max-width: 126.667px;"><img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" style="display: block; border-radius:16px; height: auto; border: 0; width: 100%;" width="126.667" alt="APCS Logo" title="APCS Logo" height="auto"></div>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="paragraph_block block-3" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad" style="padding-top:4px;">
                                                                            <div style="font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:14px;line-height:1.6;text-align:left;">
                                                                                <p style="margin: 0 0 16px 0;"><em>Dear <strong>${teacherName}</strong>,</em></p>

                                                                                ${participantListHtml}

                                                                                <p style="margin: 0 0 16px 0; text-align-last:justify; text-align:justify;">
                                                                                    (Kindly review the list and let us know if any names or spellings need updating.)<br><br>
                                                                                    All winners will be notified via email, so please stay tuned. <strong>The Sapphire Winner</strong> will be announced live on stage during the APCS event, and we’re excited to celebrate every outstanding performance.
                                                                                </p>  

                                                                                <p style="margin: 0 0 16px 0;">
                                                                                    Thank you for being a part of this incredible experience.
                                                                                </p>  

                                                                                <p style="margin: 0 0 16px 0;">
                                                                                    We can’t wait to welcome you at the event!
                                                                                </p>  
                                                                                <p style="margin: 0;">Warm regards,<br><strong>The APCS Team</strong></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-9" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stackFooter" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: black; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td class="column column-1" width="50%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 10px; padding-left: 10px; padding-right: 20px; padding-top: 10px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="image_block block-1" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad" style="padding-right:30px;padding-top:10px;width:100%;">
                                                                            <div class="alignment" align="left" style="line-height:10px;text-align:left;">
                                                                                <div style="max-width: 126.667px;"><img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/apcs_logo_white_background_black.png" style="display: block; border-radius:16px; height: auto; border: 0; width: 100%;" width="126.667" alt="APCS Logo" title="APCS Logo" height="auto"></div>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="social_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad" style="padding-left:0px;">
                                                                            <div class="alignment" align="left">
                                                                                <table class="social-table" width="108px" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; display: inline-block;">
                                                                                    <tr>
                                                                                        <td style="padding:0px 4px 0px 0px; background:transparent; border-radius:35px;">
                                                                                            <a href="https://www.youtube.com/@apcsmusic" target="_blank">
                                                                                                <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/icon-youtubewhite.png" width="32" height="auto" alt="YouTube" title="youtube" style="border-radius:35px;display: block; height: auto; border: 0;">
                                                                                            </a>
                                                                                        </td>
                                                                                        <td style="padding:0px 4px 0px 4px; background:transparent; border-radius:35px;">
                                                                                            <a href="https://www.instagram.com/apcs.music" target="_blank">
                                                                                                <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/icon-instagram.png" width="32" height="auto" alt="Instagram" title="instagram" style="border-radius:35px;display: block; height: auto; border: 0;">
                                                                                            </a>
                                                                                        </td>
                                                                                        <td style="padding:0px 4px 0px 4px; background:transparent; border-radius:35px;">
                                                                                            <a href="https://api.whatsapp.com/send/?phone=6282213002686" target="_blank">
                                                                                                <img src="https://apcsgalery.s3.ap-southeast-1.amazonaws.com/assets/icon-whatsapp.png" width="32" height="auto" alt="WhatsApp" title="whatsapp" style="border-radius:35px;display: block; height: auto; border: 0;">
                                                                                            </a>
                                                                                        </td>
                                                                                    </tr>
                                                                                </table>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                            <td class="column column-2" width="50%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; padding-bottom: 30px; padding-left: 10px; padding-right: 10px; padding-top: 20px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="paragraph_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#ffffff;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:14px;line-height:120%; mso-line-height-alt:16.8px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;"><strong><span style="word-break: break-word;">Contact Us</span></strong></span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="paragraph_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:12px;line-height:120%;mso-line-height-alt:14.399999999999999px;">
                                                                                <p style="margin: 0; word-break: break-word;">
                                                                                    <a href="https://www.apcsmusic.com/" style="color: #ffffff; text-decoration: none;" target="_blank">
                                                                                        apcsmusic.com
                                                                                    </a>
                                                                                </p>                                                                                
                                                                                <p style="margin: 0; word-break: break-word;">
                                                                                    <a href="mailto:hello@apcsmusic.com" style="color: #ffffff; text-decoration: none;">
                                                                                        hello@apcsmusic.com
                                                                                    </a>
                                                                                </p>                                                                                
                                                                                <p style="margin: 0;margin-top:4px; word-break: break-word;"><span style="word-break: break-word; color: #ffffff;">(+62) 822-1300-2686</span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <table class="row row-9" align="center" width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                    <tbody>
                                        <tr>
                                            <td>
                                                <table class="row-content stackFooter" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; background-color: black; color: #000000; width: 680px; margin: 0 auto;" width="680">
                                                    <tbody>
                                                        <tr>
                                                            <td colspan="1" width="100%" align="left" style="padding: 0px 0px 10px 10px; text-align: left; color: #ffffff; font-family: Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1.5;">
                                                                ©️ 2025 APCS Music, All rights reserved.
                                                            </td>
                                                        </tr>
                                                    </tbody>
                                                </table>
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                            </td>
                        </tr>
                    </tbody>
                </table><!-- End -->
            </body>

            </html>`,
        };

        const result = await transporter.sendMail(mailOptions);
        logger.info(`Successfully sent email to ${to}`);
        return result;
    } catch (error) {
        logger.error(`Failed to send email to ${to}: ${error.message}`);
        throw error; // rethrow to allow Bull to handle retries
    }
};


/**
 * Creates a secure, signed JWT for a registrant's ticket.
 * @param {string} registrantId - The Firestore document ID of the registrant.
 * @param {string} eventId - An identifier for the event (e.g., "APCS2025").
 * @returns {string} The generated JSON Web Token.
 */
async function generateTicketToken(registrantId, eventId) {
    const payload = {
        registrantId: registrantId,
        eventId: eventId,
    };

    // The token will be valid for 1 year. Adjust as needed.
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '365d' });

    return token;
};


async function sendETicketEmail(registrantData) {
    // 1. Generate the unique token
    const token = generateTicketToken(registrantData.id, "APCS2025");

    // 2. Create the check-in URL that the QR code will point to
    const checkinUrl = `https://www.yourwebsite.com/check-in?ticket=${token}`;

    try {
        // 3. Generate the QR code image from the URL
        const qrCodeDataUrl = await qrcode.toDataURL(checkinUrl);

        const mailOptions = {
            from: '"APCS Music" <hello@apcsmusic.com>',
            to: registrantData.email,
            subject: 'Your E-Ticket for the APCS Event',
            html: `
                <!DOCTYPE html>
                <html>
                <body>
                    <h1>Here is your E-Ticket</h1>
                    <p>Dear ${registrantData.name},</p>
                    <p>Please present this QR code at the event entrance for check-in.</p>
                    
                    <img src="${qrCodeDataUrl}" alt="Your E-Ticket QR Code">
                    
                    <p>We look forward to seeing you!</p>
                </body>
                </html>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log(`E-Ticket sent successfully to ${registrantData.email}`);

    } catch (error) {
        console.error("Failed to send e-ticket:", error);
    }
};

// Process email queue with concurrency of 3
emailQueue.process(3, processEmailQueue);

async function sendEmail(req) {
    try {
        const emailsArray = req.body;
        if (Array.isArray(emailsArray) && emailsArray.length > 0) {
            // Bulk add email jobs to the queue
            // enqueueBulkEmails(emailsArray);
            for (const data of emailsArray) {
                sendEmailFunc(data);
            }
            logger.info(`Enqueued ${emailsArray.length} email jobs successfully`);
        } else {
            logger.warn("No emails provided to enqueue");
        }
        return { message: "Emails have been enqueued successfully" };
    } catch (error) {
        logger.error(`Failed to enqueue email jobs: ${error.message}`);
        throw error;
    }
}

async function sendEmailWinner(req) {
    const winners = req.body;

    logger.info("sending email winner...");

    try {
        if (winners.length === 0) {
            logger.info("No winners found. Exiting.");
            return;
        }

        logger.info(`Found ${winners.length} winners to email.`);

        // Loop through each winner and send an email
        for (const winner of winners) {
            const winnerName = winner['Name'];
            const winnerEmail = winner['Email'];
            const winnerAwards = winner['AWARDS'];

            const data = {
                name: winnerName,
                email: winnerEmail,
                award: winnerAwards
            }

            console.log('data', data)

            if (data) {
                await sendEmailWinnerFunc(data);
                // Add a short delay between emails to avoid being flagged as spam
                await new Promise(resolve => setTimeout(resolve, 250)); // 1-second delay
            }
        }

        logger.info("🎉 Email campaign finished!");

    } catch (error) {
        logger.error("An error occurred during the campaign:", error);
    }
}

async function sendEmailSessionWinner(req) {
    const winners = req.body;

    logger.info("sending email winner Session...");

    try {
        if (winners.length === 0) {
            logger.info("No winners found. Exiting.");
            return;
        }

        logger.info(`Found ${winners.length} winners to email.`);

        // Loop through each winner and send an email
        for (const winner of winners) {
            const winnerName = winner['Name'];
            const winnerEmail = winner['Email'];

            const data = {
                name: winnerName,
                email: winnerEmail
            }

            console.log('data', data)

            if (data) {
                await sendEmailWinnerSessionFunc(data);
                // Add a short delay between emails to avoid being flagged as spam
                await new Promise(resolve => setTimeout(resolve, 250)); // 1-second delay
            }
        }

        logger.info("🎉 Email campaign finished!");

    } catch (error) {
        logger.error("An error occurred during the campaign:", error);
    }
}

async function sendEmailMarketing(req) {
    try {
        const emailsArray = req.body;
        if (Array.isArray(emailsArray) && emailsArray.length > 0) {
            // Bulk add email jobs to the queue
            // enqueueBulkEmails(emailsArray);
            for (const data of emailsArray) {
                sendEmailWinnerFunc(data);
            }
            logger.info(`Enqueued ${emailsArray.length} email jobs successfully`);
        } else {
            logger.warn("No emails provided to enqueue");
        }
        return { message: "Emails have been enqueued successfully" };
    } catch (error) {
        logger.error(`Failed to enqueue email jobs: ${error.message}`);
        throw error;
    }
}


async function sendEmailPaymentRequestFunc(req) {
    try {
        const emailsArray = req.body;
        if (Array.isArray(emailsArray) && emailsArray.length > 0) {
            // Bulk add email jobs to the queue
            // enqueueBulkEmails(emailsArray);
            for (const data of emailsArray) {
                sendEmailPaymentRequest(data);
            }
            logger.info(`Enqueued ${emailsArray.length} email jobs successfully`);
        } else {
            logger.warn("No emails provided to enqueue");
        }
        return { message: "Emails have been enqueued successfully" };
    } catch (error) {
        logger.error(`Failed to enqueue email jobs: ${error.message}`);
        throw error;
    }
}

async function sendSeatBookingEmailFunc(req) {
    try {
        const emailsArray = req.body;
        logger.info(`sending seat link email to ${emailsArray.length}`);
        sendSeatBookingEmail(emailsArray);
        logger.info(`Send to ${emailsArray.userName} email successfully`);
        // if (Array.isArray(emailsArray) && emailsArray.length > 0) {
        //     // Bulk add email jobs to the queue
        //     // enqueueBulkEmails(emailsArray);
        //     for (const data of emailsArray) {
        //         sendSeatBookingEmail(data);
        //     }
        //     logger.info(`Enqueued ${emailsArray.length} email jobs successfully`);
        // } else {
        //     logger.warn("No emails provided to enqueue");
        // }
        return { message: "Emails have been enqueued successfully" };
    } catch (error) {
        logger.error(`Failed to enqueue email jobs: ${error.message}`);
        throw error;
    }
}

// TODO: remove might not be used
async function sendEmailConfirmSeatSelectionFunc(req) {
    const bookingData = req.body;

    try {
        logger.info(`sending seat confirmation email to ${bookingData.userEmail}`);
        sendEmailConfirmSeatSelection(bookingData, bookingData.selectedSeatLabels);
        logger.info(`Send to ${bookingData.userEmail}.userName} email successfully`);
        return { message: "Emails have been enqueued successfully" };
    } catch (error) {
        logger.error(`Failed to enqueue email jobs: ${error.message}`);
        throw error;
    }
}

async function sendGeneralSeatingEmailFunc(req) {
    const bookingData = req.body;

    try {
        logger.info(`sending General seat confirmation email to ${bookingData.userEmail}`);
        sendGeneralSeatingEmail(bookingData);
        logger.info(`Send to ${bookingData.userEmail}.userName} email successfully`);
        return { message: "Emails have been enqueued successfully" };
    } catch (error) {
        logger.error(`Failed to enqueue email jobs: ${error.message}`);
        throw error;
    }
}


async function sendEmailETicketFunc(req) {
    try {
        const emailsArray = req.body;
        if (Array.isArray(emailsArray) && emailsArray.length > 0) {
            // Bulk add email jobs to the queue
            // enqueueBulkEmails(emailsArray);
            for (const data of emailsArray) {
                sendETicketEmail(data);
            }
            logger.info(`Enqueued ${emailsArray.length} email jobs successfully`);
        } else {
            logger.warn("No emails provided to enqueue");
        }
        return { message: "Emails have been enqueued successfully" };
    } catch (error) {
        logger.error(`Failed to enqueue email jobs: ${error.message}`);
        throw error;
    }
}

async function sendEmailNotifyApcsFunc(req) {
    try {
        const emailsArray = req.body;
        if (Array.isArray(emailsArray) && emailsArray.length > 0) {
            // Bulk add email jobs to the queue
            // enqueueBulkEmails(emailsArray);
            for (const data of emailsArray) {
                sendEmailNotifyApcs(data);
            }
            logger.info(`Enqueued ${emailsArray.length} email jobs successfully`);
        } else {
            logger.warn("No emails provided to enqueue");
        }
        return { message: "Emails have been enqueued successfully" };
    } catch (error) {
        logger.error(`Failed to enqueue email jobs: ${error.message}`);
        throw error;
    }
}

async function sendEmailNotifyBulkUpdateRegistrantFunc(req) {
    try {
        const emailsArray = req.body;
        if (Array.isArray(emailsArray) && emailsArray.length > 0) {
            // Bulk add email jobs to the queue
            // enqueueBulkEmails(emailsArray);
            for (const data of emailsArray) {
                sendEmailNotifyBulkUpdateRegistrant(data);
            }
            logger.info(`Enqueued ${emailsArray.length} email jobs successfully`);
        } else {
            logger.warn("No emails provided to enqueue");
        }
        return { message: "Emails have been enqueued successfully" };
    } catch (error) {
        logger.error(`Failed to enqueue email jobs: ${error.message}`);
        throw error;
    }
}
module.exports = {
    sendEmail,
    sendEmailWinner,
    sendEmailSessionWinner,
    enqueueEmailJob,
    enqueueBulkEmails,
    sendEmailMarketing,
    sendEmailMarketingFunc,
    sendEmailPaymentRequestFunc,
    sendSeatBookingEmailFunc,
    sendEmailConfirmSeatSelectionFunc,
    sendGeneralSeatingEmailFunc,
    sendEmailNotifyApcsFunc,
    sendEmailNotifyBulkUpdateRegistrantFunc,
    sendEmailETicketFunc,
};
