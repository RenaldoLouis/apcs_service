/**
 * Read production Firestore into an owner-only local file, then import that file
 * into an empty Firestore emulator. This script never writes to production.
 *
 * node scripts/firestore_local_snapshot.js export
 * FIRESTORE_EMULATOR_HOST=127.0.0.1:8081 node scripts/firestore_local_snapshot.js import <snapshot-path>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { once } = require('events');
const admin = require('firebase-admin');

const PROJECT_ID = 'apcs-profile';
const EMULATOR_HOST = '127.0.0.1:8081';
const SNAPSHOT_DIR = path.resolve(__dirname, '../.local/firestore-snapshots');
const PAGE_SIZE = 200;

function encode(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { __firestoreType: 'nonFiniteNumber', value: String(value) };
  }
  if (value instanceof admin.firestore.Timestamp) {
    return { __firestoreType: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (value instanceof admin.firestore.GeoPoint) {
    return { __firestoreType: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }
  if (value instanceof admin.firestore.DocumentReference) {
    return { __firestoreType: 'reference', path: value.path };
  }
  if (Buffer.isBuffer(value)) return { __firestoreType: 'bytes', base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  }
  return value;
}

function decode(value, db) {
  if (Array.isArray(value)) return value.map(item => decode(item, db));
  if (!value || typeof value !== 'object') return value;
  switch (value.__firestoreType) {
    case 'timestamp': return new admin.firestore.Timestamp(value.seconds, value.nanoseconds);
    case 'geopoint': return new admin.firestore.GeoPoint(value.latitude, value.longitude);
    case 'reference': return db.doc(value.path);
    case 'bytes': return Buffer.from(value.base64, 'base64');
    case 'nonFiniteNumber': return Number(value.value);
    default: return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, db)]));
  }
}

async function exportSnapshot() {
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.APCS_FIRESTORE_MODE) {
    throw new Error('Export requires a production read connection without emulator variables.');
  }
  const serviceAccount = require('../src/configs/serviceAccountKey.json');
  if (serviceAccount.project_id !== PROJECT_ID) throw new Error('Unexpected source project.');
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: PROJECT_ID });
  const db = admin.firestore();
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(SNAPSHOT_DIR, 0o700);
  const name = `firestore-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson.gz`;
  const temporary = path.join(SNAPSHOT_DIR, `${name}.partial`);
  const destination = path.join(SNAPSHOT_DIR, name);
  const output = fs.createWriteStream(temporary, { mode: 0o600, flags: 'wx' });
  const gzip = zlib.createGzip();
  gzip.pipe(output);
  let count = 0;
  let collections = 0;

  async function writeLine(record) {
    if (!gzip.write(`${JSON.stringify(record)}\n`)) await once(gzip, 'drain');
  }

  async function copyCollection(collection) {
    collections += 1;
    // listDocuments includes missing parent documents that still own subcollections.
    const references = await collection.listDocuments();
    for (let offset = 0; offset < references.length; offset += PAGE_SIZE) {
      const page = references.slice(offset, offset + PAGE_SIZE);
      const documents = await db.getAll(...page);
      for (let index = 0; index < documents.length; index += 20) {
        const group = documents.slice(index, index + 20);
        const childrenByDocument = await Promise.all(group.map(document => document.ref.listCollections()));
        for (let childIndex = 0; childIndex < group.length; childIndex += 1) {
          const document = group[childIndex];
          if (document.exists) {
            await writeLine({ path: document.ref.path, data: encode(document.data()) });
            count += 1;
          }
          for (const child of childrenByDocument[childIndex]) await copyCollection(child);
        }
      }
    }
  }

  try {
    await writeLine({ snapshotVersion: 1, sourceProject: PROJECT_ID, createdAt: new Date().toISOString() });
    const roots = await db.listCollections();
    for (const collection of roots) await copyCollection(collection);
    gzip.end();
    await once(output, 'finish');
    fs.renameSync(temporary, destination);
    console.log(JSON.stringify({ snapshot: destination, documents: count, collections, bytes: fs.statSync(destination).size }, null, 2));
  } catch (error) {
    gzip.destroy();
    output.destroy();
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

async function importSnapshot(file) {
  if (process.env.FIRESTORE_EMULATOR_HOST !== EMULATOR_HOST) {
    throw new Error(`Import requires FIRESTORE_EMULATOR_HOST=${EMULATOR_HOST}.`);
  }
  if (!file) throw new Error('Provide a snapshot path.');
  const input = path.resolve(file);
  if (!input.startsWith(`${SNAPSHOT_DIR}${path.sep}`) || !input.endsWith('.ndjson.gz')) {
    throw new Error('Import requires a snapshot from apcs_service/.local/firestore-snapshots.');
  }
  admin.initializeApp({ projectId: PROJECT_ID });
  const db = admin.firestore();
  const existing = await db.listCollections();
  if (existing.length) throw new Error('The emulator contains data. Start with an empty emulator before importing.');
  const lines = readline.createInterface({ input: fs.createReadStream(input).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let count = 0;
  let batch = db.batch();
  let pending = 0;
  let headerSeen = false;
  for await (const line of lines) {
    const record = JSON.parse(line);
    if (!headerSeen) {
      if (record.snapshotVersion !== 1 || record.sourceProject !== PROJECT_ID) {
        throw new Error('Invalid snapshot header or project.');
      }
      headerSeen = true;
      continue;
    }
    if (typeof record.path !== 'string' || !record.data || typeof record.data !== 'object') {
      throw new Error('Invalid snapshot record.');
    }
    batch.set(db.doc(record.path), decode(record.data, db));
    pending += 1;
    count += 1;
    if (pending >= PAGE_SIZE) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (!headerSeen) throw new Error('Empty snapshot.');
  if (pending) await batch.commit();
  console.log(JSON.stringify({ importedDocuments: count, emulator: EMULATOR_HOST }, null, 2));
}

async function main() {
  const [mode, file] = process.argv.slice(2);
  if (mode === 'export') await exportSnapshot();
  else if (mode === 'import') await importSnapshot(file);
  else throw new Error('Usage: node scripts/firestore_local_snapshot.js export|import <snapshot-path>');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(async () => {
  await Promise.all(admin.apps.map(app => app.delete()));
});
