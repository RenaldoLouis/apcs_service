const repository = require('../repositories/OrchestraImportRepository');

async function importPaidOrchestraBookings(req, res, next) {
    try {
        const result = await repository.importPaidOrchestraBookings(req.body, req.ticketingAdmin);
        return res.status(200).json(result);
    } catch (error) {
        return next(error);
    }
}

module.exports = { importPaidOrchestraBookings };
