const { body } = require('express-validator');
const { validateRequest } = require('./Validator');

const multipartUploadValidation = [
    body('directoryname').trim().notEmpty().withMessage('Directory name is required'),
    body('fileName').trim().notEmpty().withMessage('File name is required'),
    body('fileType').optional().trim(),
    validateRequest
];

const partUploadValidation = [
    body('directoryname').trim().notEmpty().withMessage('Directory name is required'),
    body('fileName').trim().notEmpty().withMessage('File name is required'),
    body('uploadId').trim().notEmpty().withMessage('Upload ID is required'),
    body('partNumber').isInt({ min: 1, max: 10000 }).withMessage('Valid part number is required'),
    validateRequest
];

const completeUploadValidation = [
    body('directoryname').trim().notEmpty().withMessage('Directory name is required'),
    body('fileName').trim().notEmpty().withMessage('File name is required'),
    body('uploadId').trim().notEmpty().withMessage('Upload ID is required'),
    body('parts').isArray({ min: 1 }).withMessage('Parts array is required'),
    body('parts.*.ETag').notEmpty().withMessage('Each part must have an ETag'),
    body('parts.*.PartNumber').isInt({ min: 1 }).withMessage('Each part must have a valid PartNumber'),
    validateRequest
];

// Use module.exports instead of export
module.exports = {
    multipartUploadValidation,
    partUploadValidation,
    completeUploadValidation
};