
const moment = require('moment/moment.js');
const db = require('../repositories/WasteRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');

async function createNewWaste(req) {
    try {
        const body = req.body;
        body.simple_id = Math.floor(Math.random() * 1000000000);;

        const newWaste = await databaseUtil.executeDatabaseOperation(db.createNewWaste, body);

        body.waste_id = newWaste.id;
        body.next_checked_date = moment().add(2, 'day')
        return await databaseUtil.executeDatabaseOperation(db.createNewWasteLog, body);
    } catch (error) {
        throw error;
    }
}

async function getAllWaste() {
    try {
        return await databaseUtil.executeDatabaseOperation(db.getAllWaste);
    } catch (error) {
        throw error;
    }
}

async function getWasteById(req) {
    try {
        const id = req.params.id;
        return await databaseUtil.executeDatabaseOperation(db.getWasteById, id);
    } catch (error) {
        throw error;
    }
}

module.exports = {
    createNewWaste,
    getAllWaste,
    getWasteById
};