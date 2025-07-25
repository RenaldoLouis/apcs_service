const express = require('express')
const router = express.Router();
const paymentController = require("../controllers/PaymentController");
const EmailController = require("../controllers/EmailController");
const FirebaseController = require("../controllers/FirebaseController");
const RegisterController = require("../controllers/RegisterController");
const BookingController = require("../controllers/BookingController");
const { paymentValidation } = require('../utils/ValidationUtil');

router.post('/createPayment', paymentValidation, paymentController.createPayment)
router.post('/sendEmail', EmailController.sendEmail)
router.post('/sendEmailWinner', EmailController.sendEmailWinner)
router.post('/sendEmailMarketing', EmailController.sendEmailMarketing)
router.post('/sendEmailPaymentRequest', EmailController.sendEmailPaymentRequest)
router.post('/sendEmailNotifyApcs', EmailController.sendEmailNotifyApcs)
router.get('/getGaleries', FirebaseController.getGaleries)
router.get('/getVideos', FirebaseController.getVideos)
router.post('/register', RegisterController.postRegistrant)
router.post('/signed-url-images', RegisterController.getUploadUrl)
router.post('/download-files-aws', RegisterController.downloadFilesAws)
router.post('/bookings', BookingController.createBooking)
router.get('/bookings/status', BookingController.getBookingStatus)
// router.get('/inboundDelivery', paymentController.getInboundDeliveries)

module.exports = router;