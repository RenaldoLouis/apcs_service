const express = require('express')
const router = express.Router();
const userController = require("../controllers/UserController");
const { bodyUserValidation, idUserValidation } = require('../utils/ValidationUtil');


router.get('/users', userController.getUsers)
router.get('/users/:id', userController.getUserById)
router.post('/users', bodyUserValidation, userController.create)
router.put('/users/:id', [idUserValidation, bodyUserValidation], userController.update)
router.delete('/users/:id', idUserValidation, userController.remove)

module.exports = router;