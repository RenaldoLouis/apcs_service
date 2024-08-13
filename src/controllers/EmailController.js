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
module.exports = {
    sendEmail
};