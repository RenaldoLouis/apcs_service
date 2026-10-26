#!/usr/bin/env node
/**
 * Prepares a designer's venue SVG for Seat Occupancy's "Download image".
 *
 * Usage:
 *   node scripts/normalize_seat_map_svg.js --svg <in.svg> --venue <event-data.json|venue.json> --venue-id <id> --out <out.svg>
 *
 * The venue file is the public event-data response (or a single venue object) that
 * holds the venue's seatConfig. The script:
 *   1. matches every seat number <text> to the seat shape around it;
 *   2. assigns rows top-to-bottom in seatConfig row order and checks every row has numbers 1..seatCount;
 *   3. gives each shape id="<row><number>" and its number id="<row><number>-num";
 *   4. lists seats drawn grey in the design. They stay grey for buyers and in every
 *      download, so they must be blocked in every session of the venue.
 * Only id attributes change; the drawing is untouched. It writes nothing when any
 * seat is missing or ambiguous. See docs/SEAT_MAP_SVG_CONTRACT.md.
 */
const fs = require('fs');

const SEAT_SIZE_MIN = 20;
const SEAT_SIZE_MAX = 80;
const SEAT_SQUARENESS_TOLERANCE = 0.15;
const GREY_CHANNEL_SPREAD = 16;
const PATH_PARAMETER_COUNTS = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

const fail = message => { throw new Error(message); };

const parseAttributes = source => {
    const attributes = {};
    for (const [, name, value] of source.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attributes[name] = value;
    return attributes;
};

const setAttributes = (tag, changes) => Object.entries(changes).reduce((result, [name, value]) => {
    const pattern = new RegExp(`\\s${name}\\s*=\\s*"[^"]*"`);
    if (value === null) return result.replace(pattern, '');
    if (pattern.test(result)) return result.replace(pattern, ` ${name}="${value}"`);
    return result.replace(/\s*(\/?>)$/, ` ${name}="${value}"$1`);
}, tag);

const readClassFills = svg => {
    const fills = {};
    for (const [, css] of svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
        for (const [, selectors, declarations] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
            const fill = declarations.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/);
            if (!fill) continue;
            selectors.split(',').map(selector => selector.trim()).filter(selector => /^\.[\w-]+$/.test(selector))
                .forEach(selector => { fills[selector.slice(1)] = fill[1].trim(); });
        }
    }
    return fills;
};

const getFill = (attributes, classFills) => {
    const inline = (attributes.style || '').match(/(?:^|;)\s*fill\s*:\s*([^;]+)/);
    if (inline) return inline[1].trim();
    const classFill = (attributes.class || '').split(/\s+/).map(name => classFills[name]).filter(Boolean).pop();
    return classFill || attributes.fill || '';
};

const isGrey = fill => {
    const hex = fill.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!hex) return false;
    const digits = hex[1].length === 3 ? hex[1].split('').map(digit => digit + digit).join('') : hex[1];
    const channels = [0, 2, 4].map(index => parseInt(digits.slice(index, index + 2), 16));
    return Math.max(...channels) - Math.min(...channels) <= GREY_CHANNEL_SPREAD;
};

