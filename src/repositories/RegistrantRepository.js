const pool = require('../configs/DbConfig');
const { logger } = require('../utils/Logger');
const { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, CompleteMultipartUploadCommand, UploadPartCommand, CreateMultipartUploadCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const archiver = require('archiver');
const { AppendFilesToZip } = require('../utils/awsDownload');
const axios = require('axios');
const { AppError } = require('../middlewares/ErrorHandlerMiddleware');
const { db, admin } = require('../configs/firebase-init');

const s3Admin = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID_admin,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_admin,
    },
});
const stripS3Prefix = (uri) => uri.split('/').slice(3).join('/');

const getGdriveFileId = (url) => {
    if (!url || typeof url !== 'string') return null;
    let id = null;
    // This regex is designed to find the long, unique ID in a GDrive URL
    const match = url.match(/[-\w]{25,}/);
    if (match) {
        id = match[0];
    }
    return id;
};

const BUCKET_NAME = 'registrants2025';
const URL_EXPIRATION = 300; // 5 minutes


const postRegistrant = async (body, callback) => {
    try {
        const data = body;
        const { recaptchaToken, ...dataToSave } = data;

        // 1. Verify ReCAPTCHA
        const verificationUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${recaptchaToken}`;
        const captchaResponse = await axios.post(verificationUrl);

        if (!captchaResponse.data.success) {
            throw new AppError(
                `Bot detected. Registration failed.`,
                500
            );
        }

        const docRef = await db.collection("Registrants2025").add({
            ...dataToSave,
            createdAt: new Date(),
            // Remove recaptchaToken before saving
        });

        const returnedObject = {
            id: docRef.id
        };

        return callback(null, returnedObject);
    } catch (error) {
        console.error(error);
        return callback(null, error);
    }
}

const getUploadUrl = async (params, callback) => {
    const { directoryname, fileName, fileType } = params;
    const s3Param = {
        Bucket: BUCKET_NAME,
        Key: `${directoryname}/${fileName}`, // Use a unique key
        ContentType: fileType || 'application/octet-stream',
    };

    const command = new PutObjectCommand(s3Param);

    try {
        // Await the signed URL generation
        const signedUrl = await getSignedUrl(s3Admin, command, { expiresIn: 60 });
        const returnedObject = {
            link: signedUrl
        }
        return callback(null, returnedObject);

    } catch (error) {
        console.error('Error generating pre-signed URL:', error);
        return callback(null, error);
    }
}

const downloadFilesAws = async (filesToDownload, res) => {
    // Expects an array like: [{ link: '...', zipPath: '...' }]

    if (!filesToDownload || !Array.isArray(filesToDownload) || filesToDownload.length === 0) {
        return res.status(400).json({ message: "File list is required." });
    }

    try {
        const { wrapper } = await import('axios-cookiejar-support');
        const { CookieJar } = await import('tough-cookie');
        const jar = new CookieJar();
        const client = wrapper(axios.create({ jar }));
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename=documents.zip');

        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        for (const file of filesToDownload) {
            const { link, zipPath } = file;

            // --- THIS IS THE NEW CONDITIONAL LOGIC ---
            if (link.startsWith('s3://')) {
                // --- HANDLE S3 LINKS ---
                try {
                    const command = new GetObjectCommand({
                        Bucket: BUCKET_NAME,
                        Key: stripS3Prefix(link),
                    });
                    const { Body } = await s3Admin.send(command);
                    archive.append(Body, { name: zipPath });
                } catch (s3Error) {
                    console.warn(`Could not download S3 file: ${link}`);
                    archive.append(`S3 file not found: ${zipPath}`, { name: `${zipPath}_ERROR.txt` });
                }

            } else if (link.includes('drive.google.com')) {
                const fileId = getGdriveFileId(link);
                if (fileId) {
                    const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
                    try {
                        // 1. First request: This gets the page with the download warning
                        // and, crucially, saves the confirmation cookie in our 'jar'.
                        await client.get(downloadUrl);

                        // 2. Second request: We make the same request again. This time,
                        // our 'client' automatically sends the cookie back, which proves
                        // we've "seen" the warning, and Google gives us the file stream.
                        const response = await client.get(downloadUrl, {
                            responseType: 'stream'
                        });

                        archive.append(response.data, { name: zipPath });

                    } catch (gdriveError) {
                        console.warn(`Could not download GDrive file: ${link}`);
                        archive.append(`GDrive file not found or is private: ${zipPath}`, { name: `${zipPath}_ERROR.txt` });
                    }
                }
            }
            // --- END OF CONDITIONAL LOGIC ---
        }

        await archive.finalize();

    } catch (error) {
        console.error("Failed to create zip file:", error);
        if (!res.headersSent) res.status(500).send("Failed to generate zip file.");
        else res.end();
    }
};

const getPublicVideoLinkAws = async (body, callback) => {
    const { s3Link } = body;

    // 1. Extract the Key from the s3:// link
    // e.g., s3://bucket/folder/vid.mp4 -> folder/vid.mp4
    const key = s3Link?.replace(`s3://${BUCKET_NAME}/`, '');

    // 2. Use GetObjectCommand (For Viewing/Downloading)
    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
    });

    try {
        // 3. Generate the signed URL
        const signedUrl = await getSignedUrl(s3Admin, command, { expiresIn: 3600 }); // 1 hour link

        const returnedObject = {
            url: signedUrl
        };

        return callback(null, returnedObject);

    } catch (error) {
        console.error('Error generating view URL:', error);
        return callback(error);
    }
};

