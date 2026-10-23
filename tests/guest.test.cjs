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

// THE HOST'S FRAME (js/guest.js): the options, the material pass, the view and the bounds, without a GPU
function loadGuest() {
  const LL = read('js/boroughs.js').match(/function LL\(lon, lat\) \{[^]*?\n\}/)[0];
  const window = { NYC: { THREE: { Matrix4 }, TSL: {}, Addons: {} } };
  const context = vm.createContext({ window, Math });
  vm.runInContext(`${LL}; window.NYC.lonLatToWorld = LL;`, context);
  vm.runInContext(read('js/guest.js'), context);
  return window.NYC;
}
const plain = (o) => JSON.parse(JSON.stringify(o));

test('composite and logDepth are off by default, and the other options keep their defaults', () => {
  const { guestOptions } = loadGuest();
  assert.deepEqual(plain(guestOptions()), {
    extent: 'manhattan', shadows: true, clearAlpha: 0, pixelRatio: 1, composite: false, logDepth: false, lights: true, crowds: true, drape: null
  });
  assert.deepEqual(plain(guestOptions({ extent: 'all', shadows: false, clearAlpha: 1, pixelRatio: 2, composite: true, logDepth: true, lights: false, crowds: false, drape: { tolerance: 0.1 } })), {
    extent: 'all', shadows: false, clearAlpha: 1, pixelRatio: 2, composite: true, logDepth: true, lights: false, crowds: false, drape: { tolerance: 0.1 }
  });
  // Only true turns them on
  const o = guestOptions({ composite: 1, logDepth: 'yes', extent: 'brooklyn' });
  assert.equal(o.composite, false);
  assert.equal(o.logDepth, false);
  assert.equal(o.extent, 'manhattan');
});

