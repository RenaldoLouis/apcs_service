const nodemailer = require('nodemailer');
const { db } = require('../configs/firebase-init');
const { smtpConfig } = require('../configs/emailConfig');
const { createService } = require('../services/ScoringResultEmailService');

const transporter = nodemailer.createTransport({ ...smtpConfig, connectionTimeout: 20000,
    greetingTimeout: 20000, socketTimeout: 45000, pool: false });
const service = createService({ db, sendMail: options => transporter.sendMail(options) });

const controller = {};
for (const operation of ['preview', 'send', 'test']) {
    controller[operation] = async (req, res, next) => {
        try {
            res.json(await service[operation](req.body || {}, req.ticketingAdmin));
        } catch (error) {
            next(error);
        }
    };
}
module.exports = controller;
