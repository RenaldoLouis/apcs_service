const { db } = require('../configs/firebase-init');
const { createAttendanceImporter } = require('../services/RegistrantAttendanceImport');
const importer = createAttendanceImporter(db);

const preview = async (req, res, next) => {
    try { res.json(await importer.preview(req.body)); } catch (error) { next(error); }
};
const apply = async (req, res, next) => {
    try { res.json(await importer.apply(req.body)); } catch (error) { next(error); }
};
module.exports = { preview, apply };
