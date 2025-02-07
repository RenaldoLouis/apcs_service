
const db = require('../repositories/FirebaseRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');

async function getGaleries(req) {
    const body = req.body;
    try {
        return await databaseUtil.executeDatabaseOperation(db.getGaleries, body);
    } catch (error) {
        throw error;
    }
}

module.exports = {
    getGaleries
};