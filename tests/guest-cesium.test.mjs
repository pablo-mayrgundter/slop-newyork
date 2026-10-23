// js/guest-cesium.mjs with a stub Cesium: the city's bounding volume and sun on the globe, and the ExternalRenderer's
// per-frustum and per-frame work, without a GPU or a Cesium build
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  cityModelMatrix, cityBoundingVolume, cityBoundingSphere, sunFromCesium, cesiumScreenFramebuffer, cesiumExternalRenderer
} from '../js/guest-cesium.mjs';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// ---- A stub of the few Cesium functions the helpers use: column-major, indexable matrices, WGS84 ENU ----
class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  static normalize(v, r) {
    const l = Math.hypot(v.x, v.y, v.z);
    r.x = v.x / l; r.y = v.y / l; r.z = v.z / l;
    return r;
  }
  static fromDegrees(lon, lat, h = 0) {
    const A = 6378137.0;
    const E2 = 6.69437999014e-3;
    const l = (lon * Math.PI) / 180;
    const p = (lat * Math.PI) / 180;
    const n = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
    return new Cartesian3((n + h) * Math.cos(p) * Math.cos(l), (n + h) * Math.cos(p) * Math.sin(l), (n * (1 - E2) + h) * Math.sin(p));
  }
}
class Matrix4 {
  constructor() { for (let i = 0; i < 16; i++) this[i] = i % 5 === 0 ? 1 : 0; }
  static fromColumnMajorArray(a, r = new Matrix4()) { for (let i = 0; i < 16; i++) r[i] = a[i]; return r; }
  static toArray(m, r = []) { for (let i = 0; i < 16; i++) r[i] = m[i]; return r; }
  static multiply(a, b, r) {
    const o = [];
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      o[c * 4 + row] = s;
    }
    return Matrix4.fromColumnMajorArray(o, r);
  }
  static inverse(m, r) {
    // Gauss-Jordan on rows of [M | I]
    const a = [0, 1, 2, 3].map((row) => [0, 1, 2, 3].map((c) => m[c * 4 + row]).concat([0, 1, 2, 3].map((c) => (c === row ? 1 : 0))));
    for (let c = 0; c < 4; c++) {
      let piv = c;
      for (let row = c + 1; row < 4; row++) if (Math.abs(a[row][c]) > Math.abs(a[piv][c])) piv = row;
      [a[c], a[piv]] = [a[piv], a[c]];
      const d = a[c][c];
      for (let k = 0; k < 8; k++) a[c][k] /= d;
      for (let row = 0; row < 4; row++) {
        if (row === c) continue;
        const f = a[row][c];
        for (let k = 0; k < 8; k++) a[row][k] -= f * a[c][k];
      }
    }
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) r[c * 4 + row] = a[row][4 + c];
    return r;
  }
  static multiplyByPoint(m, p, r) {
    r.x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
    r.y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
    r.z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
    return r;
  }
  static multiplyByPointAsVector(m, p, r) {
    const x = m[0] * p.x + m[4] * p.y + m[8] * p.z;
    const y = m[1] * p.x + m[5] * p.y + m[9] * p.z;
    const z = m[2] * p.x + m[6] * p.y + m[10] * p.z;
    r.x = x; r.y = y; r.z = z;
    return r;
  }
}
class Matrix3 {
  constructor() { for (let i = 0; i < 9; i++) this[i] = 0; }
  static fromColumnMajorArray(a, r = new Matrix3()) { for (let i = 0; i < 9; i++) r[i] = a[i]; return r; }
  static clone(m, r = new Matrix3()) { return Matrix3.fromColumnMajorArray(m, r); }
}
class OrientedBoundingBox {
  constructor() { this.center = new Cartesian3(); this.halfAxes = new Matrix3(); }
}
const Cesium = {
  Cartesian3, Matrix4, Matrix3, OrientedBoundingBox,
  BoundingSphere: {
    fromOrientedBoundingBox(box, r = {}) {
      const h = box.halfAxes;
      r.center = box.center;
      r.radius = Math.hypot(h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]);
      return r;
    }
  },
  Transforms: {
    eastNorthUpToFixedFrame(o) {
      const lon = Math.atan2(o.y, o.x);
      const lat = Math.atan2(o.z, Math.hypot(o.x, o.y) * (1 - 6.69437999014e-3)); // geodetic, closely enough here
      const e = [-Math.sin(lon), Math.cos(lon), 0];
      const n = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
      const u = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
      return Matrix4.fromColumnMajorArray([...e, 0, ...n, 0, ...u, 0, o.x, o.y, o.z, 1]);
    }
  },
  ExternalRenderer: function ExternalRenderer(options) {
    this.render = options.render;
    this.boundingVolume = options.boundingVolume;
    this.show = options.show ?? true;
  }
};

