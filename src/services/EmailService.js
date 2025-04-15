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
            subject: "APCS Gala Concert 2024 - Winner Announcement",
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
                                                            <td class="column column-1" width="50%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; font-weight: 400; text-align: left; background-color: #f2f1eb; padding-left: 20px; padding-top: 30px; vertical-align: top; border-top: 0px; border-right: 0px; border-bottom: 0px; border-left: 0px;">
                                                                <table class="paragraph_block block-1" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Georgia,Times,'Times New Roman',serif;font-size:24px;line-height:120%;text-align:left;mso-line-height-alt:28.799999999999997px;">
                                                                                <p style="margin: 0; word-break: break-word;"><span style="word-break: break-word;">Find Your Space</span></p>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="divider_block block-2" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div class="alignment" align="left">
                                                                                <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="30%" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt;">
                                                                                    <tr>
                                                                                        <td class="divider_inner" style="font-size: 1px; line-height: 1px; border-top: 3px solid #BBBBBB;"><span style="word-break: break-word;">&#8202;</span></td>
                                                                                    </tr>
                                                                                </table>
                                                                            </div>
                                                                        </td>
                                                                    </tr>
                                                                </table>
                                                                <table class="paragraph_block block-3" width="100%" border="0" cellpadding="10" cellspacing="0" role="presentation" style="mso-table-lspace: 0pt; mso-table-rspace: 0pt; word-break: break-word;">
                                                                    <tr>
                                                                        <td class="pad">
                                                                            <div style="color:#393d47;font-family:Open Sans, Helvetica Neue, Helvetica, Arial, sans-serif;font-size:14px;line-height:1.6;text-align:left;">
                                                                                <p style="margin: 0 0 16px 0;"><em>Dear ${participant},</em></p>

                                                                                <p style="margin: 0 0 16px 0;">
                                                                                    Welcome to the APCS Family! We are pleased to confirm your registration for <strong>The Sound of Asia</strong>. 
                                                                                    We look forward to seeing you on the APCS stage as we celebrate music, culture, and extraordinary talent from around the world. 🎹🌍
                                                                                </p>

                                                                                <p style="margin: 0 0 16px 0;">
                                                                                    All winners will be notified via email, so please stay tuned. The <strong>Sapphire Winner</strong> will be announced live on stage during the APCS event, 
                                                                                    and we’re excited to celebrate every outstanding performance.
                                                                                </p>

                                                                                <p style="margin: 0 0 16px 0;">
                                                                                    Thank you for being a part of this incredible experience.<br>
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

module.exports = {
    sendEmail,
    // Expose enqueue functions if needed for testing or further extensions
    enqueueEmailJob,
    enqueueBulkEmails
};
