const { randomUUID } = require('crypto');
const { db, admin } = require('../configs/firebase-init');

const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const fail = message => Object.assign(new Error(message), { statusCode: 409, isOperational: true });
const validKey = value => typeof value === 'string' && value.length > 0 && value.length < 200 && !value.includes('/');
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const validTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '');
const groupCollection = eventId => db.collection('competitionSessionPlans').doc(eventId).collection('groups');
const stateOf = event => event.competitionScheduleState || null;
const publicActivity = eventId => db.collection('publicBookings').where('eventId', '==', eventId);
const hasActiveBookings = snap => snap.docs.some(doc => doc.data().paymentStatus !== 'archived_test');
const seatActivity = eventId => db.collection(`seats${eventId}`).limit(1);
const capacityActivity = eventId => db.collection('ticketCapacity').where('eventId', '==', eventId).limit(1);
const ownershipActivity = eventId => db.collection('ticketSeatOwnership').where('eventId', '==', eventId).limit(1);

function groupIdFor() {
  return `plan_${randomUUID()}`;
}

function slotIdFor() {
  return `slot_${randomUUID()}`;
}

function validateSlot(slot, event, otherSlots) {
  if (!validKey(slot.venueId) || !(event.venues || []).some(venue => venue.id === slot.venueId)) throw fail('Select an event venue.');
  if (!validDate(slot.date)) throw fail('Select a valid date.');
  if (Boolean(slot.start) !== Boolean(slot.end) || (slot.start && (!validTime(slot.start) || !validTime(slot.end) || slot.start >= slot.end))) {
    throw fail('Enter a valid start and end time, or leave both empty.');
  }
  if (slot.start && otherSlots.some(other => other.venueId === slot.venueId && other.date === slot.date
    && other.start && slot.start < other.end && other.start < slot.end)) throw fail('Draft session times overlap.');
}

async function saveSlot(eventId, expectedRevision, data) {
  if (!validKey(eventId) || !Number.isInteger(expectedRevision) || !data || typeof data !== 'object') throw fail('Invalid draft session.');
  return db.runTransaction(async transaction => {
    const eventRef = db.collection('events').doc(eventId);
    const planRef = db.collection('competitionSessionPlans').doc(eventId);
    const [eventSnap, planSnap, groupsSnap] = await Promise.all([
      transaction.get(eventRef), transaction.get(planRef), transaction.get(groupCollection(eventId)),
    ]);
    if (!eventSnap.exists || !planSnap.exists) throw fail('Start planning on the Admin Page first.');
    const event = eventSnap.data();
    if (stateOf(event)?.status !== 'draft' || stateOf(event).revision !== expectedRevision
      || planSnap.data().revision !== expectedRevision) throw fail('Draft changed. Refresh before editing sessions.');
    const slots = planSnap.data().draftSlots || [];
    if (slots.length >= 100 && !data.slotId) throw fail('Too many draft sessions.');
    if (data.slotId && !slots.some(slot => slot.slotId === data.slotId)) throw fail('Draft session no longer exists.');
    const slotId = data.slotId || slotIdFor();
    if (!validKey(slotId)) throw fail('Invalid draft session ID.');
    const slot = { slotId, venueId: data.venueId, date: data.date, start: data.start || null, end: data.end || null };
    const linked = groupsSnap.docs.filter(doc => doc.data().slotId === slotId);
    if (linked.some(doc => doc.data().venueId !== slot.venueId || doc.data().date !== slot.date)) {
      throw fail('Unlink the group before changing this session venue or date.');
    }
    validateSlot(slot, event, slots.filter(other => other.slotId !== slotId));
    const nextSlots = data.slotId ? slots.map(other => other.slotId === slotId ? slot : other) : [...slots, slot];
    const revision = expectedRevision + 1;
    transaction.update(planRef, { draftSlots: nextSlots, revision, updatedAt: stamp() });
    transaction.update(eventRef, { 'competitionScheduleState.revision': revision });
    linked.forEach(doc => transaction.update(doc.ref, { start: slot.start, end: slot.end, updatedAt: stamp() }));
    return { eventId, status: 'draft', revision, draftSlots: nextSlots };
  });
}

async function deleteSlot(eventId, slotId, expectedRevision) {
  if (!validKey(eventId) || !validKey(slotId) || !Number.isInteger(expectedRevision)) throw fail('Invalid draft session.');
  return db.runTransaction(async transaction => {
    const eventRef = db.collection('events').doc(eventId);
    const planRef = db.collection('competitionSessionPlans').doc(eventId);
    const [eventSnap, planSnap, groupsSnap] = await Promise.all([
      transaction.get(eventRef), transaction.get(planRef), transaction.get(groupCollection(eventId)),
    ]);
    if (!eventSnap.exists || !planSnap.exists || stateOf(eventSnap.data())?.status !== 'draft'
      || stateOf(eventSnap.data()).revision !== expectedRevision || planSnap.data().revision !== expectedRevision) {
      throw fail('Draft changed. Refresh before deleting sessions.');
    }
    if (groupsSnap.docs.some(doc => doc.data().slotId === slotId)) throw fail('Unlink this session from its group first.');
    const slots = planSnap.data().draftSlots || [];
    if (!slots.some(slot => slot.slotId === slotId)) throw fail('Draft session no longer exists.');
    const revision = expectedRevision + 1;
    transaction.update(planRef, { draftSlots: slots.filter(slot => slot.slotId !== slotId), revision, updatedAt: stamp() });
    transaction.update(eventRef, { 'competitionScheduleState.revision': revision });
    return { eventId, status: 'draft', revision };
  });
}

function hasLegacyCompetitionSlots(event) {
  return (event.venues || []).some(venue => Object.entries(venue.sessions || {}).some(([date, times]) =>
    times.some(time => ![...(event.orchestraSessions || []), ...(event.masterclassSessions || [])]
      .some(session => session.venue === venue.id && session.date === date && session.time === time))));
}

function validateGroup(data, eventId, event, others) {
  const { venueId, date, ordinal, label, start, end, registrantIds } = data;
  if (!validKey(venueId) || !(event.venues || []).some(v => v.id === venueId)) throw fail('Select an event venue.');
  if (!validDate(date)) throw fail('Select a valid date.');
  if (!Number.isInteger(ordinal) || ordinal < 1) throw fail('Group number must be a positive integer.');
  if (typeof label !== 'string' || !label.trim()) throw fail('Group label is required.');
  if (!Array.isArray(registrantIds) || registrantIds.some(id => !validKey(id))) throw fail('Invalid registrant IDs.');
  if (new Set(registrantIds).size !== registrantIds.length) throw fail('Duplicate registrants in group.');
  if (Boolean(start) !== Boolean(end) || (start && (!validTime(start) || !validTime(end) || start >= end))) {
    throw fail('Enter a valid start and end time, or leave both empty.');
  }
  if (others.some(g => g.ordinal === ordinal)) throw fail('Group number is already used.');
  if (others.some(g => g.registrantIds.some(id => registrantIds.includes(id)))) throw fail('A registrant is already in another group.');
}

async function getGroups(eventId) {
  const snap = await groupCollection(eventId).get();
  return snap.docs.map(doc => ({ ...doc.data(), groupId: doc.id })).sort((a, b) => a.ordinal - b.ordinal);
}

async function getPlanningState(eventId) {
  if (!validKey(eventId)) throw fail('Invalid event.');
  const [eventSnap, groups] = await Promise.all([db.collection('events').doc(eventId).get(), getGroups(eventId)]);
  if (!eventSnap.exists) throw fail('Event not found.');
  const state = stateOf(eventSnap.data()) || { status: 'legacy', revision: 0 };
  const planSnap = await db.collection('competitionSessionPlans').doc(eventId).get();
  return { eventId, ...state, draftSlots: planSnap.data()?.draftSlots || [], groups };
}

async function saveGroup(eventId, data) {
  if (!validKey(eventId)) throw fail('Invalid event.');
  const id = data.groupId || groupIdFor();
  if (!validKey(id)) throw fail('Invalid group ID.');
  return db.runTransaction(async transaction => {
    const eventRef = db.collection('events').doc(eventId);
    const planRef = db.collection('competitionSessionPlans').doc(eventId);
    const [eventSnap, planSnap, groupSnap, bookingSnap, seatsSnap, capacitySnap, ownershipSnap, assignmentSnap] = await Promise.all([
      transaction.get(eventRef), transaction.get(planRef), transaction.get(groupCollection(eventId)),
      transaction.get(publicActivity(eventId)), transaction.get(seatActivity(eventId)),
      transaction.get(capacityActivity(eventId)), transaction.get(ownershipActivity(eventId)),
      transaction.get(db.collection('sessionAssignments').doc(eventId)),
    ]);
    if (!eventSnap.exists) throw fail('Event not found.');
    const event = eventSnap.data();
    const state = stateOf(event);
    if (state && state.status !== 'draft') throw fail('Published groups cannot be edited.');
    if (state?.resetInProgress) throw fail('Ticketing reset is still in progress.');
    if (!state && (hasActiveBookings(bookingSnap) || !seatsSnap.empty || !capacitySnap.empty || !ownershipSnap.empty
      || Object.keys(assignmentSnap.data()?.assignments || {}).length || hasLegacyCompetitionSlots(event))) {
      throw fail('Existing competition sessions, ticket inventory or assignments require reconciliation before planning can start.');
    }
    const existing = groupSnap.docs.find(doc => doc.id === id);
    if (data.groupId && !existing) throw fail('Group no longer exists. Refresh the page.');
    const others = groupSnap.docs.filter(doc => doc.id !== id).map(doc => doc.data());
    const slot = (planSnap.data()?.draftSlots || []).find(item => item.slotId === data.slotId);
    if (data.slotId && (!slot || slot.venueId !== data.venueId || slot.date !== data.date
      || others.some(group => group.slotId === data.slotId))) throw fail('Select an unused session for this venue and date.');
    const groupData = { ...data, start: slot?.start || null, end: slot?.end || null };
    validateGroup(groupData, eventId, event, others);
    const revision = (state?.revision || 0) + 1;
    const group = {
      groupId: id, eventId, venueId: data.venueId, date: data.date, ordinal: data.ordinal,
      label: data.label.trim(), slotId: data.slotId || null, start: groupData.start, end: groupData.end,
      registrantIds: data.registrantIds, updatedAt: stamp(),
    };
    transaction.set(groupCollection(eventId).doc(id), { ...group, createdAt: existing?.data().createdAt || stamp() });
    transaction.set(planRef, { eventId, status: 'draft', revision, updatedAt: stamp() }, { merge: true });
    transaction.update(eventRef, { competitionScheduleState: { status: 'draft', revision } });
    return { ...group, revision };
  });
}

// The board saves its complete draft in one transaction. A performer moved from
// one group to another must never be persisted in only one of the two groups.
async function saveDraft(eventId, expectedRevision, proposedGroups) {
  if (!validKey(eventId) || !Number.isInteger(expectedRevision) || expectedRevision < 0
    || !Array.isArray(proposedGroups) || proposedGroups.length > 100
    || proposedGroups.some(group => !group || typeof group !== 'object' || Array.isArray(group))) throw fail('Invalid draft board.');
  return db.runTransaction(async transaction => {
    const eventRef = db.collection('events').doc(eventId);
    const planRef = db.collection('competitionSessionPlans').doc(eventId);
    const [eventSnap, planSnap, groupSnap, bookingSnap, seatsSnap, capacitySnap, ownershipSnap, assignmentSnap] = await Promise.all([
      transaction.get(eventRef), transaction.get(planRef), transaction.get(groupCollection(eventId)),
      transaction.get(publicActivity(eventId)), transaction.get(seatActivity(eventId)),
      transaction.get(capacityActivity(eventId)), transaction.get(ownershipActivity(eventId)),
      transaction.get(db.collection('sessionAssignments').doc(eventId)),
    ]);
    if (!eventSnap.exists) throw fail('Event not found.');
    const event = eventSnap.data();
    const state = stateOf(event);
    if (state?.resetInProgress || (state && state.status !== 'draft')) throw fail('Published groups cannot be edited.');
    if ((state?.revision || 0) !== expectedRevision || (planSnap.exists && planSnap.data().revision !== expectedRevision)) {
      throw fail('Draft changed. Refresh before saving.');
    }
    if (!state && (hasActiveBookings(bookingSnap) || !seatsSnap.empty || !capacitySnap.empty || !ownershipSnap.empty
      || Object.keys(assignmentSnap.data()?.assignments || {}).length || hasLegacyCompetitionSlots(event))) {
      throw fail('Existing competition sessions, ticket inventory or assignments require reconciliation before planning can start.');
    }
    const existing = new Map(groupSnap.docs.map(doc => [doc.id, doc.data()]));
    const groups = proposedGroups.map((group, index) => ({
      ...group,
      groupId: group.groupId || groupIdFor(),
      eventId,
      ordinal: index + 1,
    }));
    if (groups.some(group => !validKey(group.groupId)) || new Set(groups.map(group => group.groupId)).size !== groups.length) {
      throw fail('Duplicate or invalid group IDs.');
    }
    const slots = planSnap.data()?.draftSlots || [];
    groups.forEach((group, index) => {
      const slot = slots.find(item => item.slotId === group.slotId);
      if (group.slotId && (!slot || slot.venueId !== group.venueId || slot.date !== group.date
        || groups.some((other, otherIndex) => otherIndex !== index && other.slotId === group.slotId))) {
        throw fail('Select an unused session for each group venue and date.');
      }
      group.start = slot?.start || null;
      group.end = slot?.end || null;
      validateGroup(group, eventId, event, groups.filter((_, other) => other !== index));
    });
    for (const group of groups) {
      transaction.set(groupCollection(eventId).doc(group.groupId), {
        groupId: group.groupId, eventId, venueId: group.venueId, date: group.date,
        ordinal: group.ordinal, label: group.label.trim(), slotId: group.slotId || null, start: group.start || null,
        end: group.end || null, registrantIds: group.registrantIds,
        createdAt: existing.get(group.groupId)?.createdAt || stamp(), updatedAt: stamp(),
      });
    }
    for (const id of existing.keys()) {
      if (!groups.some(group => group.groupId === id)) transaction.delete(groupCollection(eventId).doc(id));
    }
    const revision = expectedRevision + 1;
    transaction.set(planRef, { eventId, status: 'draft', revision, updatedAt: stamp() }, { merge: true });
    transaction.update(eventRef, { competitionScheduleState: { status: 'draft', revision } });
    return { eventId, status: 'draft', revision, draftSlots: slots, groups };
  });
}

async function deleteGroup(eventId, groupId) {
  if (!validKey(eventId) || !validKey(groupId)) throw fail('Invalid group.');
  return db.runTransaction(async transaction => {
    const eventRef = db.collection('events').doc(eventId);
    const groupRef = groupCollection(eventId).doc(groupId);
    const [eventSnap, groupSnap] = await Promise.all([transaction.get(eventRef), transaction.get(groupRef)]);
    if (!groupSnap.exists) throw fail('Group not found.');
    const state = stateOf(eventSnap.data() || {});
    if (state?.status !== 'draft') throw fail('Only draft groups can be deleted.');
    const revision = state.revision + 1;
    transaction.delete(groupRef);
    transaction.update(eventRef, { 'competitionScheduleState.revision': revision });
    transaction.update(db.collection('competitionSessionPlans').doc(eventId), { revision, updatedAt: stamp() });
    return { deleted: true, groupId, revision };
  });
}

function validatePublication(groups, event, existingAssignments, draftSlots = []) {
  const errors = [];
  if (!groups.length) errors.push('Add at least one group.');
  const linkedSlotIds = new Set();
  for (const group of groups) {
    const slot = draftSlots.find(item => item.slotId === group.slotId);
    if (!slot || slot.venueId !== group.venueId || slot.date !== group.date) {
      errors.push(`Group ${group.ordinal}: select a draft session for its venue and date.`);
    } else if (linkedSlotIds.has(slot.slotId)) {
      errors.push(`Session ${slot.slotId} is linked to multiple groups.`);
    } else {
      linkedSlotIds.add(slot.slotId);
      group.start = slot.start;
      group.end = slot.end;
    }
  }
  if (draftSlots.some(slot => !linkedSlotIds.has(slot.slotId))) errors.push('Assign every draft session to a group or delete unused sessions.');
  const seen = new Set();
  const slots = [];
  for (const g of groups) {
    if (!g.start || !g.end || !validTime(g.start) || !validTime(g.end) || g.start >= g.end) {
      errors.push(`Group ${g.ordinal}: enter a valid final time.`);
      continue;
    }
    if (!validDate(g.date) || !(event.venues || []).some(v => v.id === g.venueId)) errors.push(`Group ${g.ordinal}: invalid venue or date.`);
    if (!Array.isArray(g.registrantIds) || !g.registrantIds.length) errors.push(`Group ${g.ordinal}: assign a registrant.`);
    for (const id of g.registrantIds || []) {
      if (seen.has(id)) errors.push(`Registrant ${id} is in multiple groups.`);
      seen.add(id);
    }
    const time = `${g.start}-${g.end}`;
    const key = `${g.venueId}_${g.date}_${time}`;
    if (existingAssignments[key]) errors.push(`Group ${g.ordinal}: published assignment already exists.`);
    const oldTime = (event.venues || []).find(v => v.id === g.venueId)?.sessions?.[g.date] || [];
    if (oldTime.some(existing => {
      const [oldStart, oldEnd] = existing.split('-');
      return oldStart && oldEnd && g.start < oldEnd && oldStart < g.end;
    })) errors.push(`Group ${g.ordinal}: overlaps an existing venue time.`);
    for (const special of [...(event.orchestraSessions || []), ...(event.masterclassSessions || [])]) {
      if (special.venue !== g.venueId || special.date !== g.date) continue;
      const [start, end] = String(special.time || '').split('-');
      if (start && end && g.start < end && start < g.end) errors.push(`Group ${g.ordinal}: overlaps an orchestra or Masterclass session.`);
    }
    for (const slot of slots) {
      if (slot.venueId === g.venueId && slot.date === g.date && g.start < slot.end && slot.start < g.end) {
        errors.push(`Groups ${slot.ordinal} and ${g.ordinal} overlap.`);
      }
    }
    slots.push({ ...g, time, key });
  }
  return { errors, slots };
}

