/**
 * Owner-authorized, one-record production timetable cleanup; no document deletes.
 * Dry-run: node scripts/remove_obsolete_behring_session.js
 * Apply: node scripts/remove_obsolete_behring_session.js --apply --fingerprint=<dry-run>
 * Never repurpose this script for another event/session.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const TARGET = Object.freeze({ projectId: 'apcs-profile', eventId: 'APCS2026',
  venueId: 'Venue_lnssq2n1', venueLabel: 'Behring Theatre', date: '2026-11-14', time: '08:00-09:00' });
const SESSION_ID = `${TARGET.date}_${TARGET.time}`;
const SESSION_KEY = `${TARGET.venueId}_${SESSION_ID}`;
const COLLECTIONS = ['publicBookings', 'ticketCapacity', 'ticketSeatOwnership',
  'ticketCheckoutKeys', 'winnerOrchestraClaims', 'orchestraAssignments', 'bookings',
  'seatBook2025', 'seatBook', 'seats', 'masterclassAssignments', 'ticketRedemptions',
  'ticketPaymentReceipts'];

function matchesTarget(data, documentId = '') {
  // Include encoded keys and nested seat/capacity references, not only top-level fields.
  let decodedId = documentId;
  try { decodedId = decodeURIComponent(documentId); } catch { /* Retain a literal legacy ID. */ }
  const text = JSON.stringify({ documentId: decodedId, data });
  return text.includes(TARGET.venueId) && text.includes(TARGET.date) && text.includes(TARGET.time);
}

function prepareChanges(event, plan, assignment, dependencies) {
  assert.equal(event.competitionScheduleState?.status, 'draft', 'Event must remain draft.');
  assert.equal(plan?.status, 'draft', 'Plan must remain draft.');
  const revision = plan.revision;
  assert.ok(Number.isSafeInteger(revision) && revision >= 0);
  assert.equal(event.competitionScheduleState.revision, revision, 'Revisions must agree.');
  const venues = event.venues.filter(venue => venue.id === TARGET.venueId);
  assert.equal(venues.length, 1, 'Exactly one target venue is required.');
  assert.equal(venues[0].label, TARGET.venueLabel);
  assert.equal((venues[0].sessions?.[TARGET.date] || []).filter(time => time === TARGET.time).length,
    1, 'Exactly one obsolete timetable entry is required.');
  assert.ok(!event.sessionsSeatsGenerated?.[SESSION_KEY] && !event.sessionsSeatsGenerated?.[SESSION_ID],
    'Generated target inventory needs separate reconciliation.');
  assert.equal((assignment?.assignments?.[SESSION_KEY] || []).length, 0,
    'Published performers depend on this timetable entry.');
  assert.ok(![...(event.orchestraSessions || []), ...(event.masterclassSessions || [])]
    .some(session => session.venue === TARGET.venueId && session.date === TARGET.date && session.time === TARGET.time),
  'A special session depends on this timetable entry.');
  assert.equal(dependencies.length, 0, 'Target has inventory or retained references; stop for reconciliation.');
  const nextVenues = event.venues.map(venue => venue.id !== TARGET.venueId ? venue : {
    ...venue, sessions: { ...venue.sessions,
      [TARGET.date]: venue.sessions[TARGET.date].filter(time => time !== TARGET.time) },
  });
  // Retain the date key and all venue metadata. Only revision bookkeeping changes elsewhere.
  return { event: { ...event, venues: nextVenues,
    competitionScheduleState: { ...event.competitionScheduleState, revision: revision + 1 } },
  plan: { ...plan, revision: revision + 1 } };
}

