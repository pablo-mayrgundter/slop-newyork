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
  for (const mode of [null, '', 'flat', 'DEMO']) assert.equal(NYC.createAppGround(mode), null);
  assert.equal(NYC.groundLift, undefined, 'deckPosition stays positionWorld');
});

test('main.js reaches the ground only through createAppGround, each use guarded', () => {
  const main = read('js/main.js');
  assert.match(main, /const appGround = window\.NYC\.createAppGround\(new URLSearchParams\(location\.search\)\.get\('ground'\)\);/);
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
