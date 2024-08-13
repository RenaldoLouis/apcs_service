
const db = require('../repositories/PaymentRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');
const { logger } = require('../utils/Logger');
const nodemailer = require("nodemailer");

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

async function sendEmail(req) {
    const body = req.body;

    // Wrap the sendMail function in a Promise
    const sendMailPromise = new Promise((resolve, reject) => {
        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                reject({ message: "email Fail" });
            } else {
                resolve({ message: "email" });
            }
        });
    });

    try {
        // await the result of the sendMailPromise
        const result = await sendMailPromise;
        return result;
    } catch (error) {
        throw error;
    }
}

module.exports = {
    sendEmail
};