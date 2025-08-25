
const db = require('../repositories/TicketRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');

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

module.exports = {
    verifyTicket,
    saveSeatBookProfileInfo
};