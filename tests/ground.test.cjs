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
