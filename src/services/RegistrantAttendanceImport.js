const { createHmac, randomBytes, timingSafeEqual } = require('crypto');

const allowedEvents = new Set(['APCS2025', 'APCS2026']);
const normalize = value => String(value ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
const attendanceError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode, isOperational: true });
const sourceEvent = record => normalize(record.eventId) ? record.eventId : 'APCS2025';
const rosterKey = names => names.map(normalize).sort().join(' & ');
const performerNames = record => (Array.isArray(record.performers) ? record.performers : []).map(performer =>
    typeof performer === 'string' ? performer.trim()
        : String(performer?.fullName || `${performer?.firstName || ''} ${performer?.lastName || ''}`).trim());

function classifyAttendance(value) {
    const response = normalize(value);
    if (/\b(?:tidak|tak|belum)\s+(?:hadir|hair|hadri)\b|\bno\b/.test(response)) return false;
    return /\b(?:hadir|hadri|yes)\b/.test(response);
}

function parseSheetRows(sheetRows) {
    if (!Array.isArray(sheetRows) || sheetRows.length < 2 || sheetRows.length > 5001
        || sheetRows.some(row => !Array.isArray(row) || row.length > 100)) {
        throw attendanceError('Provide a worksheet with a header and 1–5,000 data rows (at most 100 columns).');
    }
    const headers = sheetRows[0].map(normalize);
    if (headers.filter(header => header === 'full name').length !== 1
        || headers.filter(header => header === 'attendance').length !== 1) {
        throw attendanceError('The worksheet must contain exactly one Full Name column and one Attendance column.');
    }
    const nameIndex = headers.indexOf('full name');
    const attendanceIndex = headers.indexOf('attendance');
    const groups = new Map();
    sheetRows.slice(1).forEach((row, index) => {
        if (row.every(cell => !String(cell ?? '').trim())) return;
        const fullName = String(row[nameIndex] ?? '').trim();
        const response = String(row[attendanceIndex] ?? '').trim();
        if (!fullName || fullName.length > 2000 || response.length > 4000) {
            throw attendanceError(`Worksheet row ${index + 2} needs a Full Name and reasonably sized text.`);
        }
        const parts = fullName.split('&').map(part => part.trim());
        if (parts.some(part => !part)) throw attendanceError(`Worksheet row ${index + 2} has an incomplete ensemble name.`);
        const key = rosterKey(parts);
        let group = groups.get(key);
        if (!group) {
            group = { id: `row-${index + 2}`, fullName, nameKey: key, rowNumbers: [], responses: [], values: [] };
            groups.set(key, group);
        }
        group.rowNumbers.push(index + 2);
        group.responses.push(response);
        group.values.push(classifyAttendance(response));
    });
    if (!groups.size) throw attendanceError('The worksheet has no named attendance rows.');
    return [...groups.values()].map(({ values, ...group }) => ({ ...group,
        duplicateConflict: new Set(values).size > 1,
        willAttend: new Set(values).size === 1 ? values[0] : null,
    }));
}