test('what a guest leaves out isn\'t built: the other boroughs, the crowds, the shadow stand-ins', () => {
  const guest = readFileSync(join(__dirname, '../js/guest.js'), 'utf8');
  assert.match(guest, /const boroughs = opts\.extent === 'all' \? step\('boroughs'/);
  assert.match(guest, /\{ pedestrians: opts\.crowds \}/);
  assert.match(guest, /setupSceneCulling\(scene, cullingRoots, opts\.shadows \? lighting\.sunLight\.shadow : null\)/);
  const traffic = readFileSync(join(__dirname, '../js/traffic.js'), 'utf8');
  assert.match(traffic, /function createTrafficSystem\(scene, sidewalks, obstacles, \{ pedestrians = true \} = \{\}\)/);
  // No crowd: none made, and every use of it guarded (the per-person ones run only for people there are)
  assert.match(traffic, /const pedCrowd = numPeds \? new PersonCrowd\(numPeds\) : null;/);
  for (const use of traffic.match(/^.*pedCrowd\.(?:begin|end|meshes).*$/gm)) assert.match(use, /if \(pedCrowd\)/);
  assert.doesNotMatch(traffic, /i < NUM_PEDS/);
});

test('the material pass sees each node material once, and keys its program by what it added', () => {
  const { prepareMaterials } = loadGuest();
  const mat = (extra = {}) => ({ isNodeMaterial: true, outputNode: null, customProgramCacheKey() { return 'base'; }, ...extra });
  const shared = mat();
  const placed = mat({ vertexNode: {} }); // places its own vertices: no lift
  const classic = { isNodeMaterial: false, customProgramCacheKey() { return 'classic'; } };
  const own = mat({ outputNode: 'own', mrtNode: { outputNodes: { normal: 0, metalRough: 0 } } });
  const objects = [{ material: shared }, { material: [shared, placed] }, { material: classic }, { material: own }, {}];
  const scene = { traverse: (fn) => objects.forEach(fn) };

  const lifted = [];
  const setupDepth = function () {};
  const n = prepareMaterials(scene, { lift: (m) => lifted.push(m), output: (node) => ['srgb', node], setupDepth });
  assert.equal(n, 3);
  assert.deepEqual(lifted, [shared, own]);
  assert.equal(shared.customProgramCacheKey(), 'base:ground:composite:logdepth');
  assert.equal(placed.customProgramCacheKey(), 'base:composite:logdepth');
  assert.equal(classic.customProgramCacheKey(), 'classic');
  assert.deepEqual(shared.outputNode, ['srgb', null]);
  assert.deepEqual(own.outputNode, ['srgb', 'own']);
  assert.equal(own.mrtNode, null, "a material's own MRT outputs go: with no MRT they'd replace its colour output");
  assert.equal(shared.setupDepth, setupDepth);
  assert.equal(shared.depthNode, undefined, 'the depth goes in through setupDepth: a shadow pass takes a depthNode for its own');

  // The ground alone, as before composite and logDepth: only the lift and its key
  const a = mat();
  const b = mat({ vertexNode: {} });
  prepareMaterials({ traverse: (fn) => [{ material: [a, b] }].forEach(fn) }, { lift: () => {} });
  assert.equal(a.customProgramCacheKey(), 'base:ground');
  assert.equal(b.customProgramCacheKey(), 'base');
  assert.equal(a.outputNode, null);
  assert.equal(a.setupDepth, undefined);
});

// A camera whose matrices only take arrays: what applyView reads back is fov, aspect, near and far
function stubCamera() {
  const m = () => ({ elements: null, fromArray(a) { this.elements = Array.from(a); return this; }, copy() { return this; }, invert() { return this; }, decompose() {} });
  return { matrixWorld: m(), matrixWorldInverse: m(), projectionMatrix: m(), projectionMatrixInverse: m() };
}
const perspective = (fovDeg, aspect, near, far) => {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, -(far + near) / (far - near), -1, 0, 0, (-2 * far * near) / (far - near), 0];
};
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('setView takes near and far as given, and decodes them from the projection only without them', () => {
  const { applyView } = loadGuest();
  // Cesium's single log-depth frustum over Manhattan: 0.1 m to 714 km
  const near = 0.1;
  const far = 713851.19;
  const p = perspective(60, 1.6, near, far);
  const cam = stubCamera();
  applyView(cam, { matrixWorld: IDENTITY, projectionMatrix: p, near, far });
  assert.equal(cam.near, near);
  assert.equal(cam.far, far);
  assert.ok(Math.abs(cam.fov - 60) < 1e-9 && Math.abs(cam.aspect - 1.6) < 1e-12);
  assert.equal(cam.matrixAutoUpdate, false);
  // Decoded from doubles it's close; from the same matrix in single precision (as a GPU-bound array holds it), far
  // is lost: p[10] + 1 is ~3e-7, under float32's resolution at 1
  applyView(cam, { matrixWorld: IDENTITY, projectionMatrix: p });
  assert.ok(Math.abs(cam.far / far - 1) < 1e-6, `far ${cam.far}`);
  applyView(cam, { matrixWorld: IDENTITY, projectionMatrix: Float32Array.from(p) });
  assert.ok(!(Math.abs(cam.far / far - 1) < 0.1), `float32 far ${cam.far} decoded within 10%`);
  applyView(cam, { matrixWorld: IDENTITY, projectionMatrix: Float32Array.from(p), near, far });
  assert.equal(cam.far, far);
});

