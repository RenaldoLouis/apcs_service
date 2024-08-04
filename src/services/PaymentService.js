
const db = require('../repositories/PaymentRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');

async function createPayment(req) {
    const body = req.body;
    try {
        return await databaseUtil.executeDatabaseOperation(db.createPayment, body);
    } catch (error) {
        throw error;
    }
}

async function getInboundDeliveries() {
    try {
        return await databaseUtil.executeDatabaseOperation(db.getInboundDeliveries);
    } catch (error) {
        throw error;
    }
}

module.exports = {
    createPayment,
    getInboundDeliveries
};