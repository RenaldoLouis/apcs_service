const { body, param } = require('express-validator');

// Define validation rules for creating a user
const bodyUserValidation = [
    body('name').notEmpty().withMessage('Name is required'),
    body('email').notEmpty().withMessage('Email is required'),
    body('email').isEmail().withMessage('Invalid email address'),
];

const idUserValidation = [
    param('id', 'id must be number!').isNumeric(),
    param('id', 'id has to be filled!').notEmpty(),
];

const paymentValidation = [
    body('amount').notEmpty().withMessage("amount must be filled"),
    body('currency').notEmpty().withMessage("currency must be filled"),
    body('payment_method').notEmpty().withMessage("payment_method must be filled"),
    body('confirmation_method').notEmpty().withMessage("confirmation_method must be filled!"),
    body('confirm').notEmpty().withMessage("confirm must be filled!")
]

const wasteBodyValidation = [
    body('inbound_delivery_id').notEmpty().withMessage("inbound_delivery_id must be filled"),
]

module.exports = {
    bodyUserValidation,
    idUserValidation,
    paymentValidation,
    wasteBodyValidation
}

