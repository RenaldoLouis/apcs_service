/** Seed selectable private draft sessions, without assigning groups or publishing.
 * FIRESTORE_EMULATOR_HOST=127.0.0.1:8081 node scripts/seed_local_performer_sessions.js APCS2026 [--apply]
 * Default: read-only preview. No production credentials or application jobs are loaded.
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { Firestore, FieldValue } = require('firebase-admin').firestore;

function buildSeed(event, plan, groups) {
  if (event.competitionScheduleState?.status !== 'draft' || plan.status !== 'draft'
    || !Number.isInteger(plan.revision) || plan.revision !== event.competitionScheduleState.revision) {
    throw new Error('A consistent draft planning state is required.');
  }
  const slots = (plan.draftSlots || []).map(slot => ({ ...slot }));
  const claimed = new Set();
  const competitionGroups = groups.filter(group => (group.purpose || 'competition') === 'competition');
  const linkedIds = competitionGroups.map(group => group.slotId).filter(Boolean);
  if (new Set(linkedIds).size !== linkedIds.length) throw new Error('Multiple groups link the same session.');
  const rows = [];
  // Reserve all existing links before matching unused sessions to unlinked groups.
  for (const group of competitionGroups.filter(item => item.slotId)) {
    const slot = slots.find(item => item.slotId === group.slotId);
    if (!slot || slot.venueId !== group.venueId || slot.date !== group.date) {
      throw new Error(`Group ${group.ordinal} has an invalid session link.`);
    }
    claimed.add(slot.slotId);
  }
  let created = 0;
  let timed = 0;
  for (const group of competitionGroups) {
    const date = new Date(`${group.date}T00:00:00Z`);
    if (!(event.venues || []).some(venue => venue.id === group.venueId)
      || !/^\d{4}-\d{2}-\d{2}$/.test(group.date || '') || Number.isNaN(date.getTime())
      || date.toISOString().slice(0, 10) !== group.date) {
      throw new Error(`Group ${group.ordinal} needs a valid venue and date.`);
    }
    const seedId = `slot_local_${group.id}`;
    let slot = group.slotId ? slots.find(item => item.slotId === group.slotId)
      : slots.find(item => item.slotId === seedId && !claimed.has(item.slotId)
        && item.venueId === group.venueId && item.date === group.date)
        || slots.find(item => !claimed.has(item.slotId) && item.venueId === group.venueId && item.date === group.date);
    let action = group.slotId ? 'already linked' : 'reuse';
    if (!slot) {
      if (slots.some(item => item.slotId === seedId)) throw new Error(`Seed session for group ${group.ordinal} moved; review it first.`);
      slot = { slotId: seedId, venueId: group.venueId, date: group.date, start: null, end: null };
      slots.push(slot);
      created += 1;
      action = 'create';
    }
    if (Boolean(slot.start) !== Boolean(slot.end)) throw new Error(`Session ${slot.slotId} has an incomplete time range.`);
    if (!slot.start) {
      // One-hour sample sessions every two hours, independently per venue/date.
      const format = hour => `${String(hour).padStart(2, '0')}:00`;
      let hour = 8;
      while (hour <= 22 && slots.some(other => other.slotId !== slot.slotId
        && other.venueId === slot.venueId && other.date === slot.date && other.start && other.end
        && format(hour) < other.end && other.start < format(hour + 1))) hour += 2;
      if (hour > 22) throw new Error(`No sample hour available for ${slot.venueId} on ${slot.date}.`);
      slot.start = format(hour);
      slot.end = format(hour + 1);
      timed += 1;
      if (action !== 'create') action = 'set sample time';
    }
    claimed.add(slot.slotId);
    rows.push({ group: group.ordinal, label: group.label, venueId: group.venueId, date: group.date,
      slotId: slot.slotId, time: `${slot.start}-${slot.end}`, action });
  }
  if (slots.length > 100) throw new Error('The draft session limit is 100.');
  return { slots, rows, created, timed, groupCount: groups.length, skippedAttendance: groups.length - competitionGroups.length };
}

async function main() {
  if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8081') {
    throw new Error('This script requires FIRESTORE_EMULATOR_HOST=127.0.0.1:8081; production is refused.');
  }
  const [eventId, flag] = process.argv.slice(2);
  if (!eventId || !/^[A-Za-z0-9_-]{1,100}$/.test(eventId) || (flag && flag !== '--apply') || process.argv.length > 4) {
    throw new Error('Usage: node scripts/seed_local_performer_sessions.js <eventId> [--apply]');
  }
  const db = new Firestore({ projectId: 'apcs-profile' });
  try {
    const eventRef = db.doc(`events/${eventId}`);
    const planRef = db.doc(`competitionSessionPlans/${eventId}`);
    const groupQuery = planRef.collection('groups').orderBy('ordinal');
    async function read(reader) {
      const [eventSnap, planSnap, groupSnap] = await Promise.all([
        reader.get(eventRef), reader.get(planRef), reader.get(groupQuery),
      ]);
      if (!eventSnap.exists || !planSnap.exists || groupSnap.empty) throw new Error('Event, plan and saved groups must exist locally.');
      return { event: eventSnap.data(), plan: planSnap.data(), groups: groupSnap.docs.map(doc => ({ ...doc.data(), id: doc.id })) };
    }
    const directReader = { get: reference => reference.get() };
    const before = await read(directReader);
    const seed = buildSeed(before.event, before.plan, before.groups);
    console.log(JSON.stringify({ mode: flag ? 'apply' : 'preview', eventId, host: process.env.FIRESTORE_EMULATOR_HOST,
      groupCount: seed.groupCount, skippedAttendance: seed.skippedAttendance, created: seed.created, timed: seed.timed,
      totalSessions: seed.slots.length, sessions: seed.rows }, null, 2));
    if (flag !== '--apply' || (seed.created === 0 && seed.timed === 0)) return;
    const backupDir = path.resolve(__dirname, '../.local/performer-session-seeds');
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = path.join(backupDir, `${eventId}-${Date.now()}-${randomUUID()}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ eventId, host: process.env.FIRESTORE_EMULATOR_HOST, before }, null, 2), { mode: 0o600, flag: 'wx' });
    const revision = await db.runTransaction(async transaction => {
      const current = await read(transaction);
      if (JSON.stringify(current) !== JSON.stringify(before)) throw new Error('Local plan changed since preview; rerun after refreshing.');
      const nextRevision = current.plan.revision + 1;
      transaction.update(planRef, { draftSlots: seed.slots, revision: nextRevision, updatedAt: FieldValue.serverTimestamp() });
      transaction.update(eventRef, { 'competitionScheduleState.revision': nextRevision });
      // Match saveSlot: linked groups cache their slot's times.
      for (const group of current.groups) {
        const slot = seed.slots.find(item => item.slotId === group.slotId);
        const original = current.plan.draftSlots.find(item => item.slotId === group.slotId);
        if (slot && original && (slot.start !== original.start || slot.end !== original.end)) {
          transaction.update(planRef.collection('groups').doc(group.id), {
            start: slot.start, end: slot.end, updatedAt: FieldValue.serverTimestamp(),
          });
        }
      }
      return nextRevision;
    });
    const after = await read(directReader);
    const expectedGroups = before.groups.map(group => {
      const slot = seed.slots.find(item => item.slotId === group.slotId);
      const original = before.plan.draftSlots.find(item => item.slotId === group.slotId);
      return slot && original && (slot.start !== original.start || slot.end !== original.end)
        ? { ...group, start: slot.start, end: slot.end, updatedAt: after.groups.find(item => item.id === group.id).updatedAt }
        : group;
    });
    if (JSON.stringify(after.plan.draftSlots) !== JSON.stringify(seed.slots)
      || after.plan.revision !== revision || after.event.competitionScheduleState.revision !== revision
      || JSON.stringify(after.groups) !== JSON.stringify(expectedGroups)) throw new Error('Post-write verification failed; inspect backup.');
    console.log(JSON.stringify({ verified: true, revision, created: seed.created, timed: seed.timed, totalSessions: seed.slots.length, backupPath }, null, 2));
  } finally {
    await db.terminate();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildSeed };
