/** Owner-authorized cleanup of two fixed, unused APCS2026 production definitions.
 * Dry-run: node scripts/remove_obsolete_orchestra_sessions.js
 * Apply: node scripts/remove_obsolete_orchestra_sessions.js --apply --fingerprint=<dry-run>
 * No document deletion, application runtime, payment or email calls.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const PROJECT_ID = 'apcs-profile', EVENT_ID = 'APCS2026';
const TARGETS = Object.freeze([
  { id: '0goivmll', venue: 'Venue_mvfyegwz', date: '2026-11-15', time: '15:30-17:30' },
  { id: '9tixhoss', venue: 'Venue_mvfyegwz', date: '2026-11-15', time: '19:30-21:30' },
]);
const COLLECTIONS = ['publicBookings', 'ticketCapacity', 'ticketSeatOwnership', 'ticketCheckoutKeys',
  'winnerOrchestraClaims', 'orchestraAssignments', 'bookings', 'seatBook2025', 'seatBook', 'seats',
  'masterclassAssignments', 'ticketRedemptions', 'ticketPaymentReceipts'];
function referencesTarget(data, documentId = '') {
  let decodedId = documentId;
  try { decodedId = decodeURIComponent(documentId); } catch { /* Keep literal legacy IDs. */ }
  const text = JSON.stringify({ documentId: decodedId, data });
  return TARGETS.some(target => text.includes(target.id)
    || (text.includes(target.venue) && text.includes(target.date) && text.includes(target.time)));
}
function prepareChanges(event, plan, dependencies) {
  assert.equal(event.competitionScheduleState?.status, 'draft');
  assert.equal(plan?.status, 'draft');
  assert.ok(Number.isSafeInteger(plan.revision));
  assert.equal(event.competitionScheduleState.revision, plan.revision);
  for (const target of TARGETS) {
    const matches = (event.orchestraSessions || []).filter(session => session.id === target.id);
    assert.equal(matches.length, 1, 'Exactly one definition per fixed target is required.');
    for (const field of ['venue', 'date', 'time']) assert.equal(matches[0][field], target[field]);
    assert.equal(Number(matches[0].freeSeatingAssigned || 0), 0, 'Assigned attendance prevents cleanup.');
    assert.equal(Number(matches[0].complimentaryClaimed || 0), 0, 'Legacy attendance prevents cleanup.');
  }
  assert.equal(dependencies.length, 0, 'A target has references or inventory; stop for reconciliation.');
  const revision = plan.revision + 1;
  return { event: { ...event, orchestraSessions: event.orchestraSessions.filter(session =>
    !TARGETS.some(target => session.id === target.id)),
    competitionScheduleState: { ...event.competitionScheduleState, revision } }, plan: { ...plan, revision } };
}
async function run() {
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.APCS_FIRESTORE_MODE) throw new Error('Production cleanup refuses emulator variables.');
  const admin = require('firebase-admin');
  const key = require('../src/configs/serviceAccountKey.json');
  assert.equal(key.project_id, PROJECT_ID);
  const app = admin.initializeApp({ credential: admin.credential.cert(key), projectId: PROJECT_ID });
  const db = app.firestore();
  const timer = setTimeout(() => { console.error('Timed out; inspect production before retrying.'); process.exit(1); }, 60000);
  try {
    const refs = [db.doc(`events/${EVENT_ID}`), db.doc(`competitionSessionPlans/${EVENT_ID}`),
      db.doc(`sessionAssignments/${EVENT_ID}`), db.doc('systemSettings/global')];
    const sessions = TARGETS.map(target => `${target.date}_${target.time}`);
    const queries = {
      groups: db.collection(`competitionSessionPlans/${EVENT_ID}/groups`),
      numberedSeats: db.collection(`seats${EVENT_ID}`).where('sessionId', 'in', sessions),
      ...Object.fromEntries(COLLECTIONS.map(name => [name, db.collection(name).where('eventId', '==', EVENT_ID)])),
      ...Object.fromEntries(['seats', 'bookings', 'seatBook', 'seatBook2025'].map(name =>
        [`legacy-${name}`, db.collection(name).where('sessionId', 'in', sessions)])),
    };
    async function inventory(transaction) {
      const read = ref => transaction ? transaction.get(ref) : ref.get();
      const [documents, entries] = await Promise.all([Promise.all(refs.map(read)),
        Promise.all(Object.entries(queries).map(async ([name, query]) => [name, await read(query)]))]);
      const all = [...new Map([...documents, ...entries.flatMap(([, snapshot]) => snapshot.docs)]
        .map(doc => [doc.ref.path, doc])).values()].sort((a, b) => a.ref.path.localeCompare(b.ref.path));
      return { documents, snapshots: Object.fromEntries(entries), all,
        fingerprint: crypto.createHash('sha256').update(JSON.stringify(all.map(doc =>
          [doc.ref.path, doc.exists, doc.updateTime?.seconds, doc.updateTime?.nanoseconds]))).digest('hex') };
    }
    function changes(snapshot) {
      const [event, plan, assignment, settings] = snapshot.documents;
      assert.equal(settings.data()?.currentEventId, EVENT_ID);
      assert.ok(!referencesTarget(assignment.data()) && !referencesTarget(plan.data()), 'Published or draft planning references prevent cleanup.');
      const dependencies = snapshot.all.filter(doc => {
        if (!doc.exists || refs.some(ref => ref.path === doc.ref.path)) return false;
        const data = doc.data();
        if (doc.ref.parent.id === `seats${EVENT_ID}`) return !data.venueId || data.venueId === TARGETS[0].venue;
        if (doc.ref.parent.id === 'publicBookings' && data.paymentStatus === 'archived_test') return false;
        return referencesTarget(data, doc.id);
      });
      return prepareChanges(event.data(), plan.data(), dependencies);
    }
    const before = await inventory(), next = changes(before);
    console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'dry-run', projectId: PROJECT_ID,
      eventId: EVENT_ID, targets: TARGETS, fingerprint: before.fingerprint, revisionBefore: before.documents[1].data().revision,
      targetDependencies: 0, counts: Object.fromEntries(Object.entries(before.snapshots).map(([name, snap]) => [name, snap.size])),
      documentDeletes: 0 }, null, 2));
    if (!process.argv.includes('--apply')) return;
    assert.equal(process.argv.find(arg => arg.startsWith('--fingerprint='))?.slice('--fingerprint='.length), before.fingerprint);
    function encode(value) {
      if (value instanceof admin.firestore.Timestamp) return { __firestoreType: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
      if (value instanceof admin.firestore.GeoPoint) return { __firestoreType: 'geopoint', latitude: value.latitude, longitude: value.longitude };
      if (value instanceof admin.firestore.DocumentReference) return { __firestoreType: 'reference', path: value.path };
      if (Buffer.isBuffer(value)) return { __firestoreType: 'bytes', base64: value.toString('base64') };
      if (Array.isArray(value)) return value.map(encode);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
      return value;
    }
    const directory = path.resolve(__dirname, '../.local/backups');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const backup = path.join(directory, `production-obsolete-orchestra-sessions-${Date.now()}.json.gz`);
    fs.writeFileSync(backup, zlib.gzipSync(Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(),
      projectId: PROJECT_ID, eventId: EVENT_ID, targets: TARGETS, fingerprint: before.fingerprint,
      documents: before.all.map(doc => ({ path: doc.ref.path, exists: doc.exists,
        ...(doc.exists ? { data: encode(doc.data()) } : {}) })) }))), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ backup }));
    await db.runTransaction(async transaction => {
      const current = await inventory(transaction);
      assert.equal(current.fingerprint, before.fingerprint, 'Records changed after backup; refusing cleanup.');
      assert.deepStrictEqual(changes(current), next);
      transaction.update(refs[0], { orchestraSessions: next.event.orchestraSessions,
        'competitionScheduleState.revision': next.plan.revision });
      transaction.update(refs[1], { revision: next.plan.revision });
    });
    const after = await inventory();
    assert.deepStrictEqual(after.all.map(doc => doc.ref.path), before.all.map(doc => doc.ref.path));
    for (const old of before.all) {
      const current = after.all.find(doc => doc.ref.path === old.ref.path);
      assert.deepStrictEqual(current.data(), old.ref.path === refs[0].path ? next.event
        : old.ref.path === refs[1].path ? next.plan : old.data());
      if (old.exists && !refs.slice(0, 2).some(ref => ref.path === old.ref.path)) assert.ok(current.updateTime.isEqual(old.updateTime));
    }
    console.log(JSON.stringify({ verified: true, orchestraDefinitionsRemoved: 2, documentDeletes: 0,
      revisionAfter: next.plan.revision, draftSlotsPreserved: next.plan.draftSlots.length,
      groupsPreserved: after.snapshots.groups.size, bookingsPreserved: after.snapshots.publicBookings.size,
      remainingOrchestraSessions: next.event.orchestraSessions.length, protectedSnapshotsUnchanged: true, backup }));
  } finally { clearTimeout(timer); await db.terminate(); await app.delete(); }
}
module.exports = { TARGETS, referencesTarget, prepareChanges };
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
