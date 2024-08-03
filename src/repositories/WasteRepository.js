const pool = require('../configs/DbConfig');

const createNewWaste = (params, callback) => {
    const { inbound_delivery_id, simple_id } = params

    pool.query(`
        INSERT INTO waste (inbound_delivery_id,simple_id) 
        VALUES ($1, $2) 
        RETURNING *`, [inbound_delivery_id, simple_id], (error, results) => {
        if (error) {
            return callback(error);
        }
        if (results.rowCount === 1 && results.rows[0].id) {
            return callback(null, results.rows[0]);
        }

        return callback(new Error('Failed to create inbound delivery'));
    })
}

const createNewWasteLog = (params, callback) => {
    const { next_checked_date, waste_id, humidity_types, curr_waste_status, next_waste_status, curr_storage_area_id, next_storage_area_id, weight, volume, temperature, note } = params

    pool.query(`
        INSERT INTO waste_logs (next_checked_date,waste_id,humidity_types,curr_waste_status,next_waste_status,curr_storage_area_id,next_storage_area_id,weight,volume,temperature,note) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) 
        RETURNING *`, [next_checked_date, waste_id, humidity_types, curr_waste_status, next_waste_status, curr_storage_area_id, next_storage_area_id, weight, volume, temperature, note], (error, results) => {
        if (error) {
            return callback(error);
        }
        if (results.rowCount === 1 && results.rows[0].id) {
            return callback(null, results.rows[0]);
        }

        return callback(new Error('Failed to create inbound delivery'));
    })
}

const getAllWaste = (callback) => {
    pool.query(`
        select * from 
        waste w 
        left join (
            select max(id) as id from waste_logs wl 
            group by wl.waste_id 
        ) wl on w.id = wl.id 
        left join waste_logs wl2 on wl.id = wl2.id 
        `, (error, results) => {
        if (error) {
            return callback(error);
        }

        return callback(null, results.rows);
    })
}

const getWasteById = (id, callback) => {
    pool.query(`
        select * from 
        waste w 
        left join (
            select max(id) as id from waste_logs wl 
            group by wl.waste_id 
        ) wl on w.id = wl.id 
        left join waste_logs wl2 on wl.id = wl2.id 
        where w.id = $1
        `, [id], (error, results) => {
        if (error) {
            return callback(error);
        }

        return callback(null, results.rows);
    })
}

module.exports = {
    createNewWaste,
    createNewWasteLog,
    getAllWaste,
    getWasteById
}