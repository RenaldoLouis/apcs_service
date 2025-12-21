const express = require('express')
const router = express.Router();
const PaperController = require("../controllers/PaperController");

router.post('/createInvoice', PaperController.createInvoice);
router.post('/webhooks/paper-id', PaperController.handlePaperWebhook);

module.exports = router;