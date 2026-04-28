const PublicTicketRepository = require('../repositories/PublicTicketRepository');
const databaseUtil = require('../utils/DatabaseUtil');

async function getPublicTicketEventData() {
    return databaseUtil.executeDatabaseOperation(PublicTicketRepository.getPublicTicketEventData, null);
}

async function createPublicTicketBooking(req) {
    const body = req.body;
    return databaseUtil.executeDatabaseOperation(PublicTicketRepository.createPublicTicketBooking, body);
}

// Called directly (not via databaseUtil) because it's triggered by the webhook handler
async function handlePublicTicketWebhookPaid(bookingId, payloadData) {
    return PublicTicketRepository.handlePublicTicketWebhookPaid(bookingId, payloadData);
}

async function getPublicTicketSeats(query) {
    return databaseUtil.executeDatabaseOperation(PublicTicketRepository.getPublicTicketSeats, query);
}

module.exports = {
    getPublicTicketEventData,
    createPublicTicketBooking,
    handlePublicTicketWebhookPaid,
    getPublicTicketSeats,
};
