
const db = require('../repositories/InboundDeliveryRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');

async function createInboundDelivery(req) {
    const body = req.body;
    try {
        return await databaseUtil.executeDatabaseOperation(db.createInboundDelivery, body);
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
    createInboundDelivery,
    getInboundDeliveries
};