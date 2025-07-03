const BookingService = require('../services/BookingService');
const { validationResult } = require('express-validator');

async function createBooking(req, res, next) {
    try {
        const data = await BookingService.createBooking(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function getBookingStatus(req, res, next) {
    try {
        const data = await BookingService.getBookingStatus(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

module.exports = {
    createBooking,
    getBookingStatus
};