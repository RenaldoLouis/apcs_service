
const db = require('../repositories/BookingRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');

async function createBooking(req) {
    const body = req.body;
    try {
        return await databaseUtil.executeDatabaseOperation(db.createBooking, body);
    } catch (error) {
        throw error;
    }
}

async function getBookingStatus(req) {
    const query = req.query;
    try {
        return await databaseUtil.executeDatabaseOperation(db.getBookingStatus, query);
    } catch (error) {
        throw error;
    }
}

module.exports = {
    createBooking,
    getBookingStatus,
};