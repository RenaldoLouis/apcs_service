const { service } = require('../services/GroupAnnouncementEmailRuntime');

for (const operation of ['preview', 'test', 'send', 'status']) {
    exports[operation] = async (req, res, next) => {
        try { res.status(operation === 'send' ? 202 : 200).json(await service[operation](req.body || {}, req.ticketingAdmin)); }
        catch (error) { next(error); }
    };
}
