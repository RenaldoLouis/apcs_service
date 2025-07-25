const nodemailer = require("nodemailer");
const Queue = require('bull');
const { logger } = require('../utils/Logger');

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
            // attachments: [
            //     {
            //         filename: 'license.txt',
            //         path: 'https://raw.github.com/nodemailer/nodemailer/master/LICENSE'
            //     },
            // ]
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
                        <strong>Lokasi:</strong> Teater Salihara, Jakarta Selatan
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
                        <strong>Lokasi:</strong> Teater Salihara, Jakarta Selatan
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
module.exports = {
    sendEmail,
    sendEmailWinner,
    enqueueEmailJob,
    enqueueBulkEmails,
    sendEmailMarketing,
    sendEmailMarketingFunc,
    sendEmailPaymentRequestFunc,
    sendEmailNotifyApcsFunc,

};
