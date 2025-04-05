const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const { combine, timestamp, printf, colorize, align, json, errors } = winston.format;

const errorFilter = winston.format((info, opts) => {
    return info.level === 'error' ? info : false;
});

const infoFilter = winston.format((info, opts) => {
    return info.level === 'info' ? info : false;
});

const warnFilter = winston.format((info, opts) => {
    return info.level === 'warn' ? info : false;
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
        }),
        new DailyRotateFile({
            filename: 'logs/app-warn-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            level: 'warn',
            format: combine(warnFilter(), timestamp(), json())
        }),
    ]
});


module.exports = {
    logger
};