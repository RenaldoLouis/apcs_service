const { randomUUID } = require('crypto');
const { db, admin } = require('../configs/firebase-init');
const { isDisplayTime } = require('../utils/competitionDisplayTime');

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
// Orchestra attendance is independent of a registrant's competition performance assignment.
const GROUP_PURPOSES = ['competition', 'orchestra_attendance'];
const purposeOf = group => group?.purpose || 'competition';
const isAttendanceGroup = group => purposeOf(group) === 'orchestra_attendance';
// Older callers may omit the optional link; retain it when the same attendance
// group stays at the same venue/date. Explicit null clears it.
const withPlannedSession = (data, previous) => ({
  ...data,
  orchestraSessionId: Object.prototype.hasOwnProperty.call(data, 'orchestraSessionId')
    ? data.orchestraSessionId ?? null
    : isAttendanceGroup(data) && isAttendanceGroup(previous)
      && previous.venueId === data.venueId && previous.date === data.date
      ? previous.orchestraSessionId ?? null : null,
});
const attendanceOnlyIds = groups => {
  const performers = new Set(groups.filter(group => !isAttendanceGroup(group)).flatMap(group => group.registrantIds || []));
  return [...new Set(groups.filter(isAttendanceGroup).flatMap(group => group.registrantIds || []))]
    .filter(id => !performers.has(id));
};

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
  if (!GROUP_PURPOSES.includes(purposeOf(data))) throw fail('Select a valid group type.');
  if (isAttendanceGroup(data) && (data.slotId || start || end)) throw fail('Orchestra attendance groups cannot use a performer session.');
  if (!validKey(venueId) || !(event.venues || []).some(v => v.id === venueId)) throw fail('Select an event venue.');
  if (!validDate(date)) throw fail('Select a valid date.');
  if (data.orchestraSessionId != null) {
    const session = (event.orchestraSessions || []).find(item => item.id === data.orchestraSessionId);
    if (!isAttendanceGroup(data) || !validKey(data.orchestraSessionId) || !session
      || session.venue !== venueId || session.date !== date) {
      throw fail('Select an orchestra session for this attendance group venue and date, or clear the planned session.');
    }
  }
  if (!Number.isInteger(ordinal) || ordinal < 1) throw fail('Group number must be a positive integer.');
  if (typeof label !== 'string' || !label.trim()) throw fail('Group label is required.');
  if (!Array.isArray(registrantIds) || registrantIds.some(id => !validKey(id))) throw fail('Invalid registrant IDs.');
  if (new Set(registrantIds).size !== registrantIds.length) throw fail('Duplicate registrants in group.');
  if (Boolean(start) !== Boolean(end) || (start && (!validTime(start) || !validTime(end) || start >= end))) {
    throw fail('Enter a valid start and end time, or leave both empty.');
  }
  if (others.some(g => g.ordinal === ordinal)) throw fail('Group number is already used.');
  if (others.some(g => purposeOf(g) === purposeOf(data) && g.registrantIds.some(id => registrantIds.includes(id)))) {
    throw fail('A registrant is already in another group of this type.');
  }
}

async function getGroups(eventId) {
  const snap = await groupCollection(eventId).get();
  return snap.docs.map(doc => ({ ...doc.data(), groupId: doc.id, purpose: purposeOf(doc.data()) })).sort((a, b) => a.ordinal - b.ordinal);
}

async function getPlanningState(eventId) {
  if (!validKey(eventId)) throw fail('Invalid event.');
  const [eventSnap, groups] = await Promise.all([db.collection('events').doc(eventId).get(), getGroups(eventId)]);
  if (!eventSnap.exists) throw fail('Event not found.');
  const state = stateOf(eventSnap.data()) || { status: 'legacy', revision: 0 };
  const planSnap = await db.collection('competitionSessionPlans').doc(eventId).get();
  return { eventId, ...state, draftSlots: planSnap.data()?.draftSlots || [], groups,
    competitionTimeDisplay: eventSnap.data().competitionTimeDisplay || { revision: 0, times: {} } };
}

