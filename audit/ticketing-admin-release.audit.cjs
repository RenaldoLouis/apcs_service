const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const loadMiddleware = ({ decodedToken = null, whitelistExists = false } = {}) => {
    const filename = path.join(__dirname, '../src/middlewares/TicketingAdminMiddleware.js');
    const context = {
        module: { exports: {} },
        require: name => {
            if (name.endsWith('/firebase-init')) {
                return {
                    admin: {
                        auth: () => ({
                            verifyIdToken: async () => {
                                if (!decodedToken) throw new Error('invalid token');
                                return decodedToken;
                            },
                        }),
                    },
                    db: {
                        collection: name => {
                            assert.equal(name, 'whitelist');
                            return {
                                doc: email => ({
                                    get: async () => {
                                        assert.equal(email, String(decodedToken?.email || '').toLowerCase());
                                        return { exists: whitelistExists };
                                    },
                                }),
                            };
                        },
                    },
                };
            }
            throw new Error(`Unexpected dependency ${name}`);
        },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return context.module.exports.requireTicketingAdmin;
};

const responseRecorder = () => {
    const response = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
    return response;
};

test('ADMIN RELEASE AUTH: verified whitelisted Firebase user reaches the protected endpoint', async () => {
    const middleware = loadMiddleware({
        decodedToken: { uid: 'admin-1', email: 'ADMIN@example.invalid' },
        whitelistExists: true,
    });
    const request = { headers: { 'auth-token': 'valid-token' } };
    const response = responseRecorder();
    let nextCalls = 0;

    await middleware(request, response, () => { nextCalls++; });

    assert.equal(nextCalls, 1);
    assert.equal(request.ticketingAdmin.uid, 'admin-1');
    assert.equal(request.ticketingAdmin.email, 'admin@example.invalid');
    assert.equal(response.body, null);
});

test('ADMIN RELEASE AUTH: authenticated but non-whitelisted user is rejected', async () => {
    const middleware = loadMiddleware({
        decodedToken: { uid: 'user-1', email: 'user@example.invalid' },
        whitelistExists: false,
    });
    const request = { headers: { 'auth-token': 'valid-token' } };
    const response = responseRecorder();
    let nextCalls = 0;

    await middleware(request, response, () => { nextCalls++; });

    assert.equal(nextCalls, 0);
    assert.equal(response.statusCode, 403);
    assert.match(response.body.message, /not authorized/i);
});

test('ADMIN RELEASE AUTH: release route always applies ticketing-admin middleware', () => {
    const filename = path.join(__dirname, '../src/routes/PaymentRoute.js');
    const source = fs.readFileSync(filename, 'utf8');
    assert.match(source, /public-ticket\/admin\/release-booking'[\s\S]*requireTicketingAdmin[\s\S]*releasePublicTicketBooking/);
});

test('ADMIN RELEASE API: operational errors expose a stable localization code', () => {
    const filename = path.join(__dirname, '../src/middlewares/ErrorHandlerMiddleware.js');
    const context = { module: { exports: {} }, process: { env: { NODE_ENV: 'production' } }, Error };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    const response = responseRecorder();
    context.module.exports.errorHandler({
        message: 'English diagnostic message',
        statusCode: 409,
        isOperational: true,
        code: 'PAPER_CANCELLATION_FAILED',
    }, {}, response, () => {});

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'PAPER_CANCELLATION_FAILED');
});
