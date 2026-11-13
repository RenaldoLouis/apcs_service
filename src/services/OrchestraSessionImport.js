const { createHash } = require('node:crypto');

const MAX_ROWS = 300;
const START_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const importError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, isOperational: true });
const normalize = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function nameKey(value) {
    let name = normalize(value);
    while (/\([^()]*\)/.test(name)) name = name.replace(/\([^()]*\)/g, ' ');
    return normalize(name);
}
const candidateLabel = candidate => candidate.names.find(Boolean) || candidate.id;

function parseRows(sheetRows) {
    if (!Array.isArray(sheetRows) || sheetRows.length < 2 || sheetRows.length > MAX_ROWS + 1
        || sheetRows.some(row => !Array.isArray(row) || row.length > 2
            || row.some(value => typeof value !== 'string' || value.length > 500))) {
        throw importError('Use a CSV with Name and session columns and 1–300 data rows.');
    }
    const header = sheetRows[0].map(normalize);
    const nameIndex = header.indexOf('name');
    const sessionIndex = header.indexOf('session');
    if (nameIndex < 0 || sessionIndex < 0) throw importError('The CSV must have a Name column and a session column.');
    const rows = sheetRows.slice(1).flatMap((row, index) => {
        const name = (row[nameIndex] || '').trim();
        const start = (row[sessionIndex] || '').trim();
        return name || start ? [{ rowNumber: index + 2, name, start }] : [];
    });
    if (!rows.length) throw importError('The CSV contains no schedule rows.');
    return rows;
}

function buildImportPlan(eventId, rows, { event, candidates }) {
    const names = new Map();
    for (const candidate of candidates) {
        for (const key of new Set(candidate.names.map(nameKey).filter(Boolean))) {
            const matches = names.get(key) || [];
            matches.push(candidate);
            names.set(key, matches);
        }
    }
    const sessions = new Map();
    const venues = new Map((event.venues || []).map(venue => [venue.id, venue.label || venue.id]));
    for (const session of event.orchestraSessions || []) {
        if (!venues.has(session.venue)) continue;
        const start = String(session.time || '').slice(0, 5);
        const options = sessions.get(start) || [];
        const { id, venue, date, time } = session;
        options.push({ id, venue, date, time, venueName: venues.get(venue) });
        sessions.set(start, options);
    }
    const startsByRegistrant = new Map();
    const matches = rows.map(row => {
        const candidatesForName = names.get(nameKey(row.name)) || [];
        if (candidatesForName.length !== 1) return { row, candidatesForName };
        const [candidate] = candidatesForName;
        const starts = startsByRegistrant.get(candidate.id) || new Set();
        starts.add(row.start);
        startsByRegistrant.set(candidate.id, starts);
        return { row, candidate };
    });

    const requests = new Map();
    const previewRows = matches.map(({ row, candidate, candidatesForName }) => {
        if (!nameKey(row.name) || !START_TIME.test(row.start)) return { ...row, status: 'Invalid name or time' };
        if (!candidate) {
            const paidMatches = candidatesForName.map(item => ({ id: item.id, name: candidateLabel(item) }));
            return { ...row, paidMatches, status: paidMatches.length ? 'Multiple paid matches' : 'No paid match' };
        }
        const match = { ...row, registrantId: candidate.id, registrantName: candidateLabel(candidate) };
        if (candidate.assignment) {
            const { venueName, date, time } = candidate.assignment;
            return { ...match, currentSession: { venueName, date, time }, status: 'Already assigned' };
        }
        if (candidate.legacyConflict) return { ...match, status: 'Legacy allocation needs review' };
        if (startsByRegistrant.get(candidate.id).size > 1) return { ...match, status: 'Conflicting times' };
        const options = sessions.get(row.start) || [];
        if (options.length !== 1) return { ...match, status: options.length ? 'Multiple sessions at this time' : 'Session not found' };
        const [session] = options;
        const request = { registrantId: candidate.id, name: match.registrantName, sessionId: session.id, expectedSession: session };
        const duplicate = requests.has(candidate.id);
        requests.set(candidate.id, request);
        return { ...match, session, status: duplicate ? 'Included with earlier row' : 'Ready' };
    });
    const changes = [...requests.values()];
    const previewKey = createHash('sha256').update(JSON.stringify([eventId, previewRows, changes])).digest('hex');
    return { previewKey, rows: previewRows, changes, summary: {
        sourceRows: rows.length, ready: changes.length,
        alreadyAssigned: previewRows.filter(row => row.status === 'Already assigned').length,
        skipped: previewRows.filter(row => !['Ready', 'Included with earlier row', 'Already assigned'].includes(row.status)).length,
    } };
}

function createOrchestraSessionImporter(repository) {
    async function plan({ eventId, sheetRows }) {
        const rows = parseRows(sheetRows);
        return buildImportPlan(eventId, rows, await repository.readSessionImportData(eventId));
    }

    async function preview(input) {
        const { previewKey, rows, summary } = await plan(input);
        return { previewKey, rows, summary };
    }

    async function apply(input, actor) {
        const { previewKey, changes } = await plan(input);
        if (input.previewKey !== previewKey || !changes.length) {
            throw importError('The preview is out of date or has no new assignments. Preview the CSV again.', 409);
        }
        return repository.confirmImportedAssignments(input.eventId, changes, actor);
    }

    return { preview, apply };
}

module.exports = { createOrchestraSessionImporter };