// A narrow published-copy exception. The timetable, plan and assignment projection are read only.
async function saveDisplayTime(eventId, data) {
  if (!validKey(eventId) || !data || !validKey(data.groupId)
    || !Number.isInteger(data.expectedRevision) || data.expectedRevision < 0
    || typeof data.displayTime !== 'string' || data.displayTime.length > 30
    || Object.keys(data).some(key => !['groupId', 'expectedRevision', 'displayTime'].includes(key))) {
    throw fail('Invalid display time revision.');
  }
  const displayTime = data.displayTime.trim().replace(/\s*[–—-]\s*/g, '-');
  if (displayTime && !isDisplayTime(displayTime)) throw fail('Enter a time range such as 11:10-13:30, with the end after the start.');
  return db.runTransaction(async transaction => {
    const eventRef = db.collection('events').doc(eventId);
    const [eventSnap, planSnap, groupsSnap, assignmentSnap] = await Promise.all([
      transaction.get(eventRef), transaction.get(db.collection('competitionSessionPlans').doc(eventId)),
      transaction.get(groupCollection(eventId)), transaction.get(db.collection('sessionAssignments').doc(eventId)),
    ]);
    const event = eventSnap.data();
    const state = event && stateOf(event);
    const plan = planSnap.data();
    if (!eventSnap.exists || !planSnap.exists || !assignmentSnap.exists
      || !['published', 'ready'].includes(state?.status) || state.resetInProgress
      || plan.status !== state.status || plan.revision !== state.revision) {
      throw fail('Only published competition groups can have a display time revision. Refresh the board.');
    }
    const saved = event.competitionTimeDisplay || { revision: 0, times: {} };
    if (saved.revision !== data.expectedRevision) throw fail('Display times changed. Close this dialog and refresh the board before trying again.');
    const group = groupsSnap.docs.find(doc => doc.id === data.groupId)?.data();
    if (!group || isAttendanceGroup(group)) throw fail('Select an existing competition performance group.');
    const time = `${group.start}-${group.end}`;
    const key = `${group.venueId}_${group.date}_${time}`;
    const slot = (plan.draftSlots || []).find(item => item.slotId === group.slotId);
    const entries = assignmentSnap.data()?.assignments?.[key];
    const venue = (event.venues || []).find(item => item.id === group.venueId);
    const special = [...(event.orchestraSessions || []), ...(event.masterclassSessions || [])]
      .some(item => item.venue === group.venueId && item.date === group.date && item.time === time);
    if (!isDisplayTime(time) || !slot || slot.venueId !== group.venueId || slot.date !== group.date
      || slot.start !== group.start || slot.end !== group.end || special
      || !(venue?.sessions?.[group.date] || []).includes(time)
      || groupsSnap.docs.some(doc => doc.id !== data.groupId && !isAttendanceGroup(doc.data())
        && `${doc.data().venueId}_${doc.data().date}_${doc.data().start}-${doc.data().end}` === key)
      || !Array.isArray(group.registrantIds) || !Array.isArray(entries)
      || entries.length !== group.registrantIds.length
      || entries.some((entry, index) => entry.registrantId !== group.registrantIds[index])) {
      throw fail('Published session details differ from the plan. Refresh and reconcile before changing display text.');
    }
    const times = { ...saved.times };
    if (displayTime && displayTime !== time) times[key] = displayTime;
    else delete times[key];
    const competitionTimeDisplay = { revision: saved.revision + 1, times };
    transaction.update(eventRef, { competitionTimeDisplay });
    return { eventId, competitionTimeDisplay };
  });
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
    if (isAttendanceGroup(data) && data.slotId) throw fail('Orchestra attendance groups cannot use a performer session.');
    const slot = (planSnap.data()?.draftSlots || []).find(item => item.slotId === data.slotId);
    if (data.slotId && (!slot || slot.venueId !== data.venueId || slot.date !== data.date
      || others.some(group => group.slotId === data.slotId))) throw fail('Select an unused session for this venue and date.');
    const groupData = withPlannedSession({ ...data, start: slot?.start || null, end: slot?.end || null }, existing?.data());
    validateGroup(groupData, eventId, event, others);
    const revision = (state?.revision || 0) + 1;
    const group = {
      groupId: id, eventId, venueId: data.venueId, date: data.date, ordinal: data.ordinal,
      label: data.label.trim(), purpose: purposeOf(data), slotId: data.slotId || null, start: groupData.start, end: groupData.end,
      orchestraSessionId: groupData.orchestraSessionId,
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
    const groups = proposedGroups.map((group, index) => withPlannedSession({
      ...group,
      groupId: group.groupId || groupIdFor(),
      eventId,
      ordinal: index + 1,
    }, existing.get(group.groupId)));
    if (groups.some(group => !validKey(group.groupId)) || new Set(groups.map(group => group.groupId)).size !== groups.length) {
      throw fail('Duplicate or invalid group IDs.');
    }
    const slots = planSnap.data()?.draftSlots || [];
    if (groups.some(group => isAttendanceGroup(group) && group.slotId)) throw fail('Orchestra attendance groups cannot use a performer session.');
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
        ordinal: group.ordinal, label: group.label.trim(), purpose: purposeOf(group), slotId: group.slotId || null, start: group.start || null,
        end: group.end || null, registrantIds: group.registrantIds,
        orchestraSessionId: group.orchestraSessionId,
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

// Published edits may change only the order of existing competition members.
// Keep the planning source and buyer-facing assignment projection in one transaction.
async function reorderPublished(eventId, expectedRevision, proposedGroups) {
  if (!validKey(eventId) || !Number.isInteger(expectedRevision) || expectedRevision < 0
    || !Array.isArray(proposedGroups) || !proposedGroups.length || proposedGroups.length > 100
    || proposedGroups.some(group => !group || !validKey(group.groupId)
      || Object.keys(group).some(key => !['groupId', 'registrantIds'].includes(key))
      || !Array.isArray(group.registrantIds) || group.registrantIds.some(id => !validKey(id)))
    || new Set(proposedGroups.map(group => group.groupId)).size !== proposedGroups.length) {
    throw fail('Invalid performance order.');
  }
  return db.runTransaction(async transaction => {
    const eventRef = db.collection('events').doc(eventId);
    const planRef = db.collection('competitionSessionPlans').doc(eventId);
    const assignmentRef = db.collection('sessionAssignments').doc(eventId);
    const [eventSnap, planSnap, groupsSnap, assignmentSnap] = await Promise.all([
      transaction.get(eventRef), transaction.get(planRef), transaction.get(groupCollection(eventId)),
      transaction.get(assignmentRef),
    ]);
    const event = eventSnap.data();
    const state = event && stateOf(event);
    if (!eventSnap.exists || !planSnap.exists || !assignmentSnap.exists
      || !['published', 'ready'].includes(state?.status) || state.resetInProgress
      || planSnap.data().status !== state.status || state.revision !== expectedRevision
      || planSnap.data().revision !== expectedRevision) {
      throw fail('Schedule changed. Refresh before saving the performance order.');
    }
    const groups = new Map(groupsSnap.docs.map(doc => [doc.id, doc]));
    const assignments = { ...(assignmentSnap.data().assignments || {}) };
    const changes = [];
    const usedKeys = new Set();
    for (const proposed of proposedGroups) {
      const snapshot = groups.get(proposed.groupId);
      const group = snapshot?.data();
      if (!group || isAttendanceGroup(group)) throw fail('Only existing performance groups can be reordered.');
      const current = group.registrantIds;
      const next = proposed.registrantIds;
      if (!Array.isArray(current) || new Set(current).size !== current.length
        || next.length !== current.length || new Set(next).size !== next.length
        || next.some(id => !current.includes(id))) {
        throw fail('Reordering must keep exactly the same registrants in each group.');
      }
      const time = `${group.start}-${group.end}`;
      const key = `${group.venueId}_${group.date}_${time}`;
      const venue = (event.venues || []).find(item => item.id === group.venueId);
      const slot = (planSnap.data().draftSlots || []).find(item => item.slotId === group.slotId);
      const entries = assignments[key];
      if (!slot || slot.venueId !== group.venueId || slot.date !== group.date
        || slot.start !== group.start || slot.end !== group.end
        || !(venue?.sessions?.[group.date] || []).includes(time) || usedKeys.has(key)
        || groupsSnap.docs.some(doc => doc.id !== snapshot.id && !isAttendanceGroup(doc.data())
          && `${doc.data().venueId}_${doc.data().date}_${doc.data().start}-${doc.data().end}` === key)
        || !Array.isArray(entries) || entries.length !== current.length
        || entries.some((entry, index) => entry.registrantId !== current[index] || entry.order !== index)) {
        throw fail('Published assignments differ from the plan. Refresh and reconcile before reordering.');
      }
      usedKeys.add(key);
      const byId = new Map(entries.map(entry => [entry.registrantId, entry]));
      assignments[key] = next.map((id, order) => ({ ...byId.get(id), order }));
      changes.push({ ref: snapshot.ref, registrantIds: next });
    }
    const revision = expectedRevision + 1;
    changes.forEach(change => transaction.update(change.ref, { registrantIds: change.registrantIds, updatedAt: stamp() }));
    transaction.update(assignmentRef, { assignments, updatedAt: stamp() });
    transaction.update(planRef, { revision, updatedAt: stamp() });
    transaction.update(eventRef, { 'competitionScheduleState.revision': revision });
    return { eventId, status: state.status, revision };
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

function validatePublication(allGroups, event, existingAssignments, draftSlots = []) {
  const errors = [];
  const groups = allGroups.filter(group => !isAttendanceGroup(group));
  const attendanceGroups = allGroups.filter(isAttendanceGroup);
  if (!allGroups.length) errors.push('Add at least one group.');
  else if (!groups.length) errors.push('Add at least one competition group.');
  const seen = new Set();
  // One attendance group and one competition group per registration are allowed.
  const attendanceSeen = new Set();
  for (const group of attendanceGroups) {
    if (group.slotId || group.start || group.end) errors.push(`Group ${group.ordinal}: orchestra attendance groups cannot use a performer session.`);
    for (const id of group.registrantIds || []) {
      if (attendanceSeen.has(id)) errors.push(`Registrant ${id} is in multiple orchestra attendance groups.`);
      attendanceSeen.add(id);
    }
  }
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
  const attendanceRegistrantIds = attendanceOnlyIds(allGroups);
  return { errors, slots, attendanceRegistrantIds };
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
    const { errors, slots, attendanceRegistrantIds } = validatePublication(groups, event, previousAssignments, planSnap.data().draftSlots || []);
    if (errors.length) throw fail(`Publication blocked: ${errors.join(' ')}`);
    const registrantIds = [...new Set(groups.flatMap(group => group.registrantIds))];
    const registrants = await Promise.all(registrantIds.map(id => transaction.get(db.collection('Registrants2025').doc(id))));
    const sourceEventIds = new Map(registrants.map(doc => [doc.id, doc.data()?.eventId || 'APCS2025']));
    if (registrants.some(doc => !doc.exists || !(sourceEventIds.get(doc.id) === eventId
      || (eventId === 'APCS2026' && sourceEventIds.get(doc.id) === 'APCS2025')))) {
      throw fail('A group member is missing or belongs to an unsupported source event.');
    }
    const assignments = { ...previousAssignments };
    const venues = (event.venues || []).map(venue => {
      const sessions = { ...(venue.sessions || {}) };
      for (const slot of slots.filter(g => g.venueId === venue.id)) {
        sessions[slot.date] = [...(sessions[slot.date] || []), slot.time].sort();
        assignments[slot.key] = slot.registrantIds.map((registrantId, order) => ({
          registrantId, order, sourceEventId: sourceEventIds.get(registrantId),
        }));
      }
      return { ...venue, sessions };
    });
    const revision = expectedRevision + 1;
    const nextState = { status: 'published', revision, publishedAt: stamp() };
    transaction.update(eventRef, { venues, competitionScheduleState: nextState });
    transaction.update(db.collection('competitionSessionPlans').doc(eventId), { status: 'published', revision, publishedAt: stamp() });
    // Exclude only attendance members without a competition performance; dual membership stays ticketable.
    transaction.set(assignmentRef, { eventId, assignments, attendanceOnlyRegistrantIds: attendanceRegistrantIds, updatedAt: stamp() });
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
    const allGroups = groupsSnap.docs.map(doc => doc.data());
    if (!allGroups.length) throw fail('No published groups.');
    const groups = allGroups.filter(group => !isAttendanceGroup(group));
    if (!groups.length) throw fail('No published competition groups.');
    const issues = [];
    const expectedAttendance = attendanceOnlyIds(allGroups).sort().join('|');
    const publishedAttendance = [...(assignmentSnap.data()?.attendanceOnlyRegistrantIds || [])].sort().join('|');
    if (expectedAttendance !== publishedAttendance) issues.push('Orchestra attendance groups differ from the published ticketing projection.');
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

module.exports = { groupIdFor, getGroups, getPlanningState, saveGroup, saveDraft, reorderPublished, saveDisplayTime, deleteGroup, saveSlot, deleteSlot, previewPublication, publish, markReady };
