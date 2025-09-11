const pool = require('../configs/DbConfig');
const { logger } = require('../utils/Logger');
const { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const archiver = require('archiver');
const { AppendFilesToZip } = require('../utils/awsDownload');

const s3Admin = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID_admin,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_admin,
    },
});

const postRegistrant = async (params, callback) => {

}

const getUploadUrl = async (params, callback) => {
    const { directoryname, fileName } = params;
    const s3Param = {
        Bucket: 'registrants2025',
        Key: `${directoryname}/${fileName}.pdf`, // Use a unique key
        ContentType: 'application/pdf',
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

const downloadFilesAws = async (params, res) => {

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=documents.zip');

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    try {
        await AppendFilesToZip(archive, params);
        await archive.finalize();
    } catch (err) {
        console.error('ZIP stream failed:', err);
        res.status(500).send('Error creating ZIP file.');
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
                        Bucket: 'registrants2025',
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


module.exports = {
    postRegistrant,
    getUploadUrl,
    downloadFilesAws,
    downloadAllFiles
}