test('the bounds take the flat box with the ground\'s lift and the curve, padded', () => {
  const { makeGeoFrame, makeGround, liftBounds } = loadGuest();
  const frame = makeGeoFrame();
  const ground = makeGround(frame);
  const box = { min: { x: -2300, y: -30, z: -7200 }, max: { x: 2600, y: 540, z: 6600 } };
  // Before the ground: the box, padded
  assert.deepEqual(plain(liftBounds(box, ground, 10)), {
    min: { x: -2310, y: -40, z: -7210 }, max: { x: 2610, y: 550, z: 6610 }
  });
  // A 60 m slope over the island: the box rises by its most and sinks by its least, less the curve at its far corner
  const { cols, rows } = ground.samples(200);
  ground.set(gridPoints(ground, cols, rows).map(([x, z]) => -10 + 0.004 * x - 0.002 * z));
  const lift = ground.liftRange(box.min.x, box.max.x, box.min.z, box.max.z);
  const t = ground.tangent;
  const corner = Math.max(...[[box.min.x, box.min.z], [box.min.x, box.max.z], [box.max.x, box.min.z], [box.max.x, box.max.z]]
    .map(([x, z]) => (x - t.x) ** 2 + (z - t.z) ** 2)) * ground.curvature;
  assert.ok(Math.abs(lift.min - (ground.range.min - corner)) < 1e-9);
  assert.equal(lift.max, ground.range.max, 'the tangent point is inside the box: no curve off the most');
  // Every grid point's lift is inside the range
  for (const [x, z] of gridPoints(ground, cols, rows)) {
    if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue;
    const o = ground.offsetAt(x, z);
    assert.ok(o >= lift.min - 1e-6 && o <= lift.max + 1e-6, `${x}, ${z}: ${o}`);
  }
  const b = liftBounds(box, ground, 0);
  assert.ok(Math.abs(b.min.y - (box.min.y + lift.min)) < 1e-9 && Math.abs(b.max.y - (box.max.y + lift.max)) < 1e-9);
  assert.equal(b.min.x, box.min.x);
});

