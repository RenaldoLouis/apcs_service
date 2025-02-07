const firebaseService = require('../services/FirebaseService.js');
const { validationResult } = require('express-validator');

async function getGaleries(req, res, next) {
    try {
        const data = await firebaseService.getGaleries(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

module.exports = {
    getGaleries
};