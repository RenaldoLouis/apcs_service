const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('runtime requires an explicit worker flag and refuses background sending in emulator mode', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/GroupAnnouncementEmailRuntime.js'), 'utf8');
    for (const [env, expected] of [[{}, false], [{ APCS_GROUP_EMAIL_WORKER_ENABLED: 'true' }, true],
        [{ APCS_GROUP_EMAIL_WORKER_ENABLED: 'true', APCS_FIRESTORE_MODE: 'emulator' }, false]]) {
        let options;
        const module = { exports: {} };
        vm.runInNewContext(source, { module, process: { env }, require: name => {
            if (name === 'nodemailer') return { createTransport: () => ({ sendMail() { throw new Error('No real SMTP in this test'); } }) };
            if (name.includes('firebase-init')) return { db: {} };
            if (name.includes('emailConfig')) return { smtpConfig: {} };
            if (name === './GroupAnnouncementEmailService') return { createService: value => { options = value; return {}; } };
            throw new Error(`Unexpected dependency ${name}`);
        } });
        assert.equal(options.workerEnabled, expected);
        assert.equal(module.exports.workerEnabled, expected);
    }
});

test('worker adds no timers while disabled and prevents overlapping ticks when enabled', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/jobs/GroupAnnouncementEmailWorker.js'), 'utf8');
    for (const workerEnabled of [false, true]) {
        const timers = [];
        const cleared = [];
        let calls = 0, release;
        const module = { exports: {} };
        const service = { processDue: () => { calls += 1; return new Promise(resolve => { release = resolve; }); } };
        const timer = fn => { const value = { fn, unref() {} }; timers.push(value); return value; };
        vm.runInNewContext(source, { module, setTimeout: timer, setInterval: timer,
            clearTimeout: value => cleared.push(value), clearInterval: value => cleared.push(value),
            require: name => name.includes('GroupAnnouncementEmailRuntime') ? { workerEnabled, service } : { logger: { error() {} } } });
        const stop = module.exports.startGroupAnnouncementEmailWorker();
        if (!workerEnabled) { assert.equal(timers.length, 0); continue; }
        assert.equal(timers.length, 2);
        const first = timers[0].fn();
        await timers[1].fn();
        assert.equal(calls, 1);
        release(); await first;
        stop(); assert.equal(cleared.length, 2);
    }
});

test('client Firestore rules exclude all campaign data from the broad staff fallback', () => {
    for (const file of ['../../apcs_web/firestore.rules', '../../docs/FIRESTORE_PRODUCTION_MERGED_2026-10-13.rules']) {
        const rules = fs.readFileSync(path.join(__dirname, file), 'utf8');
        assert.match(rules, /match \/groupAnnouncementCampaigns\/\{document=\*\*\} \{\s*allow read, write: if false;/);
        assert.match(rules, /collection != 'groupAnnouncementCampaigns'/);
    }
});
