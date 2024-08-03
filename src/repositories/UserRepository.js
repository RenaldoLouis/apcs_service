const dbConfig = require('../configs/DbConfig');
const { getCreateUserResponseDTO } = require('../models/UserModel');
const pool = require('../configs/DbConfig')

const getUsers = (callback) => {
    pool.query('SELECT * FROM users ORDER BY id ASC', (error, results) => {
        if (error) {
            return callback(error);
        }
        return callback(null, results.rows);
    });
};

const getUserById = (id, callback) => {

    pool.query('SELECT * FROM users WHERE id = $1', [id], (error, results) => {
        if (error) {
            return callback(error);
        }
        return callback(null, results.rows);
    })
};

const createUser = (params, callback) => {
    const { name, email } = params

    pool.query('INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id,name,email', [name, email], (error, results) => {
        if (error) {
            return callback(error);
        }
        if (results.rowCount === 1 && results.rows[0].id) {
            return callback(null, getCreateUserResponseDTO(results.rows[0]));
        } else {
            return callback(new Error('Failed to create user'));
        }
    })
}

const updateUser = (id, userData, callback) => {
    const { name, email } = userData

    pool.query(
        'UPDATE users SET name = $1, email = $2 WHERE id = $3 RETURNING id,name,email',
        [name, email, id],
        (error, results) => {
            if (error) {
                return callback(error);
            }
            if (results.rowCount === 1 && results.rows[0].id) {
                return callback(null, getCreateUserResponseDTO(results.rows[0]));
            } else {
                return callback(new Error('Failed to update user'));
            }
        }
    )
}

const deleteUser = (id, callback) => {
    pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [id], (error, results) => {
        if (error) {
            return callback(error);
        }
        if (results.rowCount === 1 && results.rows[0].id) {
            return callback(null, { id: results.rows[0].id });
        } else {
            return callback(new Error('Failed to delete user'));
        }
    })
}

module.exports = {
    getUsers,
    getUserById,
    createUser,
    updateUser,
    deleteUser,
}