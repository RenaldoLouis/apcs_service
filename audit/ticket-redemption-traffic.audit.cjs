const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.join(__dirname, '../src/middlewares/TicketRedemptionTraffic.js');
let options;
const context = { module: { exports: {} }, require: name => {
    assert.equal(name, 'express-rate-limit');
    return config => { options = config; return 'separate-limiter'; };
} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
const { isTicketRedemptionRequest } = context.module.exports;

test('REDEMPTION TRAFFIC: only registered redemption POST paths leave the purchase request budget', () => {
    for (const action of ['list', 'detail', 'claim']) {
        for (const suffix of ['', '/']) assert.equal(isTicketRedemptionRequest({ method: 'POST', path: `/api/v1/apcs/public-ticket/admin/redemption/${action}${suffix}` }), true);
    }
    assert.equal(isTicketRedemptionRequest({ method: 'POST', path: '/API/V1/APCS/PUBLIC-TICKET/ADMIN/REDEMPTION/CLAIM' }), true);
    for (const request of [
        { method: 'GET', path: '/api/v1/apcs/public-ticket/admin/redemption/list' },
        { method: 'POST', path: '/api/v1/apcs/public-ticket/booking' },
        { method: 'POST', path: '/api/v1/apcs/public-ticket/webhook' },
        { method: 'POST', path: '/api/v1/apcs/public-ticket/admin/redemption/unknown' },
        { method: 'POST', path: '/api/v1/apcs/public-ticket/admin/redemption/claim/booking' },
        { method: 'POST', path: '/api/v1/apcs/register' },
    ]) assert.equal(isTicketRedemptionRequest(request), false);
});

test('REDEMPTION TRAFFIC: staff requests retain a separate finite limit before authorization', () => {
    assert.equal(options.max, 100); assert.equal(options.windowMs, 60000);
    const source = fs.readFileSync(path.join(__dirname, '../src/routes/PaymentRoute.js'), 'utf8');
    const limiter = source.indexOf("router.use('/public-ticket/admin/redemption', redemptionLimiter)");
    assert.ok(limiter > 0);
    for (const action of ['list', 'detail', 'claim']) {
        const registration = source.indexOf(`router.post('/public-ticket/admin/redemption/${action}', requireTicketingAdmin`);
        assert.ok(registration > limiter, 'Every supported route is limited before token/whitelist verification');
    }
    const index = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    assert.match(index, /skip: isTicketRedemptionRequest/);
});
