const wasteService = require('../services/WasteService.js');
const { validationResult } = require('express-validator');

async function createNewWaste(req, res, next) {
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

        const data = await wasteService.createNewWaste(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function getAllWaste(req, res, next) {
    try {
        const data = await wasteService.getAllWaste()
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function getWasteById(req, res, next) {
    try {
        const data = await wasteService.getWasteById(req)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

module.exports = {
    createNewWaste,
    getAllWaste,
    getWasteById
};