
const db = require('../repositories/UserRepository.js');
const DatabaseUtil = require('../utils/DatabaseUtil.js');

async function getUsers(req, next) {
    try {
        return await DatabaseUtil.executeDatabaseOperation(db.getUsers);
    } catch (error) {
        next(error);
    }
}

async function getByUserId(req, next) {
    const id = req.params.id;
    try {
        return await DatabaseUtil.executeDatabaseOperation(db.getUserById, id);
    } catch (error) {
        next(error);
    }
}

async function createUser(req, next) {
    const body = req.body;
    try {
        return await DatabaseUtil.executeDatabaseOperation(db.createUser, body);
    } catch (error) {
        next(error);
    }
}

async function updateUser(req, next) {
    const id = req.params.id;
    const body = req.body;
    try {
        return await DatabaseUtil.executeDatabaseOperation(db.updateUser, id, body);
    } catch (error) {
        next(error);
    }
}

async function deleteUserById(req, next) {
    const id = req.params.id;
    try {
        return await DatabaseUtil.executeDatabaseOperation(db.deleteUser, id);
    } catch (error) {
        next(error);
    }
}

module.exports = {
    getUsers,
    getByUserId,
    deleteUserById,
    createUser,
    updateUser
};