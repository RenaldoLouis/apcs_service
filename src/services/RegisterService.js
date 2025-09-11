
const db = require('../repositories/RegistrantRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');

async function postRegistrant(req) {
    const query = req.query;
    try {
        return await databaseUtil.executeDatabaseOperation(db.postRegistrant, query);
    } catch (error) {
        throw error;
    }
}

async function getUploadUrl(req) {
    const query = req.query;
    try {
        return await databaseUtil.executeDatabaseOperation(db.getUploadUrl, query);
    } catch (error) {
        throw error;
    }
}

async function downloadFilesAws(params, res) {
    try {
        await db.downloadFilesAws(params, res); // Call it correctly
    } catch (error) {
        throw error;
    }
}

async function downloadAllFiles(params, res) {
    try {
        await db.downloadAllFiles(params, res); // Call it correctly
    } catch (error) {
        throw error;
    }
}

module.exports = {
    postRegistrant,
    getUploadUrl,
    downloadFilesAws,
    downloadAllFiles
};