// Actual Express/rate-limit middleware, synthetic HTTP only. No app configuration, DB or providers.
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { isTicketRedemptionRequest, redemptionLimiter } = require('../src/middlewares/TicketRedemptionTraffic');
const app = express();
app.set('trust proxy', 1);
app.use(rateLimit({ windowMs: 60000, max: 100, skip: isTicketRedemptionRequest, standardHeaders: true, legacyHeaders: false }));
app.use('/api/v1/apcs/public-ticket/admin/redemption', redemptionLimiter);
for (const action of ['list', 'detail', 'claim']) app.post(`/api/v1/apcs/public-ticket/admin/redemption/${action}`, (req, res) => {
    if (req.headers['auth-token'] !== 'synthetic-staff') return res.status(401).json({ message: 'Unauthorized test actor' });
    res.json({ action });
});
for (const route of ['public-ticket/booking', 'public-ticket/webhook', 'register', 'unrelated-feature']) {
    app.post(`/api/v1/apcs/${route}`, (req, res) => res.json({ route }));
}
const server = http.createServer(app);
let port;
const request = (path, ip = '192.0.2.1', staff = true) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: {
        'X-Forwarded-For': ip, ...(staff ? { 'auth-token': 'synthetic-staff' } : {}),
    } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject); req.end();
});
(async () => {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    port = server.address().port;
    try {
        for (let index = 0; index < 100; index++) assert.equal(await request(`/api/v1/apcs/public-ticket/admin/redemption/${['list', 'detail', 'claim'][index % 3]}`), 200);
        assert.equal(await request('/api/v1/apcs/public-ticket/admin/redemption/claim'), 429);
        for (let index = 0; index < 100; index++) assert.equal(await request(`/api/v1/apcs/${['public-ticket/booking', 'public-ticket/webhook', 'register', 'unrelated-feature'][index % 4]}`), 200);
        assert.equal(await request('/api/v1/apcs/public-ticket/booking'), 429);
        for (let index = 0; index < 100; index++) assert.equal(await request('/api/v1/apcs/public-ticket/admin/redemption/claim', '192.0.2.2', false), 401);
        assert.equal(await request('/api/v1/apcs/public-ticket/admin/redemption/claim', '192.0.2.2', false), 429);
        assert.equal(await request('/api/v1/apcs/public-ticket/booking', '192.0.2.2', false), 200);
        console.log(JSON.stringify({ passed: 3, syntheticDataOnly: true, checks: [
            '100 staff requests share one redemption budget; the next is limited.',
            'The same IP retains all 100 existing purchase/payment/other-feature requests; the original global limit still applies.',
            'Unauthenticated redemption attempts are limited without consuming the existing purchase budget.',
        ] }, null, 2));
    } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
