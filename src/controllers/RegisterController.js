const registerService = require('../services/RegisterService');
const { validationResult } = require('express-validator');

async function postRegistrant(req, res, next) {
    try {
        const data = await registerService.postRegistrant(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function getUploadUrl(req, res, next) {
    try {
        const data = await registerService.getUploadUrl(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function downloadFilesAws(req, res, next) {
    try {
        await registerService.downloadFilesAws(req.body, res);
    } catch (err) {
        next(err);
    }
}

async function downloadAllFiles(req, res, next) {
    try {
        await registerService.downloadAllFiles(req.body, res);
    } catch (err) {
        next(err);
    }
}

async function getPublicVideoLinkAws(req, res, next) {
    try {
        const data = await registerService.getPublicVideoLinkAws(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function initiateMultipartUpload(req, res, next) {
    try {
        const { directoryname, fileName, fileType } = req.body;

        const result = await registerService.initiateMultipartUpload({
            directoryname,
            fileName,
            fileType
        });

        res.status(200).json({
            success: true,
            data: result
        });
    } catch (err) {
        next(err);
    }
}

async function getPartUploadUrl(req, res, next) {
    try {
        const { directoryname, fileName, uploadId, partNumber } = req.body;

        const result = await registerService.getPartUploadUrl({
            directoryname,
            fileName,
            uploadId,
            partNumber: parseInt(partNumber)
        });

        res.status(200).json({
            success: true,
            data: result
        });
    } catch (err) {
        next(err);
    }
}

async function completeMultipartUpload(req, res, next) {
    try {
        const { directoryname, fileName, uploadId, parts } = req.body;

        const result = await registerService.completeMultipartUpload({
            directoryname,
            fileName,
            uploadId,
            parts
        });

        res.status(200).json({
            success: true,
            data: result
        });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    postRegistrant,
    getUploadUrl,
    downloadFilesAws,
    downloadAllFiles,
    getPublicVideoLinkAws,
    initiateMultipartUpload,
    getPartUploadUrl,
    completeMultipartUpload,
};