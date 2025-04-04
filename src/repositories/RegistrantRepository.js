const pool = require('../configs/DbConfig');
const { logger } = require('../utils/Logger');
const { S3Client, ListObjectsV2Command, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

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

module.exports = {
    postRegistrant,
    getUploadUrl
}