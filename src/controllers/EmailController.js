const payment = require('../services/PaymentService.js');
const email = require('../services/EmailService.js');
const { validationResult } = require('express-validator');

async function sendEmail(req, res, next) {
    try {
        const errorValidation = validationResult(req);
        if (errorValidation.errors.length > 0) {
            let errMessage = "";
            errorValidation.errors.map(q => errMessage += `${q.msg}, `)

            return next({
                statusCode: 400,
                message: errMessage,
            });
        }

        const data = await email.sendEmail(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}
async function sendEmailWinner(req, res, next) {
    try {
        const data = await email.sendEmailWinner(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendEmailMarketing(req, res, next) {
    try {
        const data = await email.sendEmailMarketingFunc(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendEmailPaymentRequest(req, res, next) {
    try {
        const data = await email.sendEmailPaymentRequestFunc(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendEmailNotifyApcs(req, res, next) {
    try {
        const data = await email.sendEmailNotifyApcsFunc(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}
module.exports = {
    sendEmail,
    sendEmailWinner,
    sendEmailMarketing,
    sendEmailPaymentRequest,
    sendEmailNotifyApcs
};