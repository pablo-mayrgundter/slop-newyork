const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8');

// The app's own scripts, which the guest leaves out (js/guest-entry.mjs)
const APP_ONLY = ['controllers.js', 'touch-controls.js', 'cameras.js', 'nyc-map.js', 'post-processing.js', 'main.js'];

test('the guest loads the city scripts index.html loads, in its order, without the app\'s own, then guest.js', () => {
  const html = read('index.html');
  const appScripts = [...html.match(/const nycAppScripts = [^]*?\]/)[0].matchAll(/'\.\/js\/([\w-]+\.js)'/g)].map((m) => m[1]);
  const entry = read('js/guest-entry.mjs');
  const guestScripts = [...entry.match(/const SCRIPTS = \[([^]*?)\]/)[1].matchAll(/'([\w-]+\.js)'/g)].map((m) => m[1]);
  assert.ok(appScripts.length > 10);
  assert.deepEqual(guestScripts, [...appScripts.filter((s) => !APP_ONLY.includes(s)), 'guest.js']);
});

// A Matrix4 with three's set() (row-major arguments) and column-major elements
class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  set(...n) {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) this.elements[c * 4 + r] = n[r * 4 + c];
    return this;
  }
}

function loadFrame() {
  // boroughs.js's lon/lat → world map, as it stands there
  const LL = read('js/boroughs.js').match(/function LL\(lon, lat\) \{[^]*?\n\}/)[0];
  const window = { NYC: { THREE: { Matrix4 }, TSL: {}, Addons: {} } };
  const context = vm.createContext({ window, Math });
  vm.runInContext(`${LL}; window.NYC.lonLatToWorld = LL;`, context);
  vm.runInContext(read('js/guest.js'), context);
  return { frame: window.NYC.makeGeoFrame(), LL: window.NYC.lonLatToWorld };
}

const enuOf = (m, x, y, z) => {
  const e = m.elements;
  return [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
};

test('world ↔ lon/lat round-trips through boroughs.js\'s map', () => {
  const { frame, LL } = loadFrame();
  for (const [lon, lat] of [[-73.9857, 40.7484], [-74.0445, 40.6892], [-73.9496, 40.7969]]) {
    const w = LL(lon, lat);
    const back = frame.worldToLonLat(w.x, w.z);
    assert.ok(Math.abs(back.lon - lon) < 1e-9 && Math.abs(back.lat - lat) < 1e-9, `${lon}, ${lat}`);
  }
  // The origin is 5th Ave & 42nd St, within ~150 m of the tangent point
  assert.ok(Math.abs(frame.origin.lon - frame.lon0) < 0.002 && Math.abs(frame.origin.lat - frame.lat0) < 0.002);
});

test('worldToEnu is a rotation about up at 1 m per unit, grid north 29° east of true north', () => {
  const { frame } = loadFrame();
  const e = frame.worldToEnu.elements;
  const col = (i) => [e[i * 4], e[i * 4 + 1], e[i * 4 + 2]];
  const len = (v) => Math.hypot(...v);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const i of [0, 1, 2]) assert.ok(Math.abs(len(col(i)) - 1) < 2e-3, `axis ${i} is ${len(col(i))} m`);
  assert.ok(Math.abs(dot(col(0), col(2))) < 2e-3);
  assert.deepEqual(col(1), [0, 0, 1]);
  // Grid north is world -z
  const north = col(2).map((v) => -v);
  const bearing = (Math.atan2(north[0], north[1]) * 180) / Math.PI;
  assert.ok(Math.abs(bearing - 29.02) < 0.05, `bearing ${bearing}`);
  // The tangent point is ENU (0, 0)
  const { LL } = loadFrame();
  const t = LL(frame.lon0, frame.lat0);
  const enu = enuOf(frame.worldToEnu, t.x, 0, t.z);
  assert.ok(Math.hypot(enu[0], enu[1]) < 1e-6);
});

test('worldToEnu agrees with metres along the ground', () => {
  const { frame, LL } = loadFrame();
  // 0.01° of latitude north of the tangent point is ~1110.9 m at 40.75°N; 0.01° of longitude east is ~843.6 m
  const n = LL(frame.lon0, frame.lat0 + 0.01);
  const e = LL(frame.lon0 + 0.01, frame.lat0);
  const en = enuOf(frame.worldToEnu, n.x, 0, n.z);
  const ee = enuOf(frame.worldToEnu, e.x, 0, e.z);
  assert.ok(Math.abs(en[0]) < 1 && Math.abs(en[1] - 1110.9) < 2, `north ${en}`);
  assert.ok(Math.abs(ee[1]) < 1 && Math.abs(ee[0] - 843.6) < 2, `east ${ee}`);
});


// THE GROUND (js/guest.js makeGround): the host's terrain heights at the guest's sample points, as lifts
function loadGround(spacing = 100) {
  const LL = read('js/boroughs.js').match(/function LL\(lon, lat\) \{[^]*?\n\}/)[0];
  const window = { NYC: { THREE: { Matrix4 }, TSL: {}, Addons: {} } };
  const context = vm.createContext({ window, Math });
  vm.runInContext(`${LL}; window.NYC.lonLatToWorld = LL;`, context);
  vm.runInContext(read('js/guest.js'), context);
  const frame = window.NYC.makeGeoFrame();
  const ground = window.NYC.makeGround(frame);
  return { frame, ground, LL: window.NYC.lonLatToWorld, ...ground.samples(spacing) };
}

