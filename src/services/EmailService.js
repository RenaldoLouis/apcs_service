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

// Process email queue with concurrency of 3
emailQueue.process(3, processEmailQueue);

async function sendEmail(req) {
    try {
        const emailsArray = req.body;
        if (Array.isArray(emailsArray) && emailsArray.length > 0) {
            // Bulk add email jobs to the queue
            enqueueBulkEmails(emailsArray);
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
