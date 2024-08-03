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

const inboundDeliveryBodyValidation = [
    body('organic_weight').notEmpty().withMessage("organic weight must be filled"),
    body('rejected_weight').notEmpty().withMessage("rejected weight must be filled"),
    body('inorganic_weight').notEmpty().withMessage("inorganic weight must be filled"),
    body('license_plate').notEmpty().withMessage("license plate must be filled!")
]

const wasteBodyValidation = [
    body('inbound_delivery_id').notEmpty().withMessage("inbound_delivery_id must be filled"),
]

module.exports = {
    bodyUserValidation,
    idUserValidation,
    inboundDeliveryBodyValidation,
    wasteBodyValidation
}

