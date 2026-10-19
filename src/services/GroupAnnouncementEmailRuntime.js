const nodemailer = require('nodemailer');
const { db } = require('../configs/firebase-init');
const { smtpConfig } = require('../configs/emailConfig');
const { createService } = require('./GroupAnnouncementEmailService');

const workerEnabled = process.env.APCS_GROUP_EMAIL_WORKER_ENABLED === 'true'
    && process.env.APCS_FIRESTORE_MODE !== 'emulator';
const transport = nodemailer.createTransport({ ...smtpConfig, pool: false,
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 45000 });
const service = createService({ db, workerEnabled, sendMail: options => transport.sendMail(options) });
module.exports = { service, workerEnabled };
