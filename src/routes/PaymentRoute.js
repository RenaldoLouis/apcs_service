const express = require('express')
const router = express.Router();
const paymentController = require("../controllers/PaymentController");
const { paymentValidation } = require('../utils/ValidationUtil');

router.post('/createPayment', paymentValidation, paymentController.createPayment)
// router.get('/inboundDelivery', paymentController.getInboundDeliveries)

module.exports = router;