const downloadAllFiles = async (filesToDownload, res) => {

    if (!filesToDownload || !Array.isArray(filesToDownload) || filesToDownload.length === 0) {
        return res.status(400).json({ message: "File list is required." });
    }

    try {
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename=all_registrants_documents.zip');

        const archive = archiver('zip', { zlib: { level: 9 } });

        // If the client closes the connection, abort the process to save resources
        res.on('close', () => {
            console.log('Client closed connection. Aborting archive.');
            archive.abort();
        });

        archive.on('error', (err) => {
            throw err;
        });

        archive.pipe(res);

        // --- THIS IS THE KEY CHANGE ---
        // Use Promise.all to fetch files from S3 in parallel for better performance
        await Promise.all(
            filesToDownload.map(async (file) => {
                if (file.s3Key) {
                    const command = new GetObjectCommand({
                        Bucket: BUCKET_NAME,
                        Key: file.s3Key,
                    });

                    try {
                        const { Body } = await s3Admin.send(command);
                        if (Body) {
                            // Add the file stream from S3 to the archive
                            archive.append(Body, { name: file.zipPath });
                        }
                    } catch (s3Error) {
                        // Log a warning for a single missing file but don't kill the whole zip
                        console.warn(`Could not find or access S3 object: ${file.s3Key}`, s3Error);
                        // Optionally add a text file to the zip indicating the error
                        archive.append(`Could not download: ${file.s3Key}`, { name: `${file.zipPath}_ERROR.txt` });
                    }
                }
            })
        );
        // --- END OF KEY CHANGE ---

        // Finalize the archive after all files have been appended
        await archive.finalize();

    } catch (error) {
        console.error("Failed to create and stream zip file:", error);
        if (!res.headersSent) {
            res.status(500).send("Failed to generate zip file due to a server error.");
        } else {
            res.end();
        }
    }
};

/**
 * Initiate a multipart upload
 */
async function initiateMultipartUpload(params) {
    const { directoryname, fileName, fileType } = params;

    const command = new CreateMultipartUploadCommand({
        Bucket: BUCKET_NAME,
        Key: `${directoryname}/${fileName}`,
        ContentType: fileType,
    });

    try {
        const response = await s3Admin.send(command);

        if (!response.UploadId) {
            throw new AppError('Failed to initiate multipart upload', 500);
        }

        return {
            uploadId: response.UploadId,
            key: `${directoryname}/${fileName}`
        };
    } catch (error) {
        console.error('S3 multipart upload initiation error:', error);
        throw new AppError(
            `Failed to initiate upload: ${error.message}`,
            error.$metadata?.httpStatusCode || 500
        );
    }
}

/**
 * Get a signed URL for uploading a specific part
 */
async function getPartUploadUrl(params) {
    const { directoryname, fileName, uploadId, partNumber } = params;

    const command = new UploadPartCommand({
        Bucket: BUCKET_NAME,
        Key: `${directoryname}/${fileName}`,
        UploadId: uploadId,
        PartNumber: partNumber,
    });

    try {
        const signedUrl = await getSignedUrl(s3Admin, command, {
            expiresIn: URL_EXPIRATION
        });

        return {
            link: signedUrl,
            partNumber,
            expiresIn: URL_EXPIRATION
        };
    } catch (error) {
        console.error('S3 part upload URL generation error:', error);
        throw new AppError(
            `Failed to generate upload URL for part ${partNumber}: ${error.message}`,
            error.$metadata?.httpStatusCode || 500
        );
    }
}

/**
 * Complete a multipart upload
 */
async function completeMultipartUpload(params) {
    const { directoryname, fileName, uploadId, parts } = params;

    // Sort parts by PartNumber to ensure correct order
    const sortedParts = parts.sort((a, b) => a.PartNumber - b.PartNumber);

    const command = new CompleteMultipartUploadCommand({
        Bucket: BUCKET_NAME,
        Key: `${directoryname}/${fileName}`,
        UploadId: uploadId,
        MultipartUpload: {
            Parts: sortedParts.map(part => ({
                ETag: part.ETag,
                PartNumber: part.PartNumber
            }))
        },
    });

    try {
        const response = await s3Admin.send(command);

        return {
            location: response.Location,
            key: response.Key,
            bucket: response.Bucket,
            etag: response.ETag,
            s3Uri: `s3://${BUCKET_NAME}/${directoryname}/${fileName}`
        };
    } catch (error) {
        console.error('S3 multipart upload completion error:', error);
        throw new AppError(
            `Failed to complete upload: ${error.message}`,
            error.$metadata?.httpStatusCode || 500
        );
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
    completeMultipartUpload
}