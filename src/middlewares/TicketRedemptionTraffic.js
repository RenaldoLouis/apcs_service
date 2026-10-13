const rateLimit = require('express-rate-limit');

// Only these three registered POST routes use the separate staff request budget.
// Unknown paths and all purchase/payment routes retain the global limiter.
const isTicketRedemptionRequest = req => req.method === 'POST'
    && /^\/api\/v1\/apcs\/public-ticket\/admin\/redemption\/(list|detail|claim)\/?$/i.test(req.path);

const redemptionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many ticket redemption requests. Wait a minute, then retry the saved request.' },
});

module.exports = { isTicketRedemptionRequest, redemptionLimiter };
