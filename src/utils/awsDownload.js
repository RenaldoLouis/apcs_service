// utils/awsDownload.js
const { GetObjectCommand, S3Client } = require('@aws-sdk/client-s3');

const s3Admin = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID_admin,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY_admin,
    },
});

const AppendFilesToZip = async (archive, files) => {
    for (const { fileName } of files) {
        const key = `${fileName}`;
        const command = new GetObjectCommand({
            Bucket: 'registrants2025',
            Key: key,
        });

        const { Body } = await s3Admin.send(command);
        archive.append(Body, { name: `${fileName}` });
    }
};

module.exports = {
    AppendFilesToZip
};
