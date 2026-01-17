// config/emailConfig.js
require('dotenv').config();

const redisConfig = {
    redis: {
        host: process.env.REDIS_HOST || "127.0.0.1",
        port: process.env.REDIS_PORT || 6379,
        // password: process.env.REDIS_PASSWORD
    },
    limiter: {
        max: 5,
        duration: 1000 // 5 emails per second
    }
};

const smtpConfig = {
    pool: true,
    maxConnections: 10,
    connectionTimeout: 120000,
    socketTimeout: 120000,
    service: "Gmail", // Or use host/port for other providers
    host: "smtp-relay.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
};

module.exports = { redisConfig, smtpConfig };