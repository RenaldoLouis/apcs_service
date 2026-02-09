const JuryService = require('../services/JuryService.js');
const { validationResult } = require('express-validator');
const { logger } = require('../utils/Logger.js');
const { db, admin } = require('../configs/firebase-init');

async function createJury(req, res, next) {
    try {
        const data = await JuryService.createJury(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

module.exports = {
    createJury
};