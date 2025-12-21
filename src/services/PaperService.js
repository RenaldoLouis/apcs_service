
const { AppError } = require('../middlewares/ErrorHandlerMiddleware.js');
const db = require('../repositories/PaperRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');

async function createInvoice(req) {
    const body = req.body;
    try {
        return await databaseUtil.executeDatabaseOperation(db.createInvoice, body);
    } catch (error) {
        throw error;
    }
}

module.exports = {
    createInvoice
};