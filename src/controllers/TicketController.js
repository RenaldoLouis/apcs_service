const TicketService = require('../services/ticketService');

async function verifyTicket(req, res, next) {
    try {
        const data = await TicketService.verifyTicket(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

module.exports = {
    verifyTicket
};