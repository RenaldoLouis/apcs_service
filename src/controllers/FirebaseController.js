const firebaseService = require('../services/FirebaseService.js');
const { validationResult } = require('express-validator');
const { db } = require('../configs/firebase-init.js');

async function updatePrices(req, res, next) {
    try {
        const data = req.body;
        if (!data || Object.keys(data).length === 0) {
            return res.status(400).json({ error: "No pricing data provided." });
        }

        const categories = Object.keys(data);
        console.log(`[FirebaseController] Found ${categories.length} categories to update.`);
        let changesData = [];

        for (const category of categories) {
            const docRef = db.collection('Registration2025Fee').doc(category);
            const docSnap = await docRef.get();
            const beforeData = docSnap.exists ? docSnap.data() : null;
            const afterData = data[category];

            let categoryChanges = [];

            if (beforeData && beforeData.fees && afterData.fees) {
                afterData.fees.forEach(afterFee => {
                    const beforeFee = beforeData.fees.find(f => f.category === afterFee.category && (f.age_group === afterFee.age_group || (!f.age_group && !afterFee.age_group)));
                    if (beforeFee) {
                        let priceChanges = [];
                        const keysToCompare = [
                            'nationalPrice', 'internationalPrice', 
                            'nationalPriceRegular', 'internationalPriceRegular',
                            'nationalPriceSpecial', 'internationalPriceSpecial'
                        ];
                        
                        keysToCompare.forEach(key => {
                            if (beforeFee[key] !== afterFee[key]) {
                                priceChanges.push(`${key}: ${beforeFee[key] || 'N/A'} -> ${afterFee[key] || 'N/A'}`);
                            }
                        });

                        if (priceChanges.length > 0) {
                            let feeName = afterFee.category;
                            if (afterFee.age_group) feeName += ` (Age: ${afterFee.age_group})`;
                            categoryChanges.push({ feeName, priceChanges });
                        }
                    } else {
                        let feeName = afterFee.category;
                        if (afterFee.age_group) feeName += ` (Age: ${afterFee.age_group})`;
                        categoryChanges.push({ feeName, priceChanges: ["New fee tier added"] });
                    }
                });
            } else if (!beforeData) {
                categoryChanges.push({ feeName: "ALL", priceChanges: ["New competition category added"] });
            }

            if (categoryChanges.length > 0) {
                changesData.push({
                    mainCategory: afterData.displayName || category,
                    changes: categoryChanges
                });
            }

            await docRef.set(afterData);
            console.log(`[FirebaseController] Updated pricing for category: ${category}`);
        }

        res.status(200).json({ 
            message: "Successfully updated all prices in Firestore!",
            changesData
        });
    } catch (err) {
        console.error("[FirebaseController] Failed to update prices:", err);
        next(err);
    }
}

async function getGaleries(req, res, next) {
    try {
        const data = await firebaseService.getGaleries(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function getVideos(req, res, next) {
    try {
        const data = await firebaseService.getVideos(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

async function getSponsors(req, res, next) {
    try {
        const data = await firebaseService.getSponsors(req, next)
        res.status(200).send(data)
    } catch (err) {
        next(err);
    }
}

module.exports = {
    getGaleries,
    getVideos,
    getSponsors,
    updatePrices,
};