function buildPlan(groups, candidates, resolutions = {}) {
    if (!resolutions || typeof resolutions !== 'object' || Array.isArray(resolutions)) throw attendanceError('Resolutions must be an object keyed by preview row ID.');
    const rowIds = new Set(groups.map(group => group.id));
    if (Object.keys(resolutions).some(id => !rowIds.has(id))) throw attendanceError('A resolution refers to an unknown preview row.');
    const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
    const rows = groups.map(group => {
        const resolution = resolutions[group.id] || {};
        if (typeof resolution !== 'object' || Array.isArray(resolution)
            || (resolution.excluded !== undefined && typeof resolution.excluded !== 'boolean')
            || (resolution.willAttend !== undefined && typeof resolution.willAttend !== 'boolean')) {
            throw attendanceError(`Invalid resolution for ${group.id}.`);
        }
        let matches = candidates.filter(candidate => candidate.nameKey && candidate.nameKey === group.nameKey);
        let matchType = matches.length ? 'exact' : 'unmatched';
        if (resolution.registrantIds !== undefined) {
            if (!Array.isArray(resolution.registrantIds) || resolution.registrantIds.length > 100
                || resolution.registrantIds.some(id => typeof id !== 'string' || (!resolution.excluded && !byId.has(id)))) {
                throw attendanceError(`Choose valid APCS2025/APCS2026 registrations for ${group.fullName}.`);
            }
            matches = [...new Set(resolution.registrantIds)].map(id => byId.get(id)).filter(Boolean);
            matchType = matches.length ? 'manual' : 'unmatched';
        }
        const willAttend = group.duplicateConflict && typeof resolution.willAttend === 'boolean'
            ? resolution.willAttend : group.willAttend;
        const excluded = resolution.excluded === true;
        return { ...group, willAttend, excluded, matches, matchType,
            status: excluded ? 'excluded' : willAttend === null ? 'conflicted' : matches.length ? 'ready' : 'unmatched' };
    });
    const valuesById = new Map();
    rows.filter(row => row.status === 'ready').forEach(row => row.matches.forEach(candidate => {
        const values = valuesById.get(candidate.id) || new Set();
        values.add(row.willAttend);
        valuesById.set(candidate.id, values);
    }));
    const conflictingIds = new Set([...valuesById].filter(([, values]) => values.size > 1).map(([id]) => id));
    rows.forEach(row => {
        if (row.status === 'ready' && row.matches.some(candidate => conflictingIds.has(candidate.id))) row.status = 'conflicted';
    });
    const updates = new Map();
    rows.filter(row => row.status === 'ready').forEach(row => row.matches.forEach(candidate => {
        updates.set(candidate.id, { ...candidate, desired: row.willAttend });
    }));
    return { rows, updates: [...updates.values()], summary: {
        sourceRows: groups.reduce((sum, group) => sum + group.rowNumbers.length, 0),
        uniqueRows: rows.length, registrations: updates.size,
        attending: [...updates.values()].filter(update => update.desired).length,
        notAttending: [...updates.values()].filter(update => !update.desired).length,
        skipped: rows.filter(row => ['excluded', 'unmatched'].includes(row.status)).length,
        conflicted: rows.filter(row => row.status === 'conflicted').length,
    } };
}

