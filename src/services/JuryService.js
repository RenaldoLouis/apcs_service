
const { AppError } = require('../middlewares/ErrorHandlerMiddleware.js');
const db = require('../repositories/JuryRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');

async function createJury(req) {
    const body = req.body;
    try {
        return await databaseUtil.executeDatabaseOperation(db.createJury, body);
    } catch (error) {
        throw error;
    }
}

module.exports = {
    createJury
};