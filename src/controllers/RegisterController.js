const registerService = require('../services/RegisterService');
const { validationResult } = require('express-validator');

async function postRegistrant(req, res, next) {
    try {
        const data = await registerService.postRegistrant(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function getUploadUrl(req, res, next) {
    try {
        const data = await registerService.getUploadUrl(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

module.exports = {
    postRegistrant,
    getUploadUrl,
};