const repository = require('../repositories/TicketRedemptionRepository');
const attendance = require('../repositories/PerformerAttendanceRepository');

const list = async (req, res, next) => {
    try { res.json(await repository.list(req.body)); } catch (error) { next(error); }
};
const detail = async (req, res, next) => {
    try { res.json(await repository.detail(req.body)); } catch (error) { next(error); }
};
const claim = async (req, res, next) => {
    try { res.json(await repository.claim(req.body, req.ticketingAdmin)); } catch (error) { next(error); }
};

const listAttendance = async (req, res, next) => {
    try { res.json(await attendance.list(req.body)); } catch (error) { next(error); }
};
const attendanceCandidates = async (req, res, next) => {
    try { res.json(await attendance.candidates(req.body)); } catch (error) { next(error); }
};
const markPresent = async (req, res, next) => {
    try { res.json(await attendance.markPresent(req.body, req.ticketingAdmin)); } catch (error) { next(error); }
};

module.exports = { list, detail, claim, listAttendance, attendanceCandidates, markPresent };
