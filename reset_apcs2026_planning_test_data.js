/**
 * One-off APCS2026 ticketing reset for competition planning.
 *
 * Read-only: node reset_apcs2026_planning_test_data.js
 * Execute:   node reset_apcs2026_planning_test_data.js --execute --fingerprint=<dry-run fingerprint>
 *
 * Registrants, scoring, pricing, venue layouts and orchestra session definitions remain.
 * Terminal test bookings remain as archived_test tombstones so late Paper callbacks
 * cannot be mistaken for registration payments or reopen old seats.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { db, admin } = require('./src/configs/firebase-init');
const serviceAccount = require('./src/configs/serviceAccountKey.json');

const EVENT_ID = 'APCS2026';
const TARGET_PROJECT = 'apcs-profile';
const COLLECTIONS = [
  'publicBookings', 'ticketCapacity', 'ticketSeatOwnership', 'ticketCheckoutKeys',
  'winnerOrchestraClaims', 'orchestraAssignments', 'seatBook2025', 'seatBook', 'bookings',
  'seats', 'masterclassAssignments',
];
const execute = process.argv.includes('--execute');
const fingerprintArg = process.argv.find(arg => arg.startsWith('--fingerprint='))?.slice('--fingerprint='.length);

function encode(value) {
  if (value instanceof admin.firestore.Timestamp) {
    return { __type: 'Timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (value instanceof admin.firestore.GeoPoint) {
    return { __type: 'GeoPoint', latitude: value.latitude, longitude: value.longitude };
  }
  if (Buffer.isBuffer(value)) return { __type: 'Buffer', base64: value.toString('base64') };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  }
  return value;
}

async function inventory() {
  const eventRef = db.collection('events').doc(EVENT_ID);
  const event = await eventRef.get();
  if (!event.exists) throw new Error('APCS2026 event does not exist.');
  const snapshots = {};
  for (const name of COLLECTIONS) {
    snapshots[name] = await db.collection(name).where('eventId', '==', EVENT_ID).get();
  }
  snapshots[`seats${EVENT_ID}`] = await db.collection(`seats${EVENT_ID}`).get();
  const assignment = await db.collection('sessionAssignments').doc(EVENT_ID).get();
  const plan = await db.collection('competitionSessionPlans').doc(EVENT_ID).get();
  const groups = await db.collection('competitionSessionPlans').doc(EVENT_ID).collection('groups').get();
  const docs = [
    event, ...(assignment.exists ? [assignment] : []), ...(plan.exists ? [plan] : []),
    ...groups.docs, ...Object.values(snapshots).flatMap(snapshot => snapshot.docs),
  ];
  const fingerprint = crypto.createHash('sha256')
    .update(docs.map(doc => `${doc.ref.path}|${doc.updateTime?.toMillis() || 0}`).sort().join('\n'))
    .digest('hex').slice(0, 16);
  return { event, assignment, plan, groups, snapshots, docs, fingerprint };
}

async function writeBackup(snapshot) {
  const folder = path.join(__dirname, '.local', 'backups');
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  const filename = path.join(folder, `apcs2026-ticketing-reset-${Date.now()}-${snapshot.fingerprint}.json.gz`);
  const payload = {
    eventId: EVENT_ID, createdAt: new Date().toISOString(), fingerprint: snapshot.fingerprint,
    documents: snapshot.docs.map(doc => ({ path: doc.ref.path, data: encode(doc.data()) })),
  };
  fs.writeFileSync(filename, zlib.gzipSync(Buffer.from(JSON.stringify(payload))), { mode: 0o600, flag: 'wx' });
  return filename;
}

async function deleteBatches(docs) {
  for (let offset = 0; offset < docs.length; offset += 400) {
    const batch = db.batch();
    for (const doc of docs.slice(offset, offset + 400)) batch.delete(doc.ref);
    await batch.commit();
  }
}

async function archiveBookings(docs) {
  for (let offset = 0; offset < docs.length; offset += 400) {
    const batch = db.batch();
    for (const doc of docs.slice(offset, offset + 400)) {
      batch.update(doc.ref, {
        paymentStatus: 'archived_test',
        planningReset: {
          originalPaymentStatus: doc.data().paymentStatus,
          archivedAt: admin.firestore.FieldValue.serverTimestamp(),
          eventId: EVENT_ID,
        },
      });
    }
    await batch.commit();
  }
}

function retainedSessions(event) {
  const special = [...(event.orchestraSessions || []), ...(event.masterclassSessions || [])];
  return (event.venues || []).map(venue => ({
    ...venue,
    sessions: Object.fromEntries(Object.entries(venue.sessions || {}).map(([date, times]) => [
      date, times.filter(time => special.some(slot => slot.venue === venue.id && slot.date === date && slot.time === time)),
    ])),
  }));
}

async function run() {
  if (serviceAccount.project_id !== TARGET_PROJECT) throw new Error('Unexpected Firebase project.');
  if (process.argv.some(arg => arg.startsWith('--event='))) throw new Error('This reset is fixed to APCS2026.');
  const snapshot = await inventory();
  const bookings = snapshot.snapshots.publicBookings.docs;
  const blockers = bookings.filter(doc => !['PAID', 'paid', 'failed', 'expired', 'archived_test'].includes(doc.data().paymentStatus));
  const summary = {
    eventId: EVENT_ID, fingerprint: snapshot.fingerprint,
    collections: Object.fromEntries(Object.entries(snapshot.snapshots).map(([key, value]) => [key, value.size])),
    assignmentDocument: snapshot.assignment.exists, existingPlanGroups: snapshot.groups.size,
    bookingStatuses: bookings.reduce((counts, doc) => {
      const status = doc.data().paymentStatus || 'unknown';
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    }, {}),
    venueCompetitionSlotsRemoved: (snapshot.event.data().venues || []).reduce((sum, venue) =>
      sum + Object.values(venue.sessions || {}).flat().length, 0)
      - retainedSessions(snapshot.event.data()).reduce((sum, venue) =>
        sum + Object.values(venue.sessions || {}).flat().length, 0),
    blockedNonterminalBookings: blockers.length,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!execute) return;
  if (!fingerprintArg || fingerprintArg !== snapshot.fingerprint) throw new Error('Inventory changed; run a new dry-run and use its fingerprint.');
  if (blockers.length) throw new Error('Nonterminal bookings must be reconciled before reset.');
  if (snapshot.event.data().competitionScheduleState?.status
    && snapshot.event.data().competitionScheduleState.status !== 'resetting') {
    throw new Error('Planning is already active; refusing to reset it.');
  }
  const backup = await writeBackup(snapshot);
  console.log(`Backup written with owner-only permissions: ${backup}`);

  await snapshot.event.ref.update({
    competitionScheduleState: { status: 'resetting', revision: 0, resetInProgress: true },
  }, { lastUpdateTime: snapshot.event.updateTime });

  await archiveBookings(bookings.filter(doc => doc.data().paymentStatus !== 'archived_test'));
  for (const [name, collectionSnapshot] of Object.entries(snapshot.snapshots)) {
    if (name === 'publicBookings') continue;
    await deleteBatches(collectionSnapshot.docs);
  }
  await deleteBatches(snapshot.groups.docs);
  if (snapshot.assignment.exists) await snapshot.assignment.ref.delete();
  if (snapshot.plan.exists) await snapshot.plan.ref.delete();

  const event = snapshot.event.data();
  await snapshot.event.ref.update({
    venues: retainedSessions(event),
    orchestraSessions: (event.orchestraSessions || []).map(session => ({
      ...session, freeSeatingAssigned: 0, complimentaryClaimed: 0,
    })),
    sessionsSeatsGenerated: {},
  });

  const after = await inventory();
  const remaining = Object.entries(after.snapshots).filter(([name, value]) =>
    name !== 'publicBookings' && !value.empty);
  if (remaining.length || after.assignment.exists || after.groups.size
    || after.snapshots.publicBookings.docs.some(doc => doc.data().paymentStatus !== 'archived_test')) {
    throw new Error('Reset verification failed; event remains closed in resetting state. Keep the backup and reconcile before retrying.');
  }
  await db.collection('competitionSessionPlans').doc(EVENT_ID).set({
    eventId: EVENT_ID, status: 'draft', revision: 0, resetAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await snapshot.event.ref.update({
    competitionScheduleState: { status: 'draft', revision: 0, resetAt: admin.firestore.FieldValue.serverTimestamp() },
  });
  console.log('APCS2026 ticketing reset verified. Competition Planning is in draft.');
}

run().catch(error => {
  console.error('Reset stopped:', error.message);
  process.exitCode = 1;
}).finally(() => db.terminate());
