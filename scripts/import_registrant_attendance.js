/** Preview by default. This script does not start the server or application jobs. */
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { createAttendanceImporter } = require('../src/services/RegistrantAttendanceImport');

function parseArguments(args) {
    const options = {};
    for (let index = 0; index < args.length; index += 1) {
        const flag = args[index];
        if (flag === '--apply' && !options.apply) options.apply = true;
        else if (['--file', '--target', '--resolutions'].includes(flag) && options[flag.slice(2)] === undefined) {
            const value = args[++index];
            if (!value || value.startsWith('--')) throw new Error(`A value is required for ${flag}.`);
            options[flag.slice(2)] = value;
        } else throw new Error(`Unknown or repeated option: ${flag}`);
    }
    if (!options.file || !['emulator', 'production'].includes(options.target)
        || !/\.(csv|xlsx|xls)$/i.test(options.file)) {
        throw new Error('Usage: node scripts/import_registrant_attendance.js --file <csv|xlsx|xls> --target <emulator|production> [--resolutions <json>] [--apply]');
    }
    return options;
}

async function main(args = process.argv.slice(2)) {
    const options = parseArguments(args);
    const workbook = xlsx.readFile(path.resolve(options.file), { raw: false });
    const sheetRows = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '', raw: false });
    const resolutions = options.resolutions ? JSON.parse(fs.readFileSync(path.resolve(options.resolutions), 'utf8')) : {};
    require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });
    if (options.target === 'production') {
        if (process.env.FIRESTORE_EMULATOR_HOST || process.env.APCS_FIRESTORE_MODE) {
            throw new Error('Production target requires APCS_FIRESTORE_MODE and FIRESTORE_EMULATOR_HOST to be unset.');
        }
    } else {
        if (process.env.FIRESTORE_EMULATOR_HOST && process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8081') {
            throw new Error('Emulator target requires 127.0.0.1:8081.');
        }
        process.env.APCS_FIRESTORE_MODE = 'emulator';
    }
    const { db } = require('../src/configs/firebase-init');
    try {
        const importer = createAttendanceImporter(db);
        const preview = await importer.preview({ sheetRows, resolutions });
        const printable = { target: options.target, projectId: db.projectId, summary: preview.summary,
            rows: preview.rows.map(({ matches, ...row }) => ({ ...row,
                matches: matches.map(({ id, names, eventId, willAttend }) => ({ id, names, eventId, willAttend })) })) };
        process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
        if (!options.apply) return;
        if (preview.summary.conflicted) throw new Error('Resolve or exclude all conflicting rows before applying.');
        const directory = path.join(__dirname, '../.local/attendance-import');
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const backup = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${options.target}-${process.pid}.json`);
        fs.writeFileSync(backup, JSON.stringify({ ...printable, candidates: preview.candidates }, null, 2), { mode: 0o600, flag: 'wx' });
        const snapshots = Object.fromEntries(preview.candidates.map(candidate => [candidate.id, candidate.snapshotToken]));
        const result = await importer.apply({ sheetRows, resolutions, snapshots });
        process.stdout.write(`${JSON.stringify({ backup, ...result.summary, results: result.results }, null, 2)}\n`);
        if (result.summary.failed || result.summary.conflictedRegistrations || result.summary.conflicted) process.exitCode = 1;
    } finally {
        await db.terminate();
    }
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { parseArguments, main };
