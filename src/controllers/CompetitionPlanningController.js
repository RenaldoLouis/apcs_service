const repository = require('../repositories/CompetitionPlanningRepository');
const { requireTicketingAdmin } = require('../middlewares/TicketingAdminMiddleware');

async function getPlanningState(req, res, next) {
  try {
    const { eventId } = req.params;
    const state = await repository.getPlanningState(eventId);
    res.status(200).json(state);
  } catch (error) {
    next(error);
  }
}

async function saveGroup(req, res, next) {
  try {
    const { eventId } = req.params;
    const groupData = req.body;
    groupData.eventId = eventId;
    const result = await repository.saveGroup(eventId, groupData);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

async function saveDraft(req, res, next) {
  try {
    const result = await repository.saveDraft(req.params.eventId, req.body.expectedRevision, req.body.groups);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

async function deleteGroup(req, res, next) {
  try {
    const { eventId, groupId } = req.params;
    const result = await repository.deleteGroup(eventId, groupId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

async function saveSlot(req, res, next) {
  try {
    const result = await repository.saveSlot(req.params.eventId, req.body.expectedRevision, req.body.slot);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

async function deleteSlot(req, res, next) {
  try {
    const result = await repository.deleteSlot(req.params.eventId, req.params.slotId, req.body.expectedRevision);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

async function previewPublication(req, res, next) {
  try {
    const { eventId } = req.params;
    const result = await repository.previewPublication(eventId);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

async function publish(req, res, next) {
  try {
    const { eventId } = req.params;
    const { expectedRevision } = req.body;
    const result = await repository.publish(eventId, expectedRevision, req.ticketingAdmin);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

async function markReady(req, res, next) {
  try {
    const { eventId } = req.params;
    const result = await repository.markReady(eventId, req.ticketingAdmin);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getPlanningState,
  saveGroup,
  saveDraft,
  deleteGroup,
  saveSlot,
  deleteSlot,
  previewPublication,
  publish,
  markReady,
};
