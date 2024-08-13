const express = require('express')
const router = express.Router();
const paymentController = require("../controllers/PaymentController");
const EmailController = require("../controllers/EmailController");
const { paymentValidation } = require('../utils/ValidationUtil');

router.post('/createPayment', paymentValidation, paymentController.createPayment)
router.post('/sendEmail', EmailController.sendEmail)
// router.get('/inboundDelivery', paymentController.getInboundDeliveries)

module.exports = router;