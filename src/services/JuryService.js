
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

async function updateJury(req) {
    const body = req.body;
    body.uid = req.params.uid; // Extract uid from params
    try {
        return await databaseUtil.executeDatabaseOperation(db.updateJury, body);
    } catch (error) {
        throw error;
    }
}

async function deleteJury(req) {
    const body = req.body;
    body.uid = req.params.uid; // Extract uid from params
    try {
        return await databaseUtil.executeDatabaseOperation(db.deleteJury, body);
    } catch (error) {
        throw error;
    }
}

module.exports = {
    createJury,
    updateJury,
    deleteJury
};