async function previewPublication(eventId) {
  const [eventSnap, planSnap, groups, assignments] = await Promise.all([
    db.collection('events').doc(eventId).get(),
    db.collection('competitionSessionPlans').doc(eventId).get(), getGroups(eventId),
    db.collection('sessionAssignments').doc(eventId).get(),
  ]);
  if (!eventSnap.exists) throw fail('Event not found.');
  const state = stateOf(eventSnap.data());
  if (state?.status !== 'draft') throw fail('Create a draft before previewing.');
  const { errors } = validatePublication(groups, eventSnap.data(), assignments.data()?.assignments || {}, planSnap.data()?.draftSlots || []);
  return { eventId, revision: state.revision, canPublish: !errors.length, errors, groups };
}

async function publish(eventId, expectedRevision, actor) {
  if (!validKey(eventId) || !actor?.uid) throw fail('Admin identity and event are required.');
  return db.runTransaction(async transaction => {
    const eventRef = db.collection('events').doc(eventId);
    const assignmentRef = db.collection('sessionAssignments').doc(eventId);
    const [eventSnap, planSnap, groupSnap, assignmentSnap, bookingSnap, seatsSnap, capacitySnap, ownershipSnap] = await Promise.all([
      transaction.get(eventRef), transaction.get(db.collection('competitionSessionPlans').doc(eventId)),
      transaction.get(groupCollection(eventId)), transaction.get(assignmentRef),
      transaction.get(publicActivity(eventId)), transaction.get(seatActivity(eventId)),
      transaction.get(capacityActivity(eventId)), transaction.get(ownershipActivity(eventId)),
    ]);
    if (!eventSnap.exists || !planSnap.exists) throw fail('No draft plan found.');
    const event = eventSnap.data();
    const state = stateOf(event);
    if (state?.status !== 'draft' || state.resetInProgress || state.revision !== expectedRevision || planSnap.data().revision !== expectedRevision) {
      throw fail('Schedule changed. Refresh before publishing.');
    }
    if (hasActiveBookings(bookingSnap) || !seatsSnap.empty || !capacitySnap.empty || !ownershipSnap.empty) throw fail('Existing ticket activity requires reconciliation before publication.');
    const groups = groupSnap.docs.map(doc => doc.data());
    const previousAssignments = assignmentSnap.data()?.assignments || {};
    const { errors, slots } = validatePublication(groups, event, previousAssignments, planSnap.data().draftSlots || []);
    if (errors.length) throw fail(`Publication blocked: ${errors.join(' ')}`);
    const registrantIds = [...new Set(groups.flatMap(group => group.registrantIds))];
    const registrants = await Promise.all(registrantIds.map(id => transaction.get(db.collection('Registrants2025').doc(id))));
    if (registrants.some(doc => !doc.exists || doc.data().eventId !== eventId)) {
      throw fail('Every performer must be registered for this event.');
    }
    const assignments = { ...previousAssignments };
    const venues = (event.venues || []).map(venue => {
      const sessions = { ...(venue.sessions || {}) };
      for (const slot of slots.filter(g => g.venueId === venue.id)) {
        sessions[slot.date] = [...(sessions[slot.date] || []), slot.time].sort();
        assignments[slot.key] = slot.registrantIds.map((registrantId, order) => ({ registrantId, order }));
      }
      return { ...venue, sessions };
    });
    const revision = expectedRevision + 1;
    const nextState = { status: 'published', revision, publishedAt: stamp() };
    transaction.update(eventRef, { venues, competitionScheduleState: nextState });
    transaction.update(db.collection('competitionSessionPlans').doc(eventId), { status: 'published', revision, publishedAt: stamp() });
    transaction.set(assignmentRef, { eventId, assignments, updatedAt: stamp() });
    return { eventId, status: 'published', revision, publishedSlots: slots.length };
  });
}

