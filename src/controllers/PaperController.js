const paperService = require('../services/PaperService.js');
const { validationResult } = require('express-validator');

async function createInvoice(req, res, next) {
    try {
        const data = await paperService.createInvoice(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

module.exports = {
    createInvoice,
};