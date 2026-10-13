const repository = require('../repositories/TicketRedemptionRepository');

const list = async (req, res, next) => {
    try { res.json(await repository.list(req.body)); } catch (error) { next(error); }
};
const detail = async (req, res, next) => {
    try { res.json(await repository.detail(req.body)); } catch (error) { next(error); }
};
const claim = async (req, res, next) => {
    try { res.json(await repository.claim(req.body, req.ticketingAdmin)); } catch (error) { next(error); }
};

module.exports = { list, detail, claim };
