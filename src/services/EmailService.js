
const db = require('../repositories/PaymentRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');
const nodemailer = require("nodemailer");
const Queue = require('bull');
const { logger } = require('../utils/Logger');

const defaultJobOptions = {
    removeOnComplete: true,
    removeOnFail: false
};

const redisConfig = {
    redis: {
        path: '/home/apcc8119/tmp/redis.sock'
    }
};

/* DONT FORGET TO REVERT THE CONFIG */
// for local dev only 
// const redisConfig = {
//     redis: {
//         host: "127.0.0.1",
//         port: 6379
//     }
// };

const emailQueue = new Queue('emailQueue', redisConfig, { defaultJobOptions });

const transporter = nodemailer.createTransport({
    service: "Gmail",
    host: "smtp-relay.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true, // Enforces TLS
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

const sendNewEmail = async (data) => {
    logger.info(`sending email To...${data.email}`);
    emailQueue.add({ data });
};

const processEmailQueue = async (job) => {
    try {
        // transporter.verify((error, success) => {
        //     if (error) {
        //         console.error("SMTP Connection Error:", error);
        //     } else {
        //         console.log("SMTP Connection Successful!");
        //     }
        // });
        const { data } = job; // Extract the data object from the job
        const to = data.data.email
        const participant = data.data.name
        const mailOptions = {
            // from: '"Hello APCS" <hello@apcsmusic.com>',  // Explicitly set sender name
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
                {   // use URL as an attachment
                    filename: 'license.txt',
                    path: 'https://raw.github.com/nodemailer/nodemailer/master/LICENSE'
                },
            ]
        };
        const result = await new Promise((resolve, reject) => {
            transporter.sendMail(mailOptions, (error, info) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(info);
                }
            });
        });

        logger.info(`Successfully sent email to ${to}`);
        console.log(`Message sent to ${to}`);
        console.log("Message sent: %s", result.messageId);
        console.log("Preview URL: %s", nodemailer.getTestMessageUrl(result));
        return result;
    } catch (error) {
        logger.error(`Failed to send email to ${to}: ${error.message}`);
        throw error;
    }
}

emailQueue.process(3, processEmailQueue);

async function sendEmail(req) {
    const body = req.body;

    for (const data of body) {
        await sendNewEmail(data); // Wait for each email to be added to the queue
    }

    try {
        const result = { message: "Emails sent successfully" };
        return result;
    } catch (error) {
        logger.error(`Failed to send email: ${error.message}`);
        throw error;
    }
}

module.exports = {
    sendEmail
};