// The guest's frame, from js/ground.js and js/guest.js as they stand (as tests/guest.test.cjs loads it)
class ThreeMatrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  set(...n) {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) this.elements[c * 4 + r] = n[r * 4 + c];
    return this;
  }
}
function loadFrame() {
  const LL = read('js/boroughs.js').match(/function LL\(lon, lat\) \{[^]*?\n\}/)[0];
  const window = { NYC: { THREE: { Matrix4: ThreeMatrix4 }, TSL: {}, Addons: {} } };
  const context = vm.createContext({ window, Math });
  vm.runInContext(`${LL}; window.NYC.lonLatToWorld = LL;`, context);
  vm.runInContext(read('js/ground.js'), context);
  vm.runInContext(read('js/guest.js'), context);
  return window.NYC.makeGeoFrame();
}

const BOX = { min: { x: -2300, y: -12, z: -7200 }, max: { x: 2600, y: 560, z: 6600 } };
const stubGuest = (log) => {
  let bounds = BOX;
  const guest = {
    frame: loadFrame(),
    composite: true,
    logDepth: true,
    bounds: () => bounds,
    setBounds: (b) => { bounds = b; },
    renderer: { getPixelRatio: () => 1, domElement: { width: 480, height: 300 } },
    setSize: (w, h) => log.push(['setSize', w, h]),
    setView: (v) => log.push(['setView', v]),
    setDepth: (d) => { log.push(['setDepth', d && { near: d.near, k: d.oneOverLog2FarDepthFromNearPlusOne }]); return true; },
    setLinearOutput: (l) => { log.push(['linear', l]); return true; },
    setSun: (s) => log.push(['sun', { x: s.x, y: s.y, z: s.z }]),
    update: (dt) => log.push(['update', dt]),
    render: () => log.push(['render'])
  };
  return guest;
};
const pointOf = (m, x, y, z) => Matrix4.multiplyByPoint(m, { x, y, z }, new Cartesian3());

test('the bounding volume is the guest\'s box on the globe: its centre and half axes through the model matrix', () => {
  const guest = stubGuest([]);
  const model = cityModelMatrix(guest, Cesium);
  const box = cityBoundingVolume(guest, Cesium, model);
  assert.ok(box instanceof OrientedBoundingBox);
  const c = pointOf(model, (BOX.min.x + BOX.max.x) / 2, (BOX.min.y + BOX.max.y) / 2, (BOX.min.z + BOX.max.z) / 2);
  assert.ok(Math.hypot(box.center.x - c.x, box.center.y - c.y, box.center.z - c.z) < 1e-6);
  // Each corner of the guest's box is a corner of the oriented box
  const h = box.halfAxes;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const want = pointOf(model, sx < 0 ? BOX.min.x : BOX.max.x, sy < 0 ? BOX.min.y : BOX.max.y, sz < 0 ? BOX.min.z : BOX.max.z);
    const got = [0, 1, 2].map((i) => box.center[['x', 'y', 'z'][i]] + sx * h[i] + sy * h[3 + i] + sz * h[6 + i]);
    assert.ok(Math.hypot(got[0] - want.x, got[1] - want.y, got[2] - want.z) < 1e-6, `corner ${sx} ${sy} ${sz}`);
  }
  // The world frame's up is the ellipsoid's up there: the box's y half axis points away from the Earth's centre
  const up = [h[3], h[4], h[5]];
  const r = [box.center.x, box.center.y, box.center.z];
  const cos = (up[0] * r[0] + up[1] * r[1] + up[2] * r[2]) / Math.hypot(...up) / Math.hypot(...r);
  assert.ok(cos > 0.99, `up · radial ${cos}`);
  // The sphere around it holds the corners: ~7.3 km for the island's 14 km by 5 km
  const s = cityBoundingSphere(guest, Cesium, model);
  assert.ok(s.radius > 7000 && s.radius < 7800, `radius ${s.radius}`);
});

test('the sun comes into the city\'s frame: the zenith is world up, and east is east', () => {
  const guest = stubGuest([]);
  const f = guest.frame;
  const model = cityModelMatrix(guest, Cesium);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(f.lon0, f.lat0));
  const zenith = sunFromCesium(guest, Cesium, { sunDirectionWC: new Cartesian3(enu[8], enu[9], enu[10]) }, model);
  assert.ok(Math.abs(zenith.y - 1) < 1e-6 && Math.hypot(zenith.x, zenith.z) < 1e-3, `zenith ${JSON.stringify(zenith)}`);
  // Grid north is 29° east of true north, so true east is 29° north of grid east: +x, and -z (grid north)
  const east = sunFromCesium(guest, Cesium, { sunDirectionWC: new Cartesian3(enu[0] * 5, enu[1] * 5, enu[2] * 5) }, model);
  assert.ok(Math.abs(Math.hypot(east.x, east.y, east.z) - 1) < 1e-12, 'normalised');
  const angle = (Math.atan2(east.z, east.x) * 180) / Math.PI;
  assert.ok(Math.abs(east.y) < 1e-6 && Math.abs(angle + 29.02) < 0.1, `east at ${angle}°`);
});

