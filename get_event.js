const { db } = require('./src/configs/firebase-init.js');
async function run() {
  const query = await db.collection('events').get();
  query.forEach(doc => console.log(doc.id, JSON.stringify(doc.data().venues, null, 2)));
}
run().then(() => process.exit(0)).catch(console.error);