function createAttendanceImporter(db, { secret = process.env.REGISTRANT_ATTENDANCE_PREVIEW_SECRET || randomBytes(32), now = Date.now, chunkSize = 200 } = {}) {
    if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 200) throw attendanceError('Invalid import chunk size.');
    const snapshot = (id, record) => ({ id, eventId: sourceEvent(record), names: performerNames(record),
        hasWillAttend: Object.prototype.hasOwnProperty.call(record, 'willAttend'), attendance: record.willAttend ?? null });
    const sign = body => createHmac('sha256', secret).update(body).digest('base64url');
    const makeToken = data => {
        const body = Buffer.from(JSON.stringify({ data, expiresAt: now() + 60 * 60 * 1000 })).toString('base64url');
        return `${body}.${sign(body)}`;
    };
    function verifyToken(token, data, desired) {
        if (typeof token !== 'string' || token.length > 20000) return false;
        try {
            const [body, signature, extra] = token.split('.');
            if (extra || !body || !signature) return false;
            const expected = Buffer.from(sign(body));
            const actual = Buffer.from(signature);
            if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
            const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
            if (!(payload.expiresAt > now())) return false;
            if (JSON.stringify(payload.data) === JSON.stringify(data)) return true;
            // A retry after a committed/lost response is safe when identity is unchanged
            // and the current stored boolean already equals this import's target.
            return typeof desired === 'boolean' && data.hasWillAttend && data.attendance === desired
                && ['id', 'eventId', 'names'].every(key => JSON.stringify(payload.data[key]) === JSON.stringify(data[key]));
        } catch { return false; }
    }
    async function loadCandidates() {
        const candidates = [];
        let cursor;
        while (true) {
            let query = db.collection('Registrants2025').orderBy('__name__').limit(200);
            if (cursor) query = query.startAfter(cursor);
            const page = await query.get();
            for (const document of page.docs) {
                const record = document.data();
                if (!allowedEvents.has(sourceEvent(record))) continue;
                const data = snapshot(document.id, record);
                const names = data.names;
                candidates.push({ id: document.id, eventId: data.eventId, names,
                    nameKey: names.length && names.every(name => normalize(name)) ? rosterKey(names) : '',
                    willAttend: typeof record.willAttend === 'boolean' ? record.willAttend : null,
                    snapshotToken: makeToken(data) });
            }
            if (page.docs.length < 200) return candidates;
            cursor = page.docs[page.docs.length - 1];
        }
    }
    async function preview({ sheetRows, resolutions = {} }) {
        const groups = parseSheetRows(sheetRows);
        const candidates = await loadCandidates();
        const plan = buildPlan(groups, candidates, resolutions);
        return { rows: plan.rows, candidates, summary: plan.summary };
    }
    async function apply({ sheetRows, resolutions = {}, snapshots }) {
        const groups = parseSheetRows(sheetRows);
        if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)) throw attendanceError('Preview snapshots are required before saving.');
        const candidates = await loadCandidates();
        const plan = buildPlan(groups, candidates, resolutions);
        const results = [];
        const staleIds = new Set();
        // A changed/added match invalidates the entire source row, including its other matches.
        for (const row of plan.rows.filter(item => item.status === 'ready')) {
            if (row.matches.some(candidate => {
                const data = JSON.parse(Buffer.from(candidate.snapshotToken.split('.')[0], 'base64url').toString()).data;
                return !verifyToken(snapshots[candidate.id], data, row.willAttend);
            })) row.matches.forEach(candidate => staleIds.add(candidate.id));
        }
        const writable = plan.updates.filter(candidate => {
            if (!staleIds.has(candidate.id)) return true;
            results.push({ id: candidate.id, status: 'conflicted', message: 'Registration changed or preview expired. Preview again.' });
            return false;
        });
        for (let index = 0; index < writable.length; index += chunkSize) {
            const chunk = writable.slice(index, index + chunkSize);
            try {
                const chunkResults = await db.runTransaction(async transaction => {
                    const documents = await Promise.all(chunk.map(candidate => transaction.get(db.collection('Registrants2025').doc(candidate.id))));
                    const checked = documents.map((document, offset) => {
                        const candidate = chunk[offset];
                        if (!document.exists || !verifyToken(snapshots[candidate.id], snapshot(candidate.id, document.data()), candidate.desired)) {
                            return { id: candidate.id, status: 'conflicted', message: 'Registration changed. Preview again.' };
                        }
                        return { id: candidate.id, status: document.data().willAttend === candidate.desired ? 'unchanged' : 'updated' };
                    });
                    // No writes in this chunk when any preview is stale. Reads always precede writes.
                    if (checked.some(result => result.status === 'conflicted')) return checked.map(result => ({ ...result,
                        status: 'conflicted', message: 'A registration in this chunk changed. Preview again.' }));
                    checked.forEach((result, offset) => {
                        if (result.status === 'updated') transaction.update(documents[offset].ref, { willAttend: chunk[offset].desired });
                    });
                    return checked;
                });
                results.push(...chunkResults);
            } catch (error) {
                results.push(...chunk.map(candidate => ({ id: candidate.id, status: 'failed', message: error.message })));
                results.push(...writable.slice(index + chunkSize).map(candidate => ({ id: candidate.id, status: 'failed', message: 'Not attempted after a failed chunk. Preview and retry.' })));
                break;
            }
        }
        return { results, rows: plan.rows, summary: { ...plan.summary,
            updated: results.filter(result => result.status === 'updated').length,
            unchanged: results.filter(result => result.status === 'unchanged').length,
            conflictedRegistrations: results.filter(result => result.status === 'conflicted').length,
            failed: results.filter(result => result.status === 'failed').length,
        } };
    }
    return { preview, apply };
}

module.exports = { classifyAttendance, parseSheetRows, buildPlan, createAttendanceImporter };
