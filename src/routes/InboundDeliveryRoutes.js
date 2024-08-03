const express = require('express')
const router = express.Router();
const inboundDeliveryController = require("../controllers/InboundDeliveryController");
const { inboundDeliveryBodyValidation } = require('../utils/ValidationUtil');

router.post('/inboundDelivery', inboundDeliveryBodyValidation, inboundDeliveryController.createInboundDelivery)
router.get('/inboundDelivery', inboundDeliveryController.getInboundDeliveries)

module.exports = router;