test('the ground layers split until no edge spans more than the detail across the ground, watertight', () => {
  const { subdivideTriangles } = loadGuest();
  // A 100 x 60 m slab top (two triangles, up), a 100 m x 0.25 m side under its north edge, a face looking down, and a
  // wall reaching out of the band; uv = (x / 100, z / 60)
  const P = [[0, 0.25, 0], [0, 0.25, 60], [100, 0.25, 60], [100, 0.25, 0], [0, 0, 0], [100, 0, 0], [0, 0, 60], [100, 0, 60], [0, 9, 0]];
  const position = P.flat();
  const uv = P.flatMap(([x, , z]) => [x / 100, z / 60]);
  const normal = P.flatMap(() => [0, 1, 0]);
  const index = [0, 1, 2, 0, 2, 3, /* side */ 0, 3, 5, 0, 5, 4, /* down */ 4, 7, 6, /* tall */ 4, 5, 8];
  const mesh = { attrs: { position: { array: position, itemSize: 3 }, uv: { array: uv, itemSize: 2 }, normal: { array: normal, itemSize: 3 } }, index, world: position };
  const out = subdivideTriangles(mesh, 20);
  const pos = out.attrs.position;
  const at = (i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
  const tris = [];
  for (let t = 0; t < out.index.length; t += 3) tris.push([out.index[t], out.index[t + 1], out.index[t + 2]].map(at));
  const flat = (y) => (t) => t.every((p) => p[1] === y);
  const top = tris.filter(flat(0.25));
  const area = (t) => ((t[1][2] - t[0][2]) * (t[2][0] - t[0][0]) - (t[1][0] - t[0][0]) * (t[2][2] - t[0][2])) / 2; // the normal's y / 2: > 0 up
  const lenXZ = (p, q) => Math.hypot(p[0] - q[0], p[2] - q[2]);
  // the top: every edge within 20 m, the same area, wound as before (up), and no T-junctions: each inner edge twice
  for (const t of top) for (let k = 0; k < 3; k++) assert.ok(lenXZ(t[k], t[(k + 1) % 3]) <= 20 + 1e-9);
  assert.ok(Math.abs(top.reduce((s, t) => s + area(t), 0) - 6000) < 1e-6);
  assert.ok(top.every((t) => area(t) > 0));
  const edges = new Map();
  for (const t of top) for (let k = 0; k < 3; k++) {
    const key = [t[k], t[(k + 1) % 3]].map((p) => p.join()).sort().join('|');
    edges.set(key, (edges.get(key) || 0) + 1);
  }
  let boundary = 0;
  for (const [key, n] of edges) {
    assert.ok(n <= 2, key);
    if (n === 1) boundary += lenXZ(...key.split('|').map((s) => s.split(',').map(Number)));
  }
  assert.ok(Math.abs(boundary - 320) < 1e-6, 'the outline is whole: no edge split on one side and not the other');
  // the side splits along with the top's edge it shares, so it follows the ground too
  const side = tris.filter((t) => t.every((p) => p[2] === 0) && t.some((p) => p[1] > 0) && t.every((p) => p[1] <= 0.25));
  assert.ok(side.length >= 10 && side.every((t) => t.every((p, k) => lenXZ(p, t[(k + 1) % 3]) <= 20 + 1e-9)));
  // attributes interpolate linearly; the face looking down and the tall wall are left whole
  for (let i = 0; i < pos.length / 3; i++) {
    assert.ok(Math.abs(out.attrs.uv[2 * i] - pos[3 * i] / 100) < 1e-6 && Math.abs(out.attrs.uv[2 * i + 1] - pos[3 * i + 2] / 60) < 1e-6);
  }
  assert.equal(tris.filter(flat(0)).length, 1);
  assert.equal(tris.filter((t) => t.some((p) => p[1] === 9)).length, 1);
  // nothing to split: null
  assert.equal(subdivideTriangles({ attrs: { position: { array: [0, 0, 0, 0, 0, 5, 5, 0, 0], itemSize: 3 } }, index: null, world: [0, 0, 0, 0, 0, 5, 5, 0, 0] }, 20), null);
});

test('slivers (corners in a line) never ask for a split; walls (in a line across x, z only) do', () => {
  const { subdivideTriangles } = loadGuest();
  // A fan of flat slivers along a line: on real terrain such shore slivers never settled, and the splitting looped
  const xs = [0, 7, 13, 31, 40, 55, 58, 77, 90, 100];
  const flat = xs.flatMap((x) => [x, 0, x * 0.3]);
  const fan = [];
  for (let i = 1; i + 1 < xs.length; i++) fan.push(0, i, i + 1);
  assert.equal(subdivideTriangles({ attrs: { position: { array: flat, itemSize: 3 } }, index: fan, world: flat }, 2), null);
  // A wall 100 m long and 0.25 m tall splits to the detail
  const wall = [0, 0, 0, 100, 0, 0, 100, 0.25, 0, 0, 0.25, 0];
  const out = subdivideTriangles({ attrs: { position: { array: wall, itemSize: 3 } }, index: [0, 1, 2, 0, 2, 3], world: wall }, 20);
  assert.ok(out && out.triangles >= 10, `${out && out.triangles}`);
});

test('a triangle budget stops the splitting before a pass would pass it, and the mesh stays watertight', () => {
  const { subdivideTriangles } = loadGuest();
  const P = [[0, 0, 0], [0, 0, 60], [100, 0, 60], [100, 0, 0]];
  const position = P.flat();
  const mesh = { attrs: { position: { array: position, itemSize: 3 } }, index: [0, 1, 2, 0, 2, 3], world: position };
  const free = subdivideTriangles(mesh, 2);
  assert.equal(free.capped, false);
  const capped = subdivideTriangles(mesh, 2, undefined, 200);
  assert.equal(capped.capped, true);
  assert.ok(capped.triangles <= 200 && capped.triangles > 50 && capped.triangles < free.triangles, `${capped.triangles}`);
  const pos = capped.attrs.position;
  const key = (i) => `${pos[3 * i]},${pos[3 * i + 2]}`;
  const edges = new Map();
  let area = 0;
  for (let t = 0; t < capped.index.length; t += 3) {
    const [a, b, c] = [capped.index[t], capped.index[t + 1], capped.index[t + 2]];
    area += ((pos[3 * b + 2] - pos[3 * a + 2]) * (pos[3 * c] - pos[3 * a]) - (pos[3 * b] - pos[3 * a]) * (pos[3 * c + 2] - pos[3 * a + 2])) / 2;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = [key(p), key(q)].sort().join('|');
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  assert.ok(Math.abs(area - 6000) < 1e-6);
  let boundary = 0;
  for (const [k, n] of edges) {
    if (n === 1) {
      const [p, q] = k.split('|').map((s) => s.split(',').map(Number));
      boundary += Math.hypot(p[0] - q[0], p[1] - q[1]);
    }
  }
  assert.ok(Math.abs(boundary - 320) < 1e-6, 'no T-junctions');
});
