const { service, workerEnabled } = require('../services/GroupAnnouncementEmailRuntime');
const { logger } = require('../utils/Logger');

function startGroupAnnouncementEmailWorker() {
    if (!workerEnabled) return;
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try { await service.processDue(); }
        catch (error) { logger.error(`[GROUP_EMAIL] Background campaign processing stopped: ${error.message}`); }
        finally { running = false; }
    };
    const startup = setTimeout(run, 15000);
    const interval = setInterval(run, 5000);
    startup.unref?.(); interval.unref?.();
    return () => { clearTimeout(startup); clearInterval(interval); };
}

module.exports = { startGroupAnnouncementEmailWorker };