// The grid's points in world (x, z), in samples()' order
const gridPoints = (ground, cols, rows) => {
  const { x0, x1, z0, z1 } = ground.bounds;
  const pts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) pts.push([x0 + ((x1 - x0) * c) / (cols - 1), z0 + ((z1 - z0) * r) / (rows - 1)]);
  }
  return pts;
};

test('the ground\'s samples are lon/lat pairs that boroughs.js maps back onto the grid', () => {
  const { ground, LL, lonLat, cols, rows } = loadGround(100);
  const { x0, x1, z0, z1 } = ground.bounds;
  assert.equal(lonLat.length, cols * rows * 2);
  assert.ok((x1 - x0) / (cols - 1) <= 100 && (z1 - z0) / (rows - 1) <= 100, 'no farther apart than asked');
  const pts = gridPoints(ground, cols, rows);
  for (const i of [0, cols - 1, cols, Math.floor((cols * rows) / 2), cols * rows - 1]) {
    const w = LL(lonLat[2 * i], lonLat[2 * i + 1]);
    assert.ok(Math.hypot(w.x - pts[i][0], w.z - pts[i][1]) < 1e-6, `sample ${i}: ${w.x}, ${w.z} vs ${pts[i]}`);
  }
  // Rows run along z (grid south): the first row is the northern edge, so its latitudes are the highest
  assert.ok(lonLat[1] > lonLat[2 * cols * (rows - 1) + 1]);
});

test('offsetAt reproduces a planar ground exactly, less the curve, with height0 its height at the tangent point', () => {
  const { ground, cols, rows } = loadGround(100);
  const plane = (x, z) => -20 + 0.004 * x - 0.0025 * z;
  ground.set(gridPoints(ground, cols, rows).map(([x, z]) => plane(x, z)));
  const t = ground.tangent;
  assert.ok(Math.abs(ground.height0 - plane(t.x, t.z)) < 1e-9, `height0 ${ground.height0}`);
  assert.ok(Math.abs(ground.offsetAt(t.x, t.z)) < 1e-4, 'nothing moves at the tangent point');
  const curve = (x, z) => ((x - t.x) ** 2 + (z - t.z) ** 2) * ground.curvature;
  for (const [x, z] of [[0, 0], [-2650, -7350], [2850, 6750], [1234.5, -3456.7], [-1000, 5000]]) {
    const want = plane(x, z) - ground.height0 - curve(x, z);
    // the offsets are stored as float32: ~1e-5 m at tens of metres
    assert.ok(Math.abs(ground.offsetAt(x, z) - want) < 1e-4, `${x}, ${z}: ${ground.offsetAt(x, z)} vs ${want}`);
  }
  const { min, max } = ground.range;
  assert.ok(min < 0 && max > 0 && max - min > 40, `range ${min}..${max}`);
});

test('the curve drops ~7.85 m 10 km from the tangent point, the same in every direction', () => {
  const { ground, cols, rows } = loadGround(200);
  ground.set(new Array(cols * rows).fill(12.5));
  assert.equal(ground.height0, 12.5);
  const t = ground.tangent;
  for (const a of [0, 1, 2, 3]) {
    const drop = -ground.offsetAt(t.x + 10000 * Math.cos(a), t.z + 10000 * Math.sin(a));
    assert.ok(Math.abs(drop - 7.85) < 0.02, `drop ${drop}`);
  }
});

test('offsetAt is 0 before set; set takes only heights for the latest samples', () => {
  const { ground, cols, rows } = loadGround(200);
  assert.equal(ground.offsetAt(1500, -6000), 0);
  assert.equal(ground.on, false);
  assert.throws(() => ground.set(new Array(cols * rows - 1).fill(0)), /match groundSamples/);
  assert.throws(() => ground.set(new Array(cols * rows + 1).fill(0)), /match groundSamples/);
  ground.set(gridPoints(ground, cols, rows).map(([x]) => x * 0.01));
  const before = ground.offsetAt(2000, 0);
  // A new sampling leaves the ground in place until heights for it arrive
  const next = ground.samples(100);
  assert.equal(ground.offsetAt(2000, 0), before);
  assert.throws(() => ground.set(new Array(cols * rows).fill(0)), /match groundSamples/);
  ground.set(new Array(next.cols * next.rows).fill(3));
  assert.ok(Math.abs(ground.offsetAt(ground.tangent.x, ground.tangent.z)) < 1e-9);
});

test('set fills heights the host had none for, and holds the city\'s freeboard over the host\'s sea', () => {
  const { ground, cols, rows } = loadGround(200);
  const pts = gridPoints(ground, cols, rows);
  // A river bed 15 m under the sea west of x = -1500, a tile missing in the north-east, land at 10 m elsewhere
  const sea = -32.7;
  const heights = pts.map(([x, z]) => (x < -1500 ? sea - 15 : x > 1500 && z < -5000 ? NaN : sea + 10));
  heights[5] = null;
  ground.set(heights, { seaLevel: sea });
  assert.ok(Math.abs(ground.height0 - (sea + 10)) < 1e-9);
  const t = ground.tangent;
  const curve = (x, z) => ((x - t.x) ** 2 + (z - t.z) ** 2) * ground.curvature;
  // The river bed lifts to 2.2 m over the sea, where the city's shore and piers stand over its own water
  const river = ground.offsetAt(-2600, 0) + curve(-2600, 0);
  assert.ok(Math.abs(river - (2.2 - 10)) < 1e-4, `river ${river}`);
  // The hole takes its neighbours' 10 m
  const hole = ground.offsetAt(2500, -6500) + curve(2500, -6500);
  assert.ok(Math.abs(hole) < 1e-4, `hole ${hole}`);
  assert.throws(() => ground.set(new Array(cols * rows).fill(NaN)), /no finite heights/);
});
