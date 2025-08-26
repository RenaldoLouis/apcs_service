const TicketService = require('../services/ticketService');

async function verifyTicket(req, res, next) {
    try {
        const data = await TicketService.verifyTicket(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}
async function saveSeatBookProfileInfo(req, res, next) {
    try {
        const data = await TicketService.saveSeatBookProfileInfo(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}
async function verifySeatSelectionToken(req, res, next) {
    try {
        const data = await TicketService.verifySeatSelectionToken(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}
async function confirmSeatSelection(req, res, next) {
    try {
        const data = await TicketService.confirmSeatSelection(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

module.exports = {
    verifyTicket,
    saveSeatBookProfileInfo,
    verifySeatSelectionToken,
    confirmSeatSelection
};