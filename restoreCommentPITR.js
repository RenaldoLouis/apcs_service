const admin = require('firebase-admin');
const { Timestamp } = require('firebase-admin/firestore');
const serviceAccount = require('./src/configs/serviceAccountKey.json');

// NOTE: Please run this script from inside the apcs_service folder so it can find firebase-admin
// Command: node restoreCommentPITR.js

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function restoreJuryCommentPITR() {
    try {
        console.log("Searching for the deleted comment using Point-in-Time Recovery (PITR)...");

        const pastDate = new Date('2026-09-03T21:00:00.000Z');
        const readTime = Timestamp.fromDate(pastDate);
        console.log(`Reading database exactly as it was on: ${pastDate.toLocaleString()}`);

        let targetDoc = null;
        let targetData = null;

        // We use a read-only transaction mapped to the past readTime to fetch our past data safely
        await db.runTransaction(async (t) => {
            const pastScoresSnapshot = await t.get(db.collection('JuryScores2025').where('score', '==', 92));

            if (pastScoresSnapshot.empty) {
                console.log("Could not find any document with score 92 at that specific time in the past.");
                return;
            }

            for (const doc of pastScoresSnapshot.docs) {
                const data = doc.data();
                const juryName = data.juryName || '';

                if (juryName.toLowerCase().includes('jin yun')) {
                    const registrantId = data.registrantId;
                    if (registrantId) {
                        // Look up the registrant directly at the current time
                        const regDoc = await db.collection('Registrants2025').doc(registrantId).get();
                        if (regDoc.exists) {
                            const regData = regDoc.data();
                            const p = regData.performers?.[0];
                            const fullName = p ? (p.fullName || `${p.firstName || ''} ${p.lastName || ''}`).trim() : '';

                            if (fullName.toLowerCase().includes('ethan limandibrata')) {
                                targetDoc = doc;
                                targetData = data;
                                break;
                            }
                        }
                    }
                }
            }
        }, { readOnly: true, readTime: readTime });

        if (!targetDoc) {
            console.log("Found some scores of 92 by Jin Yun, but none belonged to Ethan Limandibrata.");
            return;
        }

        console.log("======================================");
        console.log("Found the exact target document in the past!");
        console.log("Jury Name:", targetData.juryName);
        console.log("Score:", targetData.score);
        console.log("Comment:", targetData.comment);
        console.log("APCS Note:", targetData.panelComment);
        console.log("======================================");

        // 4. Restore the document to the PRESENT time
        const targetDocRef = db.collection('JuryScores2025').doc(targetDoc.id);
        const existingDoc = await targetDocRef.get();

        console.log("\n--- TRIPLE CHECK / DRY RUN MODE ---");
        if (!existingDoc.exists) {
            console.log("Status: The entire document is currently missing in the active database.");
            console.log("Action: It would recreate the exact document with ID:", targetDoc.id);
            await targetDocRef.set(targetData); // <--- UNCOMMENT THIS LINE TO ACTUALLY RESTORE
        } else {
            console.log("Status: The document still exists in the active database.");
            console.log(`Action: It would ONLY update the 'comment' and 'panelComment' fields for document ID: ${targetDoc.id}`);
            await targetDocRef.update({          // <--- UNCOMMENT THESE LINES TO ACTUALLY RESTORE
                comment: targetData.comment || '',
                panelComment: targetData.panelComment || '',
            });
        }

        console.log("\nIf the data above looks correct, open the script, uncomment the lines at the bottom, and run it again to apply!");
    } catch (error) {
        console.error("Error restoring data:", error);
    }
}

restoreJuryCommentPITR();
