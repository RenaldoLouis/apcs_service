const { db } = require('./src/configs/firebase-init.js');
async function run() {
  const collections = await db.listCollections();
  collections.forEach(col => {
    if (col.id.startsWith('seats')) console.log(col.id);
  });
}
run().then(() => process.exit(0)).catch(console.error);
