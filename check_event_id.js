const { db } = require('./src/configs/firebase-init.js');
async function run() {
  const collections = await db.listCollections();
  collections.forEach(c => console.log(c.id));
}
run().then(() => process.exit(0)).catch(console.error);
