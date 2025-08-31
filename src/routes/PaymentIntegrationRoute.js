const express = require('express')
const router = express.Router();
const BookingController = require("../controllers/BookingController");

router.post('/bookings', BookingController.createBooking)
router.get('/bookings/status', BookingController.getBookingStatus)

module.exports = router;