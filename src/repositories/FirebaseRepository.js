const pool = require('../configs/DbConfig');
const { InboundDeliveryDto } = require('../models/InboundDeliveryModel');
const { logger } = require('../utils/Logger');
const admin = require("firebase-admin");

// Decode Base64 JSON properly
const credentialsBuffer = Buffer.from(process.env.FIREBASE_JSON, "base64");
const serviceAccount = JSON.parse(credentialsBuffer.toString());

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "apcs-profile.appspot.com"
});

const bucket = admin.storage().bucket();
const getGaleries = async (params, callback) => {
    const { eventName } = params
    logger.info(`Retrieivng Galeries ${eventName}`);

    const [files] = await bucket.getFiles({ prefix: `galery/turningPoint` });

    if (files.length === 0) {
        console.log("No files found in this folder.");
        return;
    }

    let returnFiles = {}

    return callback(null, files);
}

module.exports = {
    getGaleries
}