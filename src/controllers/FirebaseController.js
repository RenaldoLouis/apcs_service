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

async function migrateEventId(req, res, next) {
    try {
        const { eventId, collectionName } = req.body;

        if (!eventId || !collectionName) {
            return res.status(400).json({ error: "Both 'eventId' and 'collectionName' are required." });
        }

        console.log(`[FirebaseController] Starting eventId migration: collection=${collectionName}, eventId=${eventId}`);

        const collectionRef = db.collection(collectionName);
        const snapshot = await collectionRef.get();

        if (snapshot.empty) {
            return res.status(200).json({ message: "No documents found in the collection.", updatedCount: 0 });
        }

        const batchSize = 499;
        let updatedCount = 0;
        const docs = snapshot.docs;

        for (let i = 0; i < docs.length; i += batchSize) {
            const batch = db.batch();
            const chunk = docs.slice(i, i + batchSize);

            chunk.forEach((docSnap) => {
                batch.update(docSnap.ref, { eventId: eventId });
            });

            await batch.commit();
            updatedCount += chunk.length;
            console.log(`[FirebaseController] Migrated batch: ${updatedCount}/${docs.length}`);
        }

        console.log(`[FirebaseController] Migration complete. Updated ${updatedCount} documents.`);
        res.status(200).json({
            message: `Successfully migrated ${updatedCount} documents with eventId="${eventId}".`,
            updatedCount,
        });
    } catch (err) {
        console.error("[FirebaseController] Migration failed:", err);
        next(err);
    }
}

async function saveSessionAssignments(req, res, next) {
    try {
        const { eventId, assignments } = req.body;
        if (!eventId || !assignments) {
            return res.status(400).json({ error: "eventId and assignments are required." });
        }

        const docRef = db.collection('sessionAssignments').doc(eventId);
        await docRef.set({
            eventId,
            assignments,
            updatedAt: new Date().toISOString(),
        });

        res.status(200).json({ message: "Assignments saved successfully!" });
    } catch (err) {
        console.error("[FirebaseController] Failed to save session assignments:", err);
        next(err);
    }
}

async function getSessionAssignments(req, res, next) {
    try {
        const { eventId } = req.params;
        if (!eventId) {
            return res.status(400).json({ error: "eventId is required." });
        }

        const docRef = db.collection('sessionAssignments').doc(eventId);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            return res.status(404).json({ error: "No assignments found for this event." });
        }

        res.status(200).json(docSnap.data());
    } catch (err) {
        console.error("[FirebaseController] Failed to get session assignments:", err);
        next(err);
    }
}

module.exports = {
    getGaleries,
    getVideos,
    getSponsors,
    updatePrices,
    migrateEventId,
    saveSessionAssignments,
    getSessionAssignments,
};