const PublicTicketRepository = require('../repositories/PublicTicketRepository');
const databaseUtil = require('../utils/DatabaseUtil');

async function getPublicTicketEventData() {
    return databaseUtil.executeDatabaseOperation(PublicTicketRepository.getPublicTicketEventData, null);
}

async function createPublicTicketBooking(req) {
    const body = req.body;
    return databaseUtil.executeDatabaseOperation(PublicTicketRepository.createPublicTicketBooking, body);
}

async function getPublicTicketSeats(query) {
    return databaseUtil.executeDatabaseOperation(PublicTicketRepository.getPublicTicketSeats, query);
}

async function getEligibleWinners(query) {
    return databaseUtil.executeDatabaseOperation(PublicTicketRepository.getEligibleWinners, query);
}

module.exports = {
    getPublicTicketEventData,
    createPublicTicketBooking,
    getPublicTicketSeats,
    getEligibleWinners,
};
