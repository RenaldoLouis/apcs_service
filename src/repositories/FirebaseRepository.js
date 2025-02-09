const pool = require('../configs/DbConfig');
const { InboundDeliveryDto } = require('../models/InboundDeliveryModel');
const { logger } = require('../utils/Logger');
const admin = require("firebase-admin");
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

// Decode Base64 JSON properly
const credentialsBuffer = Buffer.from(process.env.FIREBASE_JSON, "base64");
const serviceAccount = JSON.parse(credentialsBuffer.toString());

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "apcs-profile.appspot.com"
});

const bucket = admin.storage().bucket();

const getGaleries = async (params, callback) => {
    const { eventName } = params;
    const normalizedNameEvent = eventName.replace(/\s+/g, '').toLowerCase()

    logger.info(`Retrieving Galeries ${normalizedNameEvent}`);

    // const [files] = await bucket.getFiles({ prefix: `galery/${normalizedNameEvent}` });

    // if (files.length === 0) {
    //     console.log("No files found in this folder.");
    //     return callback(null, []);
    // }

    // async function generateSignedUrl(file) {
    //     try {
    //         const [url] = await file.getSignedUrl({
    //             action: 'read',
    //             expires: Date.now() + 60 * 60 * 1000, // 1 hour expiry
    //         });
    //         return url;
    //     } catch (error) {
    //         console.error("Error generating signed URL:", error);
    //         return null;
    //     }
    // }

    // const returnFiles = await Promise.all(
    //     files.map(async (eachFile, index) => {
    //         const file = bucket.file(eachFile.name);
    //         return generateSignedUrl(file);
    //     })
    // );
    // returnFiles.shift();
    // return callback(null, returnFiles);

    //AWS
    const bucketName = "apcsgalery";
    // const folderPrefix = req.query.prefix || ""; // Get folder prefix from query
    const folderPrefix = "turningPoint"

    const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: folderPrefix, // Filters files within this "folder"
        // Delimiter: "/", // Groups objects based on common prefixes
    });

    const response = await s3.send(command);

    // Extract folder names from CommonPrefixes
    const files = response.Contents?.map(file => `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${file.Key}`) || [];

    return callback(null, files);
};

module.exports = {
    getGaleries
}