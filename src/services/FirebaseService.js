
const db = require('../repositories/FirebaseRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');

async function getGaleries(req) {
    const query = req.query;
    try {
        return await databaseUtil.executeDatabaseOperation(db.getGaleries, query);
    } catch (error) {
        throw error;
    }
}

module.exports = {
    getGaleries
};