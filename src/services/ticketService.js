
const db = require('../repositories/TicketRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');
const TicketRepository = require('../repositories/TicketRepository');

async function verifyTicket(req) {
    const body = req.body;
    try {
        return await databaseUtil.executeDatabaseOperation(db.verifyTicket, body);
    } catch (error) {
        throw error;
    }
}
async function saveSeatBookProfileInfo(req) {
    const body = req.body;
    try {
        return await databaseUtil.executeDatabaseOperation(db.saveSeatBookProfileInfo, body);
    } catch (error) {
        throw error;
    }
}
async function verifySeatSelectionToken(req) {
    const body = req.body;
    try {
        return await databaseUtil.executeDatabaseOperation(db.verifySeatSelectionToken, body);
    } catch (error) {
        throw error;
    }
}

async function confirmSeatSelection(req) {
    const body = req.body;
    try {
        // Call the refactored async function directly
        return await TicketRepository.confirmSeatSelection(body);
    } catch (error) {
        // Re-throw the error to the controller
        throw error;
    }
}

module.exports = {
    verifyTicket,
    saveSeatBookProfileInfo,
    verifySeatSelectionToken,
    confirmSeatSelection
};