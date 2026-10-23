const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// js/ground.js, shared by the guest and the app (index.html?ground=demo), without a GPU
const read = (file) => readFileSync(join(__dirname, '..', file), 'utf8');

class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  set(...n) {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) this.elements[c * 4 + r] = n[r * 4 + c];
    return this;
  }
}

function loadGround() {
  const LL = read('js/boroughs.js').match(/function LL\(lon, lat\) \{[^]*?\n\}/)[0];
  const window = { NYC: { THREE: { Matrix4 }, TSL: {}, Addons: {} } };
  const context = vm.createContext({ window, Math, performance });
  vm.runInContext(`${LL}; window.NYC.lonLatToWorld = LL;`, context);
  vm.runInContext(read('js/ground.js'), context);
  return window.NYC;
}

test('the app has no ground without ?ground=demo, and loading ground.js touches neither three nor the TSL', () => {
  const NYC = loadGround();
  for (const mode of [null, '', 'flat', 'DEMO', 'Terrain']) assert.equal(NYC.createAppGround(mode), null);
  assert.equal(NYC.createAppGround(new URLSearchParams('hill=150&spread=600')), null);
  assert.equal(NYC.groundLift, undefined, 'deckPosition stays positionWorld');
});

test('main.js reaches the ground only through createAppGround, each use guarded', () => {
  const main = read('js/main.js');
  assert.match(main, /const appGround = window\.NYC\.createAppGround\(new URLSearchParams\(location\.search\)\);/);
  // the terrain's heights arrive while the city builds: attach() is awaited before the shaders compile
  assert.match(main, /if \(appGround\) await appGround\.attach\(scene, markInit\);/);
  const uses = main.match(/^.*appGround\b.*$/gm).filter((l) => !/const appGround =|^\s*\/\//.test(l));
  assert.ok(uses.length >= 4);
  for (const use of uses) assert.match(use, /if \(appGround\)|ground: appGround/, use);
  // before the city is built, the layers before the culling set-up, the materials before the shaders compile
  const at = (re) => main.search(re);
  assert.ok(at(/const appGround =/) < at(/buildCityGrid\(scene\)/));
  assert.ok(at(/appGround\.takeLayers/) < at(/setupSceneCulling\(/));
  assert.ok(at(/appGround\.attach/) < at(/await precompileShaders\(\)/));
  assert.ok(at(/appGround\.beforeRender/) < at(/renderPipeline\.render\(\);\n\s*for \(const o of culled\)/));
});

test('the demo ground is the 40 m hill over Midtown, and the app\'s keeps its flat land, and the harbour, in place', () => {
  const NYC = loadGround();
  const frame = NYC.makeGeoFrame();
  // A host's demo (guest.html): the curve, and nothing lifted at the tangent point
  const host = NYC.makeGround(frame);
  const s = host.samples(100);
  host.set(NYC.demoGroundHeights(s.lonLat, frame), { seaLevel: NYC.DEMO_SEA_LEVEL });
  assert.ok(Math.abs(host.offsetAt(host.tangent.x, host.tangent.z)) < 1e-4);
  assert.ok(host.curvature > 0);
  // The app's: no curve, the flat land at 0 and the hill's top 40 m up, over a grid 12 km out
  const bounds = { x0: -7500, x1: 7000, z0: -8500, z1: 7500 }; // ground.js APP_GROUND_BOUNDS
  const app = NYC.makeGround(frame, bounds, { curve: false });
  const a = app.samples(200);
  app.set(NYC.demoGroundHeights(a.lonLat, frame), { seaLevel: NYC.DEMO_SEA_LEVEL, height0: NYC.DEMO_SEA_LEVEL + 5 });
  assert.equal(app.curvature, 0);
  assert.equal(app.height0, NYC.DEMO_SEA_LEVEL + 5);
  assert.ok(Math.abs(app.offsetAt(-300, -900) - 40) < 0.5, `top ${app.offsetAt(-300, -900)}`);
  assert.ok(Math.abs(app.offsetAt(0, 0) - 27.6) < 0.5, `5th Ave & 42nd St ${app.offsetAt(0, 0)}`);
  // the 60 km water plane's corners, and New Jersey: nothing
  for (const [x, z] of [[-30000, -30050], [30000, 29950], [-9000, 0]]) assert.ok(Math.abs(app.offsetAt(x, z)) < 1e-3, `${x}, ${z}`);
  // the steepest grade, 2.2%, a σ out
  const g = (app.offsetAt(-300 + 1105, -900) - app.offsetAt(-300 + 1095, -900)) / 10;
  assert.ok(Math.abs(g + 0.022) < 0.001, `grade ${g}`);
});

test('the app keeps the materials\' own MRT outputs, which the guest drops', () => {
  const NYC = loadGround();
  const mat = () => ({ isNodeMaterial: true, mrtNode: { outputNodes: { emissive: 0 } }, customProgramCacheKey() { return 'k'; } });
  const a = mat();
  const b = mat();
  NYC.prepareMaterials({ traverse: (fn) => fn({ material: a }) }, { lift: () => {}, keepMRT: true });
  NYC.prepareMaterials({ traverse: (fn) => fn({ material: b }) }, { lift: () => {} });
  assert.ok(a.mrtNode);
  assert.equal(b.mrtNode, null);
  assert.equal(a.customProgramCacheKey(), 'k:ground');
});

test('a slab\'s underside follows the ground as its top does: over the hill\'s foot it stays under the top', () => {
  const NYC = loadGround();
  const frame = NYC.makeGeoFrame();
  const app = NYC.makeGround(frame, { x0: -7500, x1: 7000, z0: -8500, z1: 7500 }, { curve: false });
  const s = app.samples(40);
  app.set(NYC.demoGroundHeights(s.lonLat, frame), { seaLevel: NYC.DEMO_SEA_LEVEL, height0: NYC.DEMO_SEA_LEVEL + 5 });
  // No dip in the ground itself: Sheep Meadow (x -526, 66th St at z -1926) is on the hill's north flank, falling all
  // the way from 59th St to 72nd St
  for (let z = -1400; z > -2400; z -= 25) assert.ok(app.offsetAt(-526, z - 25) < app.offsetAt(-526, z), `${z}`);
  // A slab 4 km long from 59th St north, as Central Park's curb island: a top 0.18 m up (facing up), an underside at 0
  // (facing down), two triangles each
  const [x0, x1, z0, z1] = [-600, -450, -5400, -1400];
  const corners = [[x0, z0], [x0, z1], [x1, z1], [x1, z0]];
  const position = [...corners.flatMap(([x, z]) => [x, 0.18, z]), ...corners.flatMap(([x, z]) => [x, 0, z])];
  const index = [0, 1, 2, 0, 2, 3, /* underside */ 4, 6, 5, 4, 7, 6];
  const out = NYC.subdivideTriangles({ attrs: { position: { array: position, itemSize: 3 } }, index, world: position }, 40);
  const pos = out.attrs.position;
  // The height a face is drawn at over (x, z): its triangle there, each corner lifted by the ground under it
  const drawnAt = (y, x, z) => {
    for (let t = 0; t < out.index.length; t += 3) {
      const [a, b, c] = [out.index[t], out.index[t + 1], out.index[t + 2]].map((i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
      if ([a, b, c].some((p) => Math.abs(p[1] - y) > 1e-6)) continue; // float32 heights
      const det = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
      const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / det;
      const l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / det;
      const l3 = 1 - l1 - l2;
      if (Math.min(l1, l2, l3) < -1e-9) continue;
      return [a, b, c].reduce((sum, p, k) => sum + [l1, l2, l3][k] * (p[1] + app.offsetAt(p[0], p[2])), 0);
    }
    return NaN;
  };
  for (let z = -1450; z > -5400; z -= 50) {
    const top = drawnAt(0.18, -526, z);
    const under = drawnAt(0, -526, z);
    assert.ok(under < top - 0.1, `at z ${z} the underside is drawn at ${under.toFixed(2)}, the top at ${top.toFixed(2)}`);
    assert.ok(Math.abs(top - 0.18 - app.offsetAt(-526, z)) < 0.05, `top at z ${z}`);
  }
  // and the shadow stand-ins leave the ground layers to cast their own (a stand-in is a copy of the flat geometry)
  assert.match(read('js/scene-culling.js'), /if \(o\.userData\.flatGeometry\) return;/);
});

test('?ground, ?hill and ?spread: the modes, the demo hill\'s height and σ, their defaults and limits', () => {
  const NYC = loadGround();
  const parse = (q) => JSON.parse(JSON.stringify(NYC.parseGroundOptions(new URLSearchParams(q)))); // out of the vm's realm
  assert.equal(parse(''), null);
  assert.equal(parse('hill=150'), null, 'hill without a ground');
  assert.deepEqual(parse('ground=terrain'), { mode: 'terrain' });
  assert.deepEqual(parse('ground=demo').hill, { height: 40, sigma: 1100 }, 'the defaults, as before');
  assert.deepEqual(parse('ground=demo&hill=150&spread=600').hill, { height: 150, sigma: 600 });
  assert.deepEqual(parse('ground=demo&webgl&hill=12.5').hill, { height: 12.5, sigma: 1100 });
  assert.deepEqual(parse('ground=demo&hill=-5&spread=10').hill, { height: 0, sigma: 100 }, 'clamped');
  assert.deepEqual(parse('ground=demo&hill=9000&spread=1e9').hill, { height: 400, sigma: 3000 });
  assert.deepEqual(parse('ground=demo&hill=abc&spread=').hill, { height: 40, sigma: 1100 }, 'not numbers: the defaults');
  // just ?ground's value, as before
  assert.equal(NYC.parseGroundOptions('demo').hill.sigma, 1100);
  assert.equal(NYC.parseGroundOptions('terrain').mode, 'terrain');
});

test('the demo\'s grid holds the hill whatever its spread: gone at the edge, sampled finely enough', () => {
  const NYC = loadGround();
  const frame = NYC.makeGeoFrame();
  const app = { x0: -7500, x1: 7000, z0: -8500, z1: 7500 }; // ground.js APP_GROUND_BOUNDS
  assert.deepEqual(JSON.parse(JSON.stringify(NYC.demoGroundGrid({ height: 40, sigma: 1100 }))), { bounds: app, spacing: 40 }, 'the default as before');
  for (const hill of [{ height: 150, sigma: 600 }, { height: 400, sigma: 100 }, { height: 150, sigma: 2500 }, { height: 400, sigma: 3000 }]) {
    const { bounds, spacing } = NYC.demoGroundGrid(hill);
    for (const k of ['x0', 'z0']) assert.ok(bounds[k] <= app[k]);
    for (const k of ['x1', 'z1']) assert.ok(bounds[k] >= app[k]);
    assert.ok(spacing <= hill.sigma / 10 + 1e-9 || spacing === 10, `${hill.sigma}: ${spacing} m`);
    const g = NYC.makeGround(frame, bounds, { curve: false, linear: true });
    const s = g.samples(spacing);
    g.set(NYC.demoGroundHeights(s.lonLat, frame, NYC.DEMO_SEA_LEVEL, hill), { seaLevel: NYC.DEMO_SEA_LEVEL, height0: NYC.DEMO_SEA_LEVEL + 5 });
    assert.ok(Math.abs(g.offsetAt(-300, -900) - hill.height) < hill.height * 0.01 + 0.05, `top ${g.offsetAt(-300, -900)}`);
    // the grid's edge, and past it (the 60 km water plane's corners hold it): the hill is gone
    for (const [x, z] of [[bounds.x0, -900], [bounds.x1, -900], [-300, bounds.z0], [-300, bounds.z1], [-30000, -30050], [30000, 29950]]) {
      assert.ok(g.offsetAt(x, z) < 1e-6, `${JSON.stringify(hill)} at ${x}, ${z}: ${g.offsetAt(x, z)}`);
    }
  }
  // 150 m over a 600 m σ: a 15% grade at its steepest, a σ out
  const hill = { height: 150, sigma: 600 };
  const s = new Float64Array(2);
  const h = (x) => {
    const ll = frame.worldToLonLat(x, -900);
    s[0] = ll.lon;
    s[1] = ll.lat;
    return NYC.demoGroundHeights(s, frame, 0, hill)[0];
  };
  const grade = (h(-300 + 605) - h(-300 + 595)) / 10;
  assert.ok(Math.abs(grade + 0.152) < 0.002, `grade ${grade}`);
});

test('a linear ground is linear over each cell\'s two triangles, split from its (i + 1, j) corner to its (i, j + 1) one', () => {
  const NYC = loadGround();
  const frame = NYC.makeGeoFrame();
  const g = NYC.makeGround(frame, { x0: 0, x1: 20, z0: 0, z1: 20 }, { curve: false, linear: true });
  const s = g.samples(10);
  assert.equal(s.cols, 3);
  // the corners of the first cell: 0 at (0, 0), 4 at (10, 0), 8 at (0, 10), 2 at (10, 10)
  const at = { '0,0': 0, '1,0': 4, '0,1': 8, '1,1': 2 };
  const heights = Array.from({ length: 9 }, (_, i) => at[`${i % 3},${Math.floor(i / 3)}`] ?? 0);
  g.set(heights, { height0: 0 });
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(near(g.offsetAt(5, 5), 6), 'the diagonal\'s midpoint, between (10, 0) and (0, 10)');
  assert.ok(near(g.offsetAt(2, 2), 0 + 4 * 0.2 + 8 * 0.2), 'the lower triangle');
  assert.ok(near(g.offsetAt(8, 8), 2 + (8 - 2) * 0.2 + (4 - 2) * 0.2), 'the upper triangle');
  // bilinear, as before, without linear
  const b = NYC.makeGround(frame, { x0: 0, x1: 20, z0: 0, z1: 20 }, { curve: false });
  b.samples(10);
  b.set(heights, { height0: 0 });
  assert.ok(near(b.offsetAt(5, 5), 3.5));
});

// The cut to a linear ground's grid (conformTriangles): exact, watertight, the undersides left out
test('a layer cut to the grid follows the linear ground exactly, stays watertight, and loses its hidden undersides', () => {
  const NYC = loadGround();
  const frame = NYC.makeGeoFrame();
  const bounds = { x0: 0, x1: 100, z0: 0, z1: 100 };
  const g = NYC.makeGround(frame, bounds, { curve: false, linear: true });
  const s = g.samples(10);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // a rough ground on the left half, 0 on the right (whose cells are quiet)
  g.set(Array.from({ length: s.cols * s.rows }, (_, i) => ((i % s.cols) < 6 ? rnd() * 5 : 0)), { height0: 0 });
  // a quad over the rough half (two triangles sharing their diagonal), one in the quiet half, an underside, a wall
  const position = [
    3, 0.1, 4, 47, 0.1, 9, 41, 0.1, 52, 6, 0.1, 47, // the quad: 0 1 2 3
    72, 0.1, 10, 95, 0.1, 12, 80, 0.1, 40, // in the quiet half: 4 5 6
    5, 0, 5, 30, 0, 30, 30, 0, 5, // facing down: 7 8 9
    12, 0, 33, 44, 0, 21, 44, 1, 21, 12, 1, 33 // a wall across the cells: 10 11 12 13
  ];
  const uv = [];
  for (let i = 0; i < position.length; i += 3) uv.push(position[i] / 100, position[i + 2] / 100);
  const index = [0, 3, 2, 0, 2, 1, 4, 6, 5, 7, 9, 8, 10, 11, 12, 10, 12, 13];
  const quietCells = (u0, u1, w0, w1) => Math.floor(u0) >= 6;
  const out = NYC.conformTriangles({ attrs: { position: { array: position, itemSize: 3 }, uv: { array: uv, itemSize: 2 } }, index, world: position }, g.grid, [-3, 3.5], quietCells, 0.35);
  const P = out.attrs.position;
  const UV = out.attrs.uv;
  const tris = [];
  for (let t = 0; t < out.index.length; t += 3) tris.push([0, 1, 2].map((k) => out.index[t + k]));
  const xyz = (v) => [P[3 * v], P[3 * v + 1], P[3 * v + 2]];
  // each vertex's uv is its own place's (attributes interpolated along the cuts)
  for (let v = 0; v < out.vertices; v++) {
    if (!out.index.includes(v)) continue;
    assert.ok(Math.abs(UV[2 * v] - P[3 * v] / 100) < 1e-5 && Math.abs(UV[2 * v + 1] - P[3 * v + 2] / 100) < 1e-5, `uv of ${v}`);
  }
  // the underside is gone, the quiet triangle whole
  assert.ok(!tris.some((t) => t.some((v) => v >= 7 && v <= 9)), 'the underside');
  assert.ok(tris.some((t) => t.join() === '4,6,5'), 'the quiet triangle, as it was');
  // every piece of the quad and the wall lies in one of the ground's triangles, where the drawn surface is the ground
  const e = 1e-6;
  let pieces = 0;
  for (const t of tris) {
    const p = t.map(xyz);
    if (p[0][0] > 60) continue;
    pieces++;
    const u = p.map((q) => q[0] / 10);
    const w = p.map((q) => q[2] / 10);
    const cu = (u[0] + u[1] + u[2]) / 3;
    const cw = (w[0] + w[1] + w[2]) / 3;
    const [i, j, d] = [Math.floor(cu), Math.floor(cw), Math.floor(cu + cw)];
    for (let k = 0; k < 3; k++) {
      assert.ok(u[k] > i - e && u[k] < i + 1 + e && w[k] > j - e && w[k] < j + 1 + e && u[k] + w[k] > d - e && u[k] + w[k] < d + 1 + e, `piece ${t} straddles a line`);
    }
    for (const [a, b] of [[1 / 3, 1 / 3], [0.2, 0.7], [0.6, 0.1]]) {
      const x = p[0][0] * (1 - a - b) + p[1][0] * a + p[2][0] * b;
      const z = p[0][2] * (1 - a - b) + p[1][2] * a + p[2][2] * b;
      const drawn = p.reduce((sum, q, k) => sum + [1 - a - b, a, b][k] * g.offsetAt(q[0], q[2]), 0);
      assert.ok(Math.abs(drawn - g.offsetAt(x, z)) < 1e-4, `drawn ${drawn} against the ground ${g.offsetAt(x, z)}`);
    }
  }
  assert.ok(pieces > 40, `${pieces} pieces`);
  // watertight: the quad's outline is all its open edges (their length its perimeter), its diagonal cut alike on both
  // sides; and the wall stays one strip (its open edges its outline)
  const edges = new Map();
  for (const t of tris) {
    for (let k = 0; k < 3; k++) {
      const [a, b] = [xyz(t[k]), xyz(t[(k + 1) % 3])].map((q) => q.join(','));
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let open = 0;
  for (const [key, n] of edges) {
    const [a, b] = key.split('|').map((q) => q.split(',').map(Number));
    if (n === 1 && a[0] <= 60 && b[0] <= 60) open += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  const len = (a, b) => Math.hypot(position[3 * a] - position[3 * b], position[3 * a + 1] - position[3 * b + 1], position[3 * a + 2] - position[3 * b + 2]);
  const perimeter = len(0, 1) + len(1, 2) + len(2, 3) + len(3, 0) + len(10, 11) + len(11, 12) + len(12, 13) + len(13, 10);
  assert.ok(Math.abs(open - perimeter) < 1e-3, `open edges ${open.toFixed(4)} m against the outlines' ${perimeter.toFixed(4)} m`);
});

test('the terrain stays on Manhattan: the mask is the island\'s, the bridge left where it is modelled, its stand-in too', () => {
  const NYC = loadGround();
  // a square island and an L
  const sq = [0, 0, 10, 0, 10, 10, 0, 10];
  const keep = NYC.manhattanMask({ x0: -5, z0: -5, dx: 5, dz: 5, cols: 5, rows: 5 }, [sq]);
  const at = (x, z) => keep[((z + 5) / 5) * 5 + (x + 5) / 5];
  assert.equal(at(5, 5), 1);
  assert.equal(at(0, 5), 1, 'on the shore');
  assert.equal(at(-5, 5), 0);
  assert.equal(at(15, 15), 0);
  assert.equal(at(5, 10), 0, 'rows are half-open: the north shore\'s row is out');
  assert.equal(keep.reduce((a, b) => a + b, 0), 6);
  const src = read('js/ground.js');
  assert.match(src, /const APP_FIXED = \['George Washington Bridge'\];/);
  assert.match(read('js/scene-culling.js'), /if \(o\.userData\.groundFixed\) return;/);
  // the elevation tiles are fetched by terrarium.mjs alone, which ground.js imports only for ?ground=terrain
  assert.doesNotMatch(src, /\bfetch\(/);
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.equal((code.match(/\bimport\(/g) || []).length, 1);
  assert.doesNotMatch(read('index.html'), /terrarium/);
});

test('what stands on the street sinks its foot into a bent ground; the ground layers, the bridge and the skinned don\'t', () => {
  const NYC = loadGround();
  const mesh = (name, extra = {}) => ({ name, isMesh: true, userData: {}, ...extra });
  const building = mesh('Facade');
  const layer = mesh('Deck', { userData: { flatGeometry: {} } });
  const bridge = mesh('George Washington Bridge', { userData: { groundFixed: true } });
  const person = mesh('Walker', { isSkinnedMesh: true });
  const lamp = mesh('Lamp');
  const car = mesh('Taxi');
  const roots = { ManhattanCityBlocks: [building, layer], Boroughs: [bridge, person], ManhattanStreetDetails: [lamp], Traffic: [car] };
  const scene = { getObjectByName: (n) => roots[n] && { traverse: (fn) => roots[n].forEach(fn) } };
  assert.equal(NYC.skirtObjects(scene), 2);
  assert.ok(building.userData.groundSkirt && lamp.userData.groundSkirt);
  for (const o of [layer, bridge, person, car]) assert.ok(!o.userData.groundSkirt, o.name);
});
