const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { loadModule } = require('./module.cjs');

// js/ground.js and js/guest.js without a GPU, three.js or the city (tests/ground.test.cjs, guest.test.cjs): their
// imports are stubs, but for boroughs.js's lon/lat map (LL, as it stands there) and nyc-geodata.js's GEO, which the
// frame and the Manhattan mask read. Neither module makes a three object or a TSL node when it loads, so three is a
// Matrix4 (three's set(): row-major arguments, column-major elements) and the TSL nothing.
const read = (file) => readFileSync(join(__dirname, '../..', file), 'utf8');

class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  set(...n) {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) this.elements[c * 4 + r] = n[r * 4 + c];
    return this;
  }
}

const globals = () => ({ performance, URLSearchParams, console });

let geo = null;
function geoData() {
  if (!geo) geo = loadModule(read('js/nyc-geodata.js'), { filename: 'nyc-geodata.js' });
  return geo;
}

function lonLatToWorld() {
  const LL = read('js/boroughs.js').match(/function LL\(lon, lat\) \{[^]*?\n\}/)[0];
  return loadModule(`${LL}\nexport { LL };`, { filename: 'boroughs.js (LL)' }).LL;
}

// Every import of `source` stubbed: `given` by specifier, the rest empty
function stubs(source, given) {
  const imports = {};
  for (const [, specifier] of source.matchAll(/^import\s+[^;]*?\s+from\s+['"]([^'"]+)['"]\s*;/gm)) {
    imports[specifier] = given[specifier] || {};
  }
  return imports;
}

// ground.js: its exports, and the lifts it hands tsl-materials.js (setGroundLift), in order
function loadGround() {
  const source = read('js/ground.js');
  const lifts = [];
  const ground = loadModule(source, {
    filename: 'ground.js',
    globals: globals(),
    imports: stubs(source, {
      'three/webgpu': { Matrix4 },
      './nyc-geodata.js': geoData(),
      './boroughs.js': { lonLatToWorld: lonLatToWorld() },
      './tsl-materials.js': { setGroundLift: (lift) => lifts.push(lift) }
    })
  });
  return { ...ground, lonLatToWorld: lonLatToWorld(), groundLifts: lifts };
}

// guest.js, on ground.js as above: both modules' exports
function loadGuest() {
  const ground = loadGround();
  const source = read('js/guest.js');
  const guest = loadModule(source, {
    filename: 'guest.js',
    globals: globals(),
    imports: stubs(source, { 'three/webgpu': { Matrix4 }, './ground.js': ground })
  });
  return { ...ground, ...guest };
}

module.exports = { Matrix4, loadGround, loadGuest, read };
