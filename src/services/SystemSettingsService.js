const SystemSettingsRepository = require('../repositories/SystemSettingsRepository');
const databaseUtil = require('../utils/DatabaseUtil');

async function getGlobalSettings() {
    return databaseUtil.executeDatabaseOperation(SystemSettingsRepository.getGlobalSettings, null);
}

async function updateGlobalSettings(body) {
    return databaseUtil.executeDatabaseOperation(SystemSettingsRepository.updateGlobalSettings, body);
}

module.exports = {
    getGlobalSettings,
    updateGlobalSettings,
};