/** Bounding box from path end points; rounded seat corners stay inside it. */
const getPathBox = d => {
    const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
    const points = [];
    let x = 0;
    let y = 0;
    let startX = 0;
    let startY = 0;
    let command = '';
    for (let index = 0; index < tokens.length;) {
        if (/[a-z]/i.test(tokens[index])) command = tokens[index++];
        const lower = command.toLowerCase();
        if (lower === 'z') {
            x = startX;
            y = startY;
            continue;
        }
        const count = PATH_PARAMETER_COUNTS[lower];
        if (!count) fail(`Unsupported path command "${command}".`);
        const values = tokens.slice(index, index + count).map(Number);
        if (values.length < count || values.some(Number.isNaN)) fail('A seat path has incomplete coordinates.');
        index += count;
        const relative = command === lower;
        if (lower === 'h') x = (relative ? x : 0) + values[0];
        else if (lower === 'v') y = (relative ? y : 0) + values[0];
        else {
            x = (relative ? x : 0) + values[count - 2];
            y = (relative ? y : 0) + values[count - 1];
        }
        if (lower === 'm') {
            startX = x;
            startY = y;
            command = relative ? 'l' : 'L';
        }
        points.push([x, y]);
    }
    if (!points.length) return null;
    const xs = points.map(point => point[0]);
    const ys = points.map(point => point[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};

const getShapeBox = (name, attributes) => {
    if (name === 'rect') {
        const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(key => parseFloat(attributes[key] || '0'));
        return { x, y, width, height };
    }
    return attributes.d ? getPathBox(attributes.d) : null;
};

const isSeatSized = box => box && box.width >= SEAT_SIZE_MIN && box.width <= SEAT_SIZE_MAX
    && Math.abs(box.width - box.height) <= SEAT_SQUARENESS_TOLERANCE * Math.max(box.width, box.height);

const getTextPoint = attributes => {
    const matrix = (attributes.transform || '').match(/matrix\(\s*1\s+0\s+0\s+1\s+([-\d.]+)\s+([-\d.]+)\s*\)/);
    if (matrix) return { x: Number(matrix[1]), y: Number(matrix[2]) };
    return { x: parseFloat(attributes.x), y: parseFloat(attributes.y) };
};

const contains = (box, point) => point.x >= box.x && point.x <= box.x + box.width
    && point.y >= box.y && point.y <= box.y + box.height;

/**
 * @param {string} svg Designer SVG text.
 * @param {Array<{ row: string, seatCount: number, areaType: string }>} seatConfig Venue rows, as saved in Venue Settings.
 * @returns {{ svg: string, seatCount: number, rows: Array<{ row: string, seats: number }>, drawnGrey: string[] }}
 */
function normalizeSeatMapSvg(svg, seatConfig) {
    if (!Array.isArray(seatConfig) || !seatConfig.length) fail('The venue has no seatConfig.');
    const rowsConfig = [...seatConfig].sort((a, b) => a.row.localeCompare(b.row));
    const classFills = readClassFills(svg);
    const shapes = [...svg.matchAll(/<(rect|path)\b([^>]*?)\/?>/g)]
        .map(match => ({ tag: match[0], index: match.index, attributes: parseAttributes(match[2]), box: getShapeBox(match[1], parseAttributes(match[2])) }))
        .filter(shape => isSeatSized(shape.box));
    const numbers = [...svg.matchAll(/<text\b([^>]*)>\s*(\d+)\s*<\/text>/g)]
        .map(match => ({ tag: match[0].slice(0, match[0].indexOf('>') + 1), index: match.index,
            attributes: parseAttributes(match[1]), number: Number(match[2]) }));

    const seats = numbers.map(text => {
        const point = getTextPoint(text.attributes);
        const around = shapes.filter(shape => contains(shape.box, point));
        if (around.length !== 1) fail(`Seat number ${text.number} at (${point.x}, ${point.y}) sits in ${around.length} seat shapes.`);
        return { text, shape: around[0], centerY: around[0].box.y + around[0].box.height / 2 };
    });
    if (new Set(seats.map(seat => seat.shape)).size !== seats.length) fail('Two seat numbers sit in the same seat shape.');

    const clusters = [];
    [...seats].sort((a, b) => a.centerY - b.centerY).forEach(seat => {
        const last = clusters[clusters.length - 1];
        if (last && seat.centerY - last.centerY < seat.shape.box.height / 2) last.seats.push(seat);
        else clusters.push({ centerY: seat.centerY, seats: [seat] });
    });
    if (clusters.length !== rowsConfig.length) {
        fail(`The SVG has ${clusters.length} seat rows but the venue has ${rowsConfig.length} (${rowsConfig.map(row => row.row).join(', ')}).`);
    }
    clusters.forEach((cluster, index) => {
        const config = rowsConfig[index];
        const found = cluster.seats.map(seat => seat.text.number).sort((a, b) => a - b);
        const expected = Array.from({ length: config.seatCount }, (_, number) => number + 1);
        if (found.join(',') !== expected.join(',')) {
            fail(`Row ${config.row} needs seats 1-${config.seatCount}; the SVG row at y=${cluster.centerY.toFixed(1)} has ${found.join(', ')}.`);
        }
        cluster.seats.forEach(seat => { seat.label = `${config.row}${seat.text.number}`; });
    });

    const drawnGrey = seats.filter(seat => isGrey(getFill(seat.shape.attributes, classFills))).map(seat => seat.label);
    const edits = seats.flatMap(seat => [
        { index: seat.shape.index, tag: seat.shape.tag, changes: { id: seat.label } },
        { index: seat.text.index, tag: seat.text.tag, changes: { id: `${seat.label}-num` } },
    ]);

    let output = svg;
    edits.sort((a, b) => b.index - a.index).forEach(edit => {
        output = output.slice(0, edit.index) + setAttributes(edit.tag, edit.changes) + output.slice(edit.index + edit.tag.length);
    });
    const ids = [...output.matchAll(/\sid="([^"]*)"/g)].map(match => match[1]);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) fail(`The SVG uses id "${duplicate}" twice. Rename the designer's element before uploading.`);

    return {
        svg: output,
        seatCount: seats.length,
        rows: clusters.map((cluster, index) => ({ row: rowsConfig[index].row, seats: cluster.seats.length })),
        drawnGrey: drawnGrey.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    };
}

const readArguments = argv => Object.fromEntries(argv.reduce((pairs, value, index) => (
    value.startsWith('--') ? [...pairs, [value.slice(2), argv[index + 1]]] : pairs), []));

const findSeatConfig = (venueFile, venueId) => {
    const data = venueFile.data || venueFile;
    const venue = Array.isArray(data.venues) ? data.venues.find(item => item.id === venueId) : data;
    if (!venue?.seatConfig) fail(`Venue ${venueId || ''} with a seatConfig was not found in the venue file.`);
    return venue.seatConfig;
};

if (require.main === module) {
    try {
        const args = readArguments(process.argv.slice(2));
        if (!args.svg || !args.venue || !args.out) fail('Usage: --svg <in.svg> --venue <event-data.json> --venue-id <id> --out <out.svg>');
        const seatConfig = findSeatConfig(JSON.parse(fs.readFileSync(args.venue, 'utf8')), args['venue-id']);
        const result = normalizeSeatMapSvg(fs.readFileSync(args.svg, 'utf8'), seatConfig);
        fs.writeFileSync(args.out, result.svg);
        console.log(`Wrote ${args.out}: ${result.seatCount} seats in rows ${result.rows.map(row => `${row.row}(${row.seats})`).join(' ')}.`);
        console.log(result.drawnGrey.length
            ? `Kept seats drawn grey: ${result.drawnGrey.join(', ')}. Block them in every session of this venue.`
            : 'No seats drawn grey.');
    } catch (error) {
        console.error(`Not written: ${error.message}`);
        process.exit(1);
    }
}

module.exports = { normalizeSeatMapSvg, getPathBox, isGrey };