async function run() {
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.APCS_FIRESTORE_MODE) {
    throw new Error('Production cleanup refuses emulator variables.');
  }
  const admin = require('firebase-admin');
  const serviceAccount = require('../src/configs/serviceAccountKey.json');
  assert.equal(serviceAccount.project_id, TARGET.projectId);
  const app = admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: TARGET.projectId });
  const db = app.firestore();
  const timer = setTimeout(() => { console.error('Cleanup timed out; inspect readback before retrying.'); process.exit(1); }, 60000);
  try {
    const refs = [db.doc(`events/${TARGET.eventId}`), db.doc(`competitionSessionPlans/${TARGET.eventId}`),
      db.doc(`sessionAssignments/${TARGET.eventId}`), db.doc('systemSettings/global')];
    const queries = {
      groups: db.collection(`competitionSessionPlans/${TARGET.eventId}/groups`),
      numberedSeats: db.collection(`seats${TARGET.eventId}`).where('sessionId', '==', SESSION_ID),
      ...Object.fromEntries(COLLECTIONS.map(name => [name, db.collection(name).where('eventId', '==', TARGET.eventId)])),
      // Catch legacy inventory/session references whose eventId is absent.
      legacySeatsBySession: db.collection('seats').where('sessionId', '==', SESSION_ID),
      legacyBookingsBySession: db.collection('bookings').where('sessionId', '==', SESSION_ID),
      legacySeatBookBySession: db.collection('seatBook').where('sessionId', '==', SESSION_ID),
      legacySeatBook2025BySession: db.collection('seatBook2025').where('sessionId', '==', SESSION_ID),
    };
    async function inventory(transaction) {
      const get = ref => transaction ? transaction.get(ref) : ref.get();
      const [documents, entries] = await Promise.all([
        Promise.all(refs.map(get)),
        Promise.all(Object.entries(queries).map(async ([name, query]) => [name, await get(query)])),
      ]);
      const snapshots = Object.fromEntries(entries);
      const all = [...new Map([...documents, ...entries.flatMap(([, snap]) => snap.docs)]
        .map(doc => [doc.ref.path, doc])).values()].sort((a, b) => a.ref.path.localeCompare(b.ref.path));
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(all.map(doc =>
        [doc.ref.path, doc.exists, doc.updateTime?.seconds, doc.updateTime?.nanoseconds]))).digest('hex');
      return { documents, snapshots, all, fingerprint };
    }
    function changes(snapshot) {
      const [event, plan, assignment, settings] = snapshot.documents;
      assert.equal(settings.data()?.currentEventId, TARGET.eventId);
      const dependencies = snapshot.all.filter(doc => {
        if (!doc.exists || refs.some(ref => ref.path === doc.ref.path) || doc.ref.path.includes('/groups/')) return false;
        const data = doc.data();
        if (doc.ref.parent.id === `seats${TARGET.eventId}`) {
          return !data.venueId || data.venueId === TARGET.venueId;
        }
        // Archived reset tombstones must remain intact; they cannot reopen inventory.
        if (doc.ref.parent.id === 'publicBookings' && data.paymentStatus === 'archived_test') return false;
        return matchesTarget(data, doc.id);
      });
      return prepareChanges(event.data(), plan.data(), assignment.data(), dependencies);
    }
    const before = await inventory();
    const next = changes(before);
    console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'dry-run', target: TARGET,
      fingerprint: before.fingerprint, revisionBefore: before.documents[1].data().revision,
      draftSlotsPreserved: before.documents[1].data().draftSlots?.length || 0,
      counts: Object.fromEntries(Object.entries(before.snapshots).map(([name, snap]) => [name, snap.size])),
      targetDependencies: 0, writes: ['events/APCS2026: venues and competitionScheduleState.revision',
        'competitionSessionPlans/APCS2026: revision'], documentDeletes: 0 }, null, 2));
    if (!process.argv.includes('--apply')) return;
    const expectedFingerprint = process.argv.find(arg => arg.startsWith('--fingerprint='))?.slice('--fingerprint='.length);
    assert.equal(expectedFingerprint, before.fingerprint, 'Dry-run fingerprint must match current records.');

    function encode(value) {
      if (value instanceof admin.firestore.Timestamp) return { __firestoreType: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
      if (value instanceof admin.firestore.GeoPoint) return { __firestoreType: 'geopoint', latitude: value.latitude, longitude: value.longitude };
      if (value instanceof admin.firestore.DocumentReference) return { __firestoreType: 'reference', path: value.path };
      if (Buffer.isBuffer(value)) return { __firestoreType: 'bytes', base64: value.toString('base64') };
      if (Array.isArray(value)) return value.map(encode);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
      return value;
    }
    const folder = path.resolve(__dirname, '../.local/backups');
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const backup = path.join(folder, `production-behring-obsolete-session-${Date.now()}.json.gz`);
    fs.writeFileSync(backup, zlib.gzipSync(Buffer.from(JSON.stringify({ target: TARGET,
      createdAt: new Date().toISOString(), fingerprint: before.fingerprint,
      documents: before.all.map(doc => ({ path: doc.ref.path, exists: doc.exists,
        ...(doc.exists ? { data: encode(doc.data()) } : {}) })) }))), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ backup }));
    await db.runTransaction(async transaction => {
      const current = await inventory(transaction);
      assert.equal(current.fingerprint, before.fingerprint, 'Records changed after backup; refusing cleanup.');
      const checked = changes(current);
      assert.deepStrictEqual(checked, next);
      transaction.update(refs[0], { venues: next.event.venues,
        'competitionScheduleState.revision': next.event.competitionScheduleState.revision });
      transaction.update(refs[1], { revision: next.plan.revision });
    });
    const after = await inventory();
    assert.deepStrictEqual(after.all.map(doc => doc.ref.path), before.all.map(doc => doc.ref.path), 'Document set changed.');
    for (const previous of before.all) {
      const current = after.all.find(doc => doc.ref.path === previous.ref.path);
      const expected = previous.ref.path === refs[0].path ? next.event
        : previous.ref.path === refs[1].path ? next.plan : previous.data();
      assert.deepStrictEqual(current.data(), expected, `Unexpected field change at ${previous.ref.path}.`);
      if (![refs[0].path, refs[1].path].includes(previous.ref.path) && previous.exists) {
        assert.ok(current.updateTime.isEqual(previous.updateTime), `Protected document changed at ${previous.ref.path}.`);
      }
    }
    console.log(JSON.stringify({ verified: true, obsoleteTimetableEntriesRemoved: 1,
      documentDeletes: 0, revisionAfter: next.plan.revision, protectedSnapshotsUnchanged: true,
      draftSlotsPreserved: next.plan.draftSlots.length,
      groupsPreserved: after.snapshots.groups.size, orchestraSessionsPreserved: next.event.orchestraSessions.length, backup }));
  } finally {
    clearTimeout(timer);
    await db.terminate();
    await app.delete();
  }
}

module.exports = { TARGET, SESSION_ID, SESSION_KEY, prepareChanges, matchesTarget };
if (require.main === module) run().catch(error => { console.error(error.message); process.exitCode = 1; });
