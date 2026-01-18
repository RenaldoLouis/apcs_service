
const { AppError } = require('../middlewares/ErrorHandlerMiddleware.js');
const db = require('../repositories/RegistrantRepository.js');
const databaseUtil = require('../utils/DatabaseUtil.js');

async function postRegistrant(req) {
    const body = req.body;
    try {
        return await databaseUtil.executeDatabaseOperation(db.postRegistrant, body);
    } catch (error) {
        throw error;
    }
}

async function getUploadUrl(req) {
    const query = req.query;
    try {
        return await databaseUtil.executeDatabaseOperation(db.getUploadUrl, query);
    } catch (error) {
        throw error;
    }
}

async function downloadFilesAws(params, res) {
    try {
        await db.downloadFilesAws(params, res); // Call it correctly
    } catch (error) {
        throw error;
    }
}

async function downloadAllFiles(params, res) {
    try {
        await db.downloadAllFiles(params, res); // Call it correctly
    } catch (error) {
        throw error;
    }
}

async function getPublicVideoLinkAws(req) {
    const body = req.body;
    try {
        return await databaseUtil.executeDatabaseOperation(db.getPublicVideoLinkAws, body);
    } catch (error) {
        throw error;
    }
}

async function initiateMultipartUpload(params) {
    const { directoryname, fileName, fileType } = params;

    // Business logic validation
    if (!directoryname || !fileName) {
        throw new AppError('Missing required parameters', 400);
    }

    const result = await db.initiateMultipartUpload({
        directoryname,
        fileName,
        fileType: fileType || 'video/mp4'
    });

    return result;
}

async function getPartUploadUrl(params) {
    const { directoryname, fileName, uploadId, partNumber } = params;

    if (!uploadId || !partNumber) {
        throw new AppError('Upload ID and part number are required', 400);
    }

    const result = await db.getPartUploadUrl({
        directoryname,
        fileName,
        uploadId,
        partNumber
    });

    return result;
}

async function completeMultipartUpload(params) {
    const { directoryname, fileName, uploadId, parts } = params;

    if (!uploadId || !parts || parts.length === 0) {
        throw new AppError('Upload ID and parts are required', 400);
    }

    // Validate parts structure
    const validParts = parts.every(part => part.ETag && part.PartNumber);
    if (!validParts) {
        throw new AppError('Invalid parts structure', 400);
    }

    const result = await db.completeMultipartUpload({
        directoryname,
        fileName,
        uploadId,
        parts
    });

    return result;
}

module.exports = {
    postRegistrant,
    getUploadUrl,
    downloadFilesAws,
    downloadAllFiles,
    getPublicVideoLinkAws,
    initiateMultipartUpload,
    getPartUploadUrl,
    completeMultipartUpload
};