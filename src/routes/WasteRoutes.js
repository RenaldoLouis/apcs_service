const express = require('express')
const router = express.Router();
const wasteControler = require("../controllers/WasteController");
const { idUserValidation, wasteBodyValidation } = require('../utils/ValidationUtil');

router.post('/waste', wasteBodyValidation, wasteControler.createNewWaste)
router.get('/waste', wasteControler.getAllWaste)
router.get('/waste/:id', idUserValidation, wasteControler.getWasteById)

module.exports = router;