test('the screen framebuffer is a function the replay reads, set by the renderer', () => {
  const screen = cesiumScreenFramebuffer();
  assert.equal(screen(), null);
  const fb = {};
  screen.framebuffer = fb;
  assert.equal(screen(), fb);
});

test('the renderer sets the view and the depth per frustum, and the sun and the simulation once a frame', () => {
  const log = [];
  const guest = stubGuest(log);
  const screen = cesiumScreenFramebuffer();
  const fbs = [];
  let ends = 0;
  const link = { frame: (fn) => { fbs.push(screen()); fn(); } };
  const guestCtx = { endFrame: () => { ends++; } };
  assert.throws(() => cesiumExternalRenderer(guest, Cesium, { link, guestCtx }), /options\.screen/);
  const steps = [0.02, 0.03];
  const renderer = cesiumExternalRenderer(guest, Cesium, { link, guestCtx, screen, dt: () => steps.shift() });
  assert.ok(renderer.boundingVolume instanceof OrientedBoundingBox);

  const model = cityModelMatrix(guest, Cesium);
  // A camera 3 km south of the frame's origin and 450 m up, looking north: Cesium's view is its world matrix inverted
  const cameraWorld = Matrix4.multiply(model, Matrix4.fromColumnMajorArray([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 450, 3000, 1]), new Matrix4());
  const viewMatrix = Matrix4.inverse(cameraWorld, new Matrix4());
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(guest.frame.lon0, guest.frame.lat0));
  const base = {
    viewMatrix, projectionMatrix: Matrix4.fromColumnMajorArray([1, 0, 0, 0, 0, 1.6, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0]),
    viewport: { x: 0, y: 0, width: 480, height: 300 }, sunDirectionWC: new Cartesian3(enu[8], enu[9], enu[10]),
    logarithmicDepth: false, highDynamicRange: false, oneOverLog2FarDepthFromNearPlusOne: 0.05
  };
  const fb1 = { id: 1 };
  const fb2 = { id: 2 };
  // Frame 7 in two frustums (far first), frame 8 in one with log depth, in HDR, into another framebuffer
  renderer.render({ ...base, frameNumber: 7, frustumIndex: 1, near: 1000, far: 1e6, framebuffer: fb1 });
  renderer.render({ ...base, frameNumber: 7, frustumIndex: 0, near: 1, far: 1000, framebuffer: fb1 });
  renderer.render({ ...base, frameNumber: 8, frustumIndex: 0, near: 0.1, far: 713851, framebuffer: fb2, logarithmicDepth: true, highDynamicRange: true });

  const of = (name) => log.filter((e) => e[0] === name).map((e) => e[1]);
  assert.deepEqual(of('update'), [0.02, 0.03], 'one step a frame');
  assert.equal(of('sun').length, 2);
  assert.ok(Math.abs(of('sun')[0].y - 1) < 1e-6, 'the sun at the zenith is world up');
  assert.equal(of('render').length, 3);
  assert.equal(ends, 3);
  assert.deepEqual(fbs, [fb1, fb1, fb2], 'the replay draws into each pass\'s framebuffer');
  const views = of('setView');
  assert.deepEqual(views.map((v) => [v.near, v.far]), [[1000, 1e6], [1, 1000], [0.1, 713851]]);
  // The camera in the city's frame: where it was put, in doubles
  const m = views[2].matrixWorld;
  assert.ok(Math.hypot(m[12], m[13] - 450, m[14] - 3000) < 1e-6, `camera at ${m[12]}, ${m[13]}, ${m[14]}`);
  assert.deepEqual(of('setDepth'), [null, null, { near: 0.1, k: 0.05 }]);
  assert.deepEqual(of('linear'), [false, false, true]);
  // Steps come after the view, so the simulation sees this frame's camera
  const firstUpdate = log.findIndex((e) => e[0] === 'update');
  assert.ok(log.findIndex((e) => e[0] === 'setView') < firstUpdate);
  assert.equal(of('setSize').length, 0, 'the pass is the guest\'s size');

  // The ground moves the frame: the bounding volume follows
  const before = { ...renderer.boundingVolume.center };
  guest.frame.height0 = 25;
  guest.setBounds({ min: { ...BOX.min, y: -40 }, max: { ...BOX.max, y: 600 } });
  const after = renderer.boundingVolume.center;
  const up = Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
  // 25 m up for height0, and the box's centre from 274 m to 280 m
  assert.ok(Math.abs(up - 31) < 0.05, `moved ${up} m`);

  // A pass of another size resizes the guest
  renderer.render({ ...base, frameNumber: 9, near: 1, far: 1000, framebuffer: fb1, viewport: { x: 0, y: 0, width: 640, height: 400 } });
  assert.deepEqual(log.filter((e) => e[0] === 'setSize')[0], ['setSize', 640, 400]);
});
