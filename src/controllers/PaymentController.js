const payment = require('../services/PaymentService.js');
const { validationResult } = require('express-validator');

async function createPayment(req, res, next) {
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

        const data = await payment.createPayment(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function getInboundDeliveries(req, res, next) {
    try {
        const data = await payment.getInboundDeliveries()
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

module.exports = {
    createPayment,
    getInboundDeliveries
};