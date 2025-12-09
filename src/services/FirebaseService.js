
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

async function getVideos(req) {
    const query = req.query;
    try {
        return await databaseUtil.executeDatabaseOperation(db.getVideos, query);
    } catch (error) {
        throw error;
    }
}

async function getSponsors(req) {
    const query = req.query;
    try {
        return await databaseUtil.executeDatabaseOperation(db.getSponsors, query);
    } catch (error) {
        throw error;
    }
}

module.exports = {
    getGaleries,
    getVideos,
    getSponsors
};