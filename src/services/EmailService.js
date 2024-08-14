
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

const emailQueue = new Queue('emailQueue', redisConfig, { defaultJobOptions });

const transporter = nodemailer.createTransport({
    service: "Gmail",
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
        user: "renaldolouis555@gmail.com",
        pass: "obim loxb nwll dukt",
    },
});

const mailOptions = {
    from: "renaldolouis555@gmail.com",
    to: "vayneaurelius5@gmail.com",
    subject: "Hello from Nodemailer",
    text: "This is a test email sent using Nodemailer.",
};

const sendNewEmail = async (email) => {
    logger.info(`sending email To...${email.to}`);
    emailQueue.add({ ...email });
};

const processEmailQueue = async (job) => {
    try {
        const { to } = job.data;
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
        console.log("Message sent: %s", result.messageId);
        console.log("Preview URL: %s", nodemailer.getTestMessageUrl(result));
        return result;
    } catch (error) {
        logger.error(`Failed to send email to ${to}: ${error.message}`);
        throw error;
    }
}

emailQueue.process(processEmailQueue);

async function sendEmail(req) {
    const body = req.body;

    await sendNewEmail(mailOptions);

    console.log("Added to queue");

    // Wrap the sendMail function in a Promise
    // const sendMailPromise = new Promise((resolve, reject) => {
    //     transporter.sendMail(mailOptions, (error, info) => {
    //         if (error) {
    //             reject({ message: "email Fail2" });
    //         } else {
    //             resolve({ message: "email Succes2" });
    //         }
    //     });
    // });

    try {
        // await the result of the sendMailPromise
        // logger.info(`Succes send email To...${mailOptions.to}`);
        // const result = await sendMailPromise;

        const result = { message: "email Sent" };
        return result;
    } catch (error) {
        logger.error(`Failed send email To...${mailOptions.to}`);
        throw error;
    }
}

module.exports = {
    sendEmail
};