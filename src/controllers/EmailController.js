const payment = require('../services/PaymentService.js');
const email = require('../services/EmailService.js');
const { validationResult } = require('express-validator');

async function sendEmail(req, res, next) {
    try {
        const data = await email.sendEmail(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}
async function sendEmailAnnouncement(req, res, next) {
    try {
        const data = await email.sendEmailAnnouncement(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendEmailFail(req, res, next) {
    try {
        const data = await email.sendEmailFail(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendEmailSessionWinner(req, res, next) {
    try {
        const data = await email.sendEmailSessionWinner(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendEmailPaymentRequest(req, res, next) {
    try {
        const data = await email.sendEmailPaymentRequestFunc(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendSeatBookingEmail(req, res, next) {
    try {
        const data = await email.sendSeatBookingEmailFunc(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendGeneralSeatingEmail(req, res, next) {
    try {
        const data = await email.sendGeneralSeatingEmailFunc(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendTeamEntryPassEmail(req, res, next) {
    try {
        const data = await email.sendTeamEntryPassEmail(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendSponsorEntryPassEmail(req, res, next) {
    try {
        const data = await email.sendSponsorEntryPassEmail(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendEmailNotifyApcs(req, res, next) {
    try {
        const data = await email.sendEmailNotifyApcsFunc(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendEmailNotifyBulkUpdateRegistrant(req, res, next) {
    try {
        const data = await email.sendEmailNotifyBulkUpdateRegistrantFunc(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function sendEmailJuryAccountCreation(req, res, next) {
    try {
        const data = await email.sendEmailJuryAccountCreation(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

module.exports = {
    sendEmail,
    sendEmailAnnouncement,
    sendEmailSessionWinner,
    sendEmailPaymentRequest,
    sendSeatBookingEmail,
    sendGeneralSeatingEmail,
    sendTeamEntryPassEmail,
    sendSponsorEntryPassEmail,
    sendEmailNotifyApcs,
    sendEmailNotifyBulkUpdateRegistrant,
    sendEmailFail,
    sendEmailJuryAccountCreation
};