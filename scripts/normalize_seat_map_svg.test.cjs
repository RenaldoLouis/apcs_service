const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeSeatMapSvg, getPathBox, isGrey } = require('./normalize_seat_map_svg');

// Illustrator-style 40x40 rounded seat (corner radius 8.4), like the Titan export.
const seatPath = (x, y) => `M${x + 31.6},${y + 40}h-23.2c-4.7,0-8.4-3.8-8.4-8.4v-23.2c0-4.7,3.8-8.4,8.4-8.4H${x + 31.6}`
    + `c4.7,0,8.4,3.8,8.4,8.4v23.2C${x + 40},${y + 36.2},${x + 36.2},${y + 40},${x + 31.6},${y + 40}z`;
const rounded = box => Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Math.round(value * 10) / 10]));

function fixture() {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200">
<style>.gold{fill:#EAC897;}.na{fill:#CBCBCB;}.num-dark{fill:#13204B;}.num-na{fill:#777777;}</style>
<path class="stage" d="M10,5h200v30h-200z"/>
<rect id="A2-blocked" class="na" x="10" y="50" width="40" height="40"/>
<rect id="A1" class="gold" x="60" y="50" width="40" height="40"/>
<path style="fill:url(#blue)" d="${seatPath(10, 110)}"/>
<path style="fill:url(#blue2)" d="${seatPath(60, 110)}"/>
<text class="num-na" x="30" y="70">2</text>
<text class="num-dark" x="80" y="70">1</text>
<text class="num-light" x="30" y="130">2</text>
<text class="num-light" x="80" y="130">1</text>
</svg>`;
}

const seatConfig = [{ row: 'B', seatCount: 2, areaType: 'Allegro' }, { row: 'A', seatCount: 2, areaType: 'Presto' }];

test('names every seat shape and number by row order and seat number', () => {
    const result = normalizeSeatMapSvg(fixture(), seatConfig);
    assert.equal(result.seatCount, 4);
    assert.deepEqual(result.rows, [{ row: 'A', seats: 2 }, { row: 'B', seats: 2 }]);
    for (const id of ['A1', 'A2', 'B1', 'B2', 'A1-num', 'A2-num', 'B1-num', 'B2-num']) {
        assert.equal(result.svg.split(`id="${id}"`).length - 1, 1, id);
    }
    assert.match(result.svg, /<path id="B2" style="fill:url\(#blue\)"|<path style="fill:url\(#blue\)"[^>]*id="B2"/);
    assert.doesNotMatch(result.svg, /blocked/);
});

test('keeps seats drawn grey in the design and reports them', () => {
    const result = normalizeSeatMapSvg(fixture(), seatConfig);
    assert.deepEqual(result.drawnGrey, ['A2']);
    assert.match(result.svg, /<rect id="A2" class="na" x="10"/);
    assert.match(result.svg, /<text class="num-na" x="30" y="70" id="A2-num">2<\/text>/);
});

test('changes nothing in the drawing except seat and number ids', () => {
    const withoutIds = svg => svg.replace(/\sid="[^"]*"/g, '');
    assert.equal(withoutIds(normalizeSeatMapSvg(fixture(), seatConfig).svg), withoutIds(fixture()));
});

test('refuses an SVG whose rows or seat numbers differ from the venue', () => {
    assert.throws(() => normalizeSeatMapSvg(fixture(), [...seatConfig, { row: 'C', seatCount: 1, areaType: 'Allegro' }]),
        /2 seat rows but the venue has 3/);
    assert.throws(() => normalizeSeatMapSvg(fixture(), [{ row: 'A', seatCount: 3, areaType: 'Presto' }, seatConfig[0]]),
        /Row A needs seats 1-3/);
});

test('refuses a seat number outside every seat shape', () => {
    const stray = fixture().replace('</svg>', '<text x="400" y="400">3</text></svg>');
    assert.throws(() => normalizeSeatMapSvg(stray, seatConfig), /sits in 0 seat shapes/);
});

test('reads path bounding boxes and grey paints', () => {
    assert.deepEqual(rounded(getPathBox(seatPath(10, 110))), { x: 10, y: 110, width: 40, height: 40 });
    assert.equal(isGrey('#CBCBCB'), true);
    assert.equal(isGrey('#EAC897'), false);
    assert.equal(isGrey('url(#blue)'), false);
});
