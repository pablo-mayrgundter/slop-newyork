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
