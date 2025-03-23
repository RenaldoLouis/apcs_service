const express = require('express')
const router = express.Router();
const paymentController = require("../controllers/PaymentController");
const EmailController = require("../controllers/EmailController");
const FirebaseController = require("../controllers/FirebaseController");
const RegisterController = require("../controllers/RegisterController");
const { paymentValidation } = require('../utils/ValidationUtil');

router.post('/createPayment', paymentValidation, paymentController.createPayment)
router.post('/sendEmail', EmailController.sendEmail)
router.get('/getGaleries', FirebaseController.getGaleries)
router.get('/getVideos', FirebaseController.getVideos)
router.post('/register', RegisterController.postRegistrant)
router.post('/signed-url-images', RegisterController.getUploadUrl)
// router.get('/inboundDelivery', paymentController.getInboundDeliveries)

module.exports = router;