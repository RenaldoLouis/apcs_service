const pool = require('../configs/DbConfig');
const { InboundDeliveryDto } = require('../models/InboundDeliveryModel');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const { combine, timestamp, printf, colorize, align, json, errors } = winston.format;

const errorFilter = winston.format((info, opts) => {
    return info.level === 'error' ? info : false;
});

const infoFilter = winston.format((info, opts) => {
    return info.level === 'info' ? info : false;
});

const logger = winston.createLogger({
    level: "info",
    format: combine(errors({ stack: true }), timestamp(), json()),
    transports: [
        new DailyRotateFile({
            filename: 'logs/combined-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d'
        }),
        new DailyRotateFile({
            filename: 'logs/app-error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'error',
            format: combine(errorFilter(), timestamp(), json())
        }),
        new DailyRotateFile({
            filename: 'logs/app-info-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'info',
            format: combine(infoFilter(), timestamp(), json())
        })
    ]
});

const createPayment = (params, callback) => {
    const { amount, currency, payment_method, confirmation_method, confirm } = params
    logger.info('Info message');

    // pool.query(`
    //     INSERT INTO inbound_deliveries (rejected_weight, organic_weight, inorganic_weight, hard_organic_weight, license_plate, note) 
    //     VALUES ($1, $2, $3, $4, $5, $6) 
    //     RETURNING *`, [rejected_weight, organic_weight, inorganic_weight, hard_organic_weight, license_plate, note], (error, results) => {
    //     if (error) {
    //         return callback(error);
    //     }
    //     if (results.rowCount === 1 && results.rows[0].id) {
    // return callback(null, results.rows[0]);
    logger.error(new Error("an error"));

    return callback(null, []);
    // }

    // return callback(new Error('Failed to create inbound delivery'));
    // })
}

const getInboundDeliveries = (callback) => {
    pool.query(`
        SELECT * FROM inbound_deliveries`, (error, results) => {
        if (error) {
            return callback(error);
        }

        return callback(null, results.rows);
    })
}

module.exports = {
    createPayment,
    getInboundDeliveries
}