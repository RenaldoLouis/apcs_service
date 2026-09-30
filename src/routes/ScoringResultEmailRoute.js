const express = require('express');
const { requireTicketingAdmin } = require('../middlewares/TicketingAdminMiddleware');
const controller = require('../controllers/ScoringResultEmailController');

const router = express.Router();
// Authenticate before accepting the larger PDF payload; other API routes keep their 1 MB limit.
router.use(requireTicketingAdmin);
router.use(express.json({ limit: '12mb' }));
for (const operation of ['preview', 'send', 'test']) {
    router.post(`/${operation}`, controller[operation]);
}
module.exports = router;
