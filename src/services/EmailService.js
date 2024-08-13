
const db = require('../repositories/PaymentRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');
const { logger } = require('../utils/Logger');

async function sendEmail(req) {
    const body = req.body;
    try {
        // return await databaseUtil.executeDatabaseOperation(db.createPayment, body);
        return {
            message: "email"
        };
    } catch (error) {
        throw error;
    }
}

module.exports = {
    sendEmail
};