async function markReady(eventId, actor) {
  if (!validKey(eventId) || !actor?.uid) throw fail('Admin identity and event are required.');
  return db.runTransaction(async transaction => {
    const eventRef = db.collection('events').doc(eventId);
    const [eventSnap, groupsSnap, settingsSnap, assignmentSnap] = await Promise.all([
      transaction.get(eventRef), transaction.get(groupCollection(eventId)),
      transaction.get(db.collection('systemSettings').doc('global')),
      transaction.get(db.collection('sessionAssignments').doc(eventId)),
    ]);
    if (!eventSnap.exists) throw fail('Event not found.');
    const event = eventSnap.data();
    const state = stateOf(event);
    if (state?.status !== 'published') throw fail('Only published plans can be checked.');
    const groups = groupsSnap.docs.map(doc => doc.data());
    if (!groups.length) throw fail('No published groups.');
    const issues = [];
    const eligibility = settingsSnap.data()?.ticketEligibility;
    if (eligibility?.enabled && !(eligibility.schedule || []).some(day =>
      Array.isArray(day.allowedTiers) && day.allowedTiers.length > 0)) {
      issues.push('Ticket sale eligibility schedule has no allowed tiers.');
    }
    for (const group of groups) {
      const venue = (event.venues || []).find(v => v.id === group.venueId);
      const sessionId = `${group.date}_${group.start}-${group.end}`;
      const time = `${group.start}-${group.end}`;
      const assignmentKey = `${group.venueId}_${group.date}_${time}`;
      const assigned = (assignmentSnap.data()?.assignments || {})[assignmentKey] || [];
      if (!(venue?.sessions?.[group.date] || []).includes(time)
        || assigned.map(item => item.registrantId).join('|') !== group.registrantIds.join('|')) {
        issues.push(`${group.label}: published time or performer assignment changed.`);
      }
      const configs = venue?.seatConfig || [];
      const expected = configs.reduce((sum, config) => sum + Number(config.seatCount || 0), 0);
      if (!expected || configs.some(c => !Number.isInteger(Number(c.seatCount)) || Number(c.seatCount) < 0)) {
        issues.push(`${group.label}: invalid seat configuration.`);
        continue;
      }
      const snap = await transaction.get(db.collection(`seats${eventId}`).where('venueId', '==', group.venueId).where('sessionId', '==', sessionId));
      const actual = new Set(snap.docs.map(doc => `${doc.data().areaType}|${doc.data().row}|${doc.data().number}`));
      const expectedSeats = new Set(configs.flatMap(config => Array.from({ length: Number(config.seatCount) }, (_, index) =>
        `${config.areaType}|${config.row}|${index + 1}`)));
      if (snap.size !== expected || actual.size !== expected || [...expectedSeats].some(seat => !actual.has(seat))) {
        issues.push(`${group.label}: incomplete numbered seat inventory.`);
      }
      for (const config of configs) {
        const tier = (event.ticketTiers || []).find(t => String(t.id).toLowerCase() === String(config.areaType).toLowerCase());
        const price = tier?.venuePrices?.[group.venueId];
        if (price === null || price === undefined || !Number.isFinite(Number(price)) || Number(price) < 0) {
          issues.push(`${group.label}: missing venue price for ${config.areaType}.`);
        }
      }
    }
    if (issues.length) return { eventId, status: 'published', ready: false, issues };
    const revision = state.revision + 1;
    transaction.update(eventRef, { 'competitionScheduleState.status': 'ready', 'competitionScheduleState.revision': revision, 'competitionScheduleState.readyAt': stamp() });
    transaction.update(db.collection('competitionSessionPlans').doc(eventId), { status: 'ready', revision, readyAt: stamp() });
    return { eventId, status: 'ready', revision, ready: true };
  });
}

module.exports = { groupIdFor, getGroups, getPlanningState, saveGroup, saveDraft, deleteGroup, saveSlot, deleteSlot, previewPublication, publish, markReady };
