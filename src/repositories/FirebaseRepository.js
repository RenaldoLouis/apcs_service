const pool = require('../configs/DbConfig');
const { logger } = require('../utils/Logger');
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const getGaleries = async (params, callback) => {
    const { eventName } = params;
    const normalizedNameEvent = eventName.replace(/\s+/g, '').toLowerCase()

    logger.info(`Retrieving Galeries ${normalizedNameEvent}`);

    //AWS
    const bucketName = "apcsgalery";

    const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: normalizedNameEvent,
    });

    const response = await s3.send(command);

    // Extract folder names from CommonPrefixes
    const files = response.Contents?.map(file => `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${file.Key}`) || [];
    files.shift();

    return callback(null, files);
};

module.exports = {
    getGaleries
}