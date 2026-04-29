const SystemSettingsService = require('../services/SystemSettingsService');

/** GET /api/v1/apcs/systemSettings/global */
async function getGlobalSettings(req, res, next) {
    try {
        const data = await SystemSettingsService.getGlobalSettings();
        res.status(200).json(data);
    } catch (err) {
        next(err);
    }
}

/** POST /api/v1/apcs/systemSettings/global */
async function updateGlobalSettings(req, res, next) {
    try {
        const data = await SystemSettingsService.updateGlobalSettings(req.body);
        res.status(200).json(data);
    } catch (err) {
        next(err);
    }
}

module.exports = {
    getGlobalSettings,
    updateGlobalSettings,
};
