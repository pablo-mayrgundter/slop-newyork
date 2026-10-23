(function () {
// js/guest.js
// Slop New York as a guest: the city drawn into another engine's frame, e.g. as a NetGL guest of a globe (Cesium) at
// Manhattan's place on the Earth. No HUD, no player, no camera rig and no post-processing: the host owns the camera,
// the sun, the canvas and the frame, and calls update() and render() from its own loop. js/guest-entry.mjs loads this
// file and the city scripts into any page; guest.html runs it on a canvas of its own. A host that draws the city into
// its own framebuffer, against its own depth (Cesium's scene.externalRenderers, js/guest-cesium.mjs), creates it with
// composite and logDepth (THE HOST'S FRAME).

const { THREE } = window.NYC;
const { ClusteredLighting } = window.NYC.Addons;
const { LightingSystem, lonLatToWorld } = window.NYC;
const { buildCityGrid, buildBoroughs, buildLandmarks, buildCityBlocks, buildStreetDetails, buildRoadPaint } = window.NYC;
const { createTrafficSystem, createHighwayTraffic } = window.NYC;
const { setupSceneCulling, updateSceneCulling } = window.NYC;

// =====================================================================================================================
// THE FRAME ON THE EARTH
// The world frame (x = grid east, y = up, z = grid south, metres) is an affine image of the local tangent plane at
// (LON0, LAT0) on WGS84, turned with the street grid (tools/geo-base.mjs); lonLatToWorld (boroughs.js) is that map.
// worldToEnu takes world points to east, north, up metres about (LON0, LAT0), up from the road deck (y = 0), so a host
// places the city with its own east-north-up frame there (Cesium: Transforms.eastNorthUpToFixedFrame) times this.
// =====================================================================================================================
const LON0 = -73.98185;
const LAT0 = 40.75318;
const WATER_Y = -2.2; // the harbour's surface in the world frame (boroughs.js): mean sea level, for the host's datum

function makeGeoFrame() {
  // Metres per degree of longitude and latitude at LAT0 on WGS84 (as geo-base.mjs KX, KY)
  const A = 6378137.0;
  const E2 = 6.69437999014e-3;
  const phi = (LAT0 * Math.PI) / 180;
  const w = 1 - E2 * Math.sin(phi) ** 2;
  const kx = (Math.PI / 180) * (A / Math.sqrt(w)) * Math.cos(phi);
  const ky = (Math.PI / 180) * ((A * (1 - E2)) / Math.pow(w, 1.5));

  // world (x, z) = o + M (dLon, dLat): lonLatToWorld is linear, so one step along each axis gives M exactly
  const step = 1e-3;
  const o = lonLatToWorld(LON0, LAT0);
  const pl = lonLatToWorld(LON0 + step, LAT0);
  const pp = lonLatToWorld(LON0, LAT0 + step);
  const m11 = (pl.x - o.x) / step;
  const m21 = (pl.z - o.z) / step;
  const m12 = (pp.x - o.x) / step;
  const m22 = (pp.z - o.z) / step;
  const det = m11 * m22 - m12 * m21;

  const worldToLonLat = (x, z) => {
    const dx = x - o.x;
    const dz = z - o.z;
    return { lon: LON0 + (m22 * dx - m12 * dz) / det, lat: LAT0 + (m11 * dz - m21 * dx) / det };
  };
  // East and north metres per world x and per world z: (dLon, dLat) = M^-1 (world - o), scaled by kx, ky
  const ex = (kx * m22) / det;
  const ez = (-kx * m12) / det;
  const nx = (-ky * m21) / det;
  const nz = (ky * m11) / det;
  const worldToEnu = new THREE.Matrix4().set(
    ex, 0, ez, -(ex * o.x + ez * o.z),
    nx, 0, nz, -(nx * o.x + nz * o.z),
    0, 1, 0, 0,
    0, 0, 0, 1
  );
  return {
    lon0: LON0,
    lat0: LAT0,
    origin: worldToLonLat(0, 0), // 5th Ave & 42nd St
    waterY: WATER_Y,
    height0: 0, // the ground's height at (lon0, lat0) once the host has set it (createGuest setGround)
    worldToEnu,
    worldToLonLat,
    lonLatToWorld
  };
}

// =====================================================================================================================
// THE GROUND
// The city is built on a plane (the road deck at y = 0); the real ground under it has hills, and a host's globe curves
// away from the plane by d² / 2R (~4 m at the drawn island's ends, 7.1 km north and 6.5 km south of 42nd St). The host
// samples its own terrain at the points samples() names (lon / lat on a grid over the island) and set() takes those
// heights (metres above the host's ellipsoid, or any datum): every vertex is then raised by the ground's height over
// height0, its height at (LON0, LAT0), less the curve, and the host puts the world frame's origin at height0. Only the
// drawing follows the ground: the simulation (traffic, colliders, culling) and the shading's storeys, kerbs and
// waterlines (NYC.deckPosition, tsl-materials.js) stay on the plane. Outside the bounds the ground holds its edge.
// =====================================================================================================================
// The island and its piers as the guest draws them (extent 'manhattan': x -2256..2575, z -7111..6518), with a margin
const GROUND_BOUNDS = { x0: -2700, x1: 2900, z0: -7400, z1: 6800 };

function makeGround(frame, bounds = GROUND_BOUNDS) {
  // The Earth's mean radius of curvature at LAT0 on WGS84 (√(MN)): its d² / 2R is within 0.4% (~2 cm at 7 km) of the
  // drop along either principal direction
  const A = 6378137.0;
  const E2 = 6.69437999014e-3;
  const w = 1 - E2 * Math.sin((LAT0 * Math.PI) / 180) ** 2;
  const radius = Math.sqrt((A / Math.sqrt(w)) * ((A * (1 - E2)) / Math.pow(w, 1.5)));
  const curvature = 1 / (2 * radius);
  const tangent = frame.lonLatToWorld(LON0, LAT0);

  let pending = null; // the grid samples() last named: { x0, z0, dx, dz, cols, rows }
  let grid = null; // the grid of the heights set() took
  let offsets = null; // the ground over height0 at each of its points, rows along z
  let height0 = 0;
  let range = { min: 0, max: 0 }; // of the offsets

  const bilinear = (g, values, x, z) => {
    const fx = Math.min(Math.max((x - g.x0) / g.dx, 0), g.cols - 1);
    const fz = Math.min(Math.max((z - g.z0) / g.dz, 0), g.rows - 1);
    const i = Math.min(Math.floor(fx), g.cols - 2);
    const j = Math.min(Math.floor(fz), g.rows - 2);
    const tx = fx - i;
    const tz = fz - j;
    const at = (c, r) => values[r * g.cols + c];
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * tx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
    return a + (b - a) * tz;
  };
  const curve = (x, z) => ((x - tangent.x) ** 2 + (z - tangent.z) ** 2) * curvature;

  return {
    bounds,
    curvature,
    tangent,
    get grid() { return grid; },
    get offsets() { return offsets; },
    get height0() { return height0; },
    get on() { return offsets !== null; },
    // The least and most of the offsets (the curve aside)
    get range() { return range; },

    // The grid's points as lon / lat pairs (degrees), row by row along z, `spacing` metres apart or a little less.
    // The ground in place stays until set() takes heights for these
    samples(spacing = 40) {
      if (!(spacing > 0)) throw new Error('groundSamples: spacing must be positive');
      const cols = Math.ceil((bounds.x1 - bounds.x0) / spacing) + 1;
      const rows = Math.ceil((bounds.z1 - bounds.z0) / spacing) + 1;
      const g = { x0: bounds.x0, z0: bounds.z0, dx: (bounds.x1 - bounds.x0) / (cols - 1), dz: (bounds.z1 - bounds.z0) / (rows - 1), cols, rows };
      const lonLat = new Float64Array(cols * rows * 2);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const { lon, lat } = frame.worldToLonLat(g.x0 + c * g.dx, g.z0 + r * g.dz);
          lonLat[(r * cols + c) * 2] = lon;
          lonLat[(r * cols + c) * 2 + 1] = lat;
        }
      }
      pending = g;
      return { lonLat, cols, rows };
    },

    // Heights (m above the host's ellipsoid) at samples()' points, in its order. A height that isn't a finite number
    // (a tile the host couldn't load) takes its neighbours'. seaLevel, the host's mean sea level in the same datum,
    // keeps the ground from sinking below the city's own freeboard over its water (the deck stands 2.2 m over the
    // harbour): a host's terrain over water is its sea surface or the river bed, where the piers and the shore stand
    set(heights, { seaLevel } = {}) {
      const g = pending;
      if (!g || !heights || heights.length !== g.cols * g.rows) throw new Error('setGround: heights must match groundSamples()');
      const h = Float64Array.from(heights, (v) => (v === null ? NaN : v));
      if (seaLevel !== undefined) {
        const floor = seaLevel - WATER_Y;
        for (let i = 0; i < h.length; i++) if (h[i] < floor) h[i] = floor;
      }
      fillHoles(h, g.cols, g.rows);
      grid = g;
      height0 = bilinear(g, h, tangent.x, tangent.z);
      offsets = Float32Array.from(h, (v) => v - height0);
      let min = Infinity;
      let max = -Infinity;
      for (const v of offsets) {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      range = { min, max };
    },

    // How far the ground at world (x, z) lifts what stands there (0 before set())
    offsetAt(x, z) {
      return offsets ? bilinear(grid, offsets, x, z) - curve(x, z) : 0;
    },

    // The least and most the ground lifts anything in the world box x0..x1, z0..z1 (0 and 0 before set()), the curve
    // included: for the host's bounding volume of what the guest draws
    liftRange(x0, x1, z0, z1) {
      if (!offsets) return { min: 0, max: 0 };
      const dx = Math.max(Math.abs(x0 - tangent.x), Math.abs(x1 - tangent.x));
      const dz = Math.max(Math.abs(z0 - tangent.z), Math.abs(z1 - tangent.z));
      const nx = tangent.x < x0 ? x0 - tangent.x : tangent.x > x1 ? tangent.x - x1 : 0;
      const nz = tangent.z < z0 ? z0 - tangent.z : tangent.z > z1 ? tangent.z - z1 : 0;
      return { min: range.min - (dx * dx + dz * dz) * curvature, max: range.max - (nx * nx + nz * nz) * curvature };
    },

    // The most anything within `reach` metres of world (x, z) is lifted or lowered, either way (for bounding volumes)
    maxLiftNear(x, z, reach) {
      if (!offsets) return 0;
      const d = Math.hypot(x - tangent.x, z - tangent.z) + reach;
      return Math.max(Math.abs(range.max), Math.abs(range.min - d * d * curvature));
    }
  };
}

// Fills each non-finite height from its finite neighbours, pass by pass inward from them
function fillHoles(h, cols, rows) {
  let holes = 0;
  for (const v of h) if (!Number.isFinite(v)) holes++;
  if (holes === h.length) throw new Error('setGround: no finite heights');
  while (holes > 0) {
    const fills = [];
    for (let i = 0; i < h.length; i++) {
      if (Number.isFinite(h[i])) continue;
      const c = i % cols;
      const r = (i - c) / cols;
      let sum = 0;
      let n = 0;
      for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || cc >= cols || rr < 0 || rr >= rows) continue;
        const v = h[rr * cols + cc];
        if (Number.isFinite(v)) {
          sum += v;
          n++;
        }
      }
      if (n) fills.push([i, sum / n]);
    }
    for (const [i, v] of fills) h[i] = v;
    holes -= fills.length;
  }
}

// The ground's nodes, made once per page (TSL is only there in a browser) and shared by its guests: a vertex's lift is a
// function of where it stands, the same for every guest of the same host. NYC.groundLift, the lift as a varying, is
// what NYC.deckPosition (tsl-materials.js) takes off positionWorld to keep the shading's storeys on the road deck.
let groundNodes = null;
function getGroundNodes(tangent) {
  if (groundNodes) return groundNodes;
  const { Fn, texture, uniform, vec3, vec4, dot, positionLocal, modelWorldMatrix, modelWorldMatrixInverse } = window.NYC.TSL;
  const map = texture(makeOffsetMap(new Float32Array(4), 2, 2));
  const box = uniform(new THREE.Vector4(0, 0, 1, 1)); // x0, z0, 1 / (cols dx), 1 / (rows dz)
  const texel = uniform(new THREE.Vector2(0.25, 0.25)); // half a texel: grid points sit on texel centres
  const on = uniform(0);
  const curvature = uniform(0);
  const centre = uniform(new THREE.Vector2(tangent.x, tangent.z));
  // offsetAt() on the GPU: the map's offset at world (x, z), less the curve
  const offset = Fn(([xz]) => {
    const uv = xz.sub(box.xy).mul(box.zw).add(texel);
    const d = xz.sub(centre);
    return map.sample(uv).level(0).r.mul(on).sub(dot(d, d).mul(curvature));
  });
  // A material's own position (or the vertex's, instanced), raised in world space and taken back to the object's.
  // Sprites are placed by their positionNode (none: the object's origin) and billboarded after it
  const lift = (material, node) => Fn(() => {
    const p = node ?? (material.isSpriteNodeMaterial ? vec3(0) : positionLocal);
    const xz = modelWorldMatrix.mul(vec4(p, 1.0)).xz;
    return p.add(modelWorldMatrixInverse.mul(vec4(0.0, offset(xz), 0.0, 0.0)).xyz);
  })();
  // The lift at the vertex as it is drawn (the lift moves it straight up, so its x, z are those it was lifted at)
  const varyingLift = offset(modelWorldMatrix.mul(vec4(positionLocal, 1.0)).xz).toVarying('vGroundLift');
  groundNodes = { map, box, texel, on, curvature, lift };
  window.NYC.groundLift = varyingLift;
  return groundNodes;
}

// =====================================================================================================================
// THE HOST'S FRAME
// A host that composites the guest into its own frame (Cesium's scene.externalRenderers calls a renderer inside its
// render pass, with the pass's framebuffer bound and its opaque geometry's depth in it) needs the guest to draw straight
// into that framebuffer and to depth-test against what is there:
//   composite   no clears, and no output render target. With outputColorSpace sRGB or a tone mapping, WebGPURenderer
//               draws into a target of its own and copies it over the whole screen with no depth, which wipes the
//               host's frame. So the renderer outputs in the working (linear) space with no tone mapping, and each
//               material encodes sRGB itself through its outputNode (or not, setLinearOutput(true), for a host that
//               renders in linear HDR and tone maps later)
//   logDepth    the depth the host writes: Cesium's logarithmic depth, log2(w - near + 1) / log2(far - near + 1), w the
//               fragment's distance along the view direction, from uniforms the host sets per frustum (setDepth).
//               With setDepth(null) the materials write the standard depth of the camera's near and far. It goes in
//               through each material's setupDepth, not its depthNode: a shadow pass takes the material's depthNode
//               for its own (three's _getShadowNodes), and the shadow maps must keep the light camera's depth
// Both go in with the ground's lift, in the one pass over the scene's materials before the pipelines compile.
// =====================================================================================================================
// The options with their defaults (THE GUEST, below)
function guestOptions(options = {}) {
  return {
    extent: options.extent === 'all' ? 'all' : 'manhattan',
    shadows: options.shadows !== false,
    clearAlpha: options.clearAlpha ?? 0,
    pixelRatio: options.pixelRatio || 1,
    composite: options.composite === true,
    logDepth: options.logDepth === true
  };
}

// The renderer for a compositing host: no clears, and output with no render target of its own
function setCompositeOutput(renderer) {
  renderer.autoClear = false;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
}

// Each node material in the scene, once: the ground's lift (lift(material), for those that don't place their own
// vertices), the output encoding (output(outputNode) → outputNode) and the depth (setupDepth, the material's method).
// A material's program then differs from one with the same nodes without these, so its cache key says which it has.
// Returns how many materials it saw
function prepareMaterials(scene, { lift = null, output = null, setupDepth = null } = {}) {
  const seen = new Set();
  scene.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      if (!m || !m.isNodeMaterial || seen.has(m)) continue;
      seen.add(m);
      const tags = [];
      if (lift && !m.vertexNode) {
        lift(m);
        tags.push('ground');
      }
      if (output) {
        m.outputNode = output(m.outputNode);
        tags.push('composite');
      }
      if (setupDepth) {
        m.setupDepth = setupDepth;
        tags.push('logdepth');
      }
      if (!tags.length) continue;
      const key = m.customProgramCacheKey;
      const suffix = tags.join(':');
      m.customProgramCacheKey = function () {
        return `${key.call(this)}:${suffix}`;
      };
    }
  });
  return seen.size;
}

// The outputNode for composite: sRGB encoded (or linear while `linear` is 1), with no tone mapping
function makeCompositeNodes() {
  const { uniform, output, renderOutput, mix } = window.NYC.TSL;
  const linear = uniform(0);
  const encode = (node) => {
    const color = node || output;
    return mix(renderOutput(color, THREE.NoToneMapping, THREE.SRGBColorSpace), color, linear);
  };
  return { linear, encode };
}

// The setupDepth for logDepth: the host's log depth while `on` is 1, else the standard depth of the camera's near / far
function makeLogDepthNodes() {
  const { uniform, positionView, log2, max, float, mix, depth, viewZToPerspectiveDepth, cameraNear, cameraFar } = window.NYC.TSL;
  const on = uniform(0);
  const near = uniform(1);
  const oneOverLog2 = uniform(1); // 1 / log2(far - near + 1)
  const w = positionView.z.negate();
  const logDepth = log2(max(w.sub(near).add(1.0), float(1.0))).mul(oneOverLog2);
  const standard = viewZToPerspectiveDepth(positionView.z, cameraNear, cameraFar);
  const node = mix(standard, logDepth, on);
  const setupDepth = function () {
    depth.assign(node).toStack();
  };
  return { on, near, oneOverLog2, setupDepth };
}

// The host's camera on the guest's: its world matrix and projection (column-major arrays, as three's and Cesium's),
// and the projection's near and far. fov and aspect are read back from a symmetric projection, so a later
// updateProjectionMatrix() (the shadow cascades fit to near / far) reproduces it; near and far too when they're not
// given, though from p[10] and p[14] they're ill-conditioned once far / near is large (Cesium's log depth: ~1e7)
function applyView(camera, { matrixWorld, projectionMatrix, near, far }) {
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;
  camera.matrixWorld.fromArray(matrixWorld);
  camera.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  const p = projectionMatrix;
  camera.fov = (2 * Math.atan(1 / p[5]) * 180) / Math.PI;
  camera.aspect = p[5] / p[0];
  camera.near = Number.isFinite(near) ? near : p[14] / (p[10] - 1);
  camera.far = Number.isFinite(far) ? far : p[14] / (p[10] + 1);
  camera.projectionMatrix.fromArray(p);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

// What the guest draws in the world frame ({ min, max } of a box, `box` from the flat scene), raised and lowered by
// the ground and padded by `pad` metres: what a host bounds the guest with
function liftBounds(box, ground, pad = 10) {
  const { min, max } = box;
  const lift = ground.liftRange(min.x, max.x, min.z, max.z);
  return {
    min: { x: min.x - pad, y: min.y + Math.min(0, lift.min) - pad, z: min.z - pad },
    max: { x: max.x + pad, y: max.y + Math.max(0, lift.max) + pad, z: max.z + pad }
  };
}

// =====================================================================================================================
// THE GUEST
// options:
//   canvas, context   the canvas and WebGL2 context to draw with (a NetGL recorder context, say); omitted, a canvas of
//                     its own. Always the WebGL2 backend: NetGL records WebGL2.
//   width, height     drawing-buffer size in CSS pixels (default the canvas's), pixelRatio (default 1)
//   extent            'manhattan' (default) leaves out the other boroughs, New Jersey and the harbour's water plane, for
//                     a host that draws the ground and water around the island; 'all' keeps the whole 1:1 region
//   shadows           sun shadow cascades (default true)
//   clearAlpha        the alpha of the guest's clears (default 0: transparent where it draws nothing)
//   composite         for a host that draws the guest into its own framebuffer (default false): no clears, no output
//                     render target, no tone mapping, each material encoding sRGB (THE HOST'S FRAME)
//   logDepth          write the host's logarithmic depth, from setDepth() (default false; THE HOST'S FRAME)
// =====================================================================================================================
async function createGuest(options = {}) {
  const canvas = options.canvas;
  const width = options.width || (canvas && canvas.width) || 800;
  const height = options.height || (canvas && canvas.height) || 600;
  const opts = guestOptions(options);

  const renderer = new THREE.WebGPURenderer({
    canvas,
    context: options.context,
    forceWebGL: true,
    antialias: false,
    alpha: true,
    reversedDepthBuffer: false // its EXT_clip_control call bypasses a NetGL recorder (an extension-object method)
  });
  renderer.setPixelRatio(opts.pixelRatio);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, opts.clearAlpha);
  renderer.shadowMap.enabled = opts.shadows;
  if (opts.composite) setCompositeOutput(renderer);
  if (ClusteredLighting) renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  await renderer.init();

  // The ground's nodes go in before the city is built: its materials' storeys and kerbs read NYC.groundLift
  const frame = makeGeoFrame();
  const ground = makeGround(frame);
  const groundNodes = getGroundNodes(ground.tangent);

  const scene = new THREE.Scene();
  const lighting = new LightingSystem(scene, renderer, { sky: false, fog: false });

  // The city, built as main.js builds it
  const cityGrid = buildCityGrid(scene);
  const boroughs = buildBoroughs(scene, { sidewalks: cityGrid.sidewalks });
  const { colliders: landmarkColliders } = buildLandmarks(scene);
  const cityBlocks = buildCityBlocks(scene);
  const allColliders = [...landmarkColliders, ...cityBlocks.colliders, ...boroughs.colliders, ...(cityGrid.colliders || [])];
  const streetDetails = buildStreetDetails(scene);
  const trafficSystem = createTrafficSystem(scene, cityGrid.sidewalks, [
    ...cityGrid.footprints,
    ...streetDetails.footprints,
    ...allColliders.filter((c) => !c.obb)
  ]);
  const highwayTraffic = createHighwayTraffic(scene, cityGrid.highwayLanes);
  buildRoadPaint(scene, trafficSystem.network);
  // The crowds skin each person from a storage buffer read by index, which the WebGL2 backend can't do (it smears them
  // into a sheet): the pedestrians still walk and keep traffic waiting, undrawn
  const crowdMeshes = [];
  scene.traverse((o) => {
    if (o.name === 'PeopleNear' || o.name === 'PeopleFar') crowdMeshes.push(o);
  });
  for (const mesh of crowdMeshes) mesh.removeFromParent();

  // Left out before the culling set-up below, which would otherwise chunk their props and give their buildings shadow
  // stand-ins (at the scene's top level, drawn whatever their group's visibility)
  if (opts.extent !== 'all') {
    for (const name of ['Boroughs', 'HarborWater']) {
      const o = scene.getObjectByName(name);
      if (o) o.removeFromParent();
    }
  }

  const cullingRoots = ['ManhattanCityGrid', 'ManhattanCityBlocks', 'ManhattanStreetDetails', 'ManhattanLandmarks', 'Boroughs']
    .map((name) => scene.getObjectByName(name))
    .filter(Boolean);
  setupSceneCulling(scene, cullingRoots, lighting.sunLight.shadow);
  // Unlike main.js, instance matrices stay instanced vertex attributes: its swap to storage attributes spares WebGPU's
  // uniform buffers, and on the WebGL2 backend instance matrices are vertex attributes already

  // The ground (THE GROUND, above): every material's vertex stage adds offsetAt() at the vertex's world (x, z), read
  // from a half-float map of the offsets, less the curve. It goes in now, before the pipelines compile, with the map
  // flat and switched off; setGround() then swaps the map and sets the uniforms, which recompiles nothing. With it, in
  // the same pass, composite's output encoding and logDepth's depth (THE HOST'S FRAME)
  const compositeNodes = opts.composite ? makeCompositeNodes() : null;
  const logDepthNodes = opts.logDepth ? makeLogDepthNodes() : null;
  prepareMaterials(scene, {
    lift: (m) => {
      if (m.castShadowPositionNode) m.castShadowPositionNode = groundNodes.lift(m, m.castShadowPositionNode);
      m.positionNode = groundNodes.lift(m, m.positionNode);
    },
    output: compositeNodes && compositeNodes.encode,
    setupDepth: logDepthNodes && logDepthNodes.setupDepth
  });
  // Lamps (street and store lights, the cars' pools) are placed on the CPU: lifted each frame. One whose y has changed
  // since (a car's lamp, re-placed every frame) is lifted from its new y. Only point and spot lights: the sun (a
  // SunLight, not a DirectionalLight) is placed by its direction, which a lift would tip under the horizon
  const lights = [];
  scene.traverse((o) => {
    if (o.isPointLight || o.isSpotLight) lights.push(o);
  });
  const _p = new THREE.Vector3();
  const liftY = (o) => {
    const u = o.userData;
    if (u.groundY === undefined || o.position.y !== u.groundY) u.groundBaseY = o.position.y;
    _p.copy(o.position);
    if (o.parent) o.parent.localToWorld(_p);
    o.position.y = u.groundBaseY + ground.offsetAt(_p.x, _p.z);
    u.groundY = o.position.y;
  };
  // Bounding spheres (a geometry's, or an instanced mesh's own), padded by the most the ground moves anything in them,
  // so frustum culling keeps what it raised into view. A geometry shared by several meshes takes the largest pad
  const _sphere = new THREE.Sphere();
  const padBounds = () => {
    scene.updateMatrixWorld();
    const pads = new Map();
    scene.traverse((o) => {
      if (!o.isMesh || !o.frustumCulled) return;
      const target = o.isInstancedMesh || o.isBatchedMesh ? o : o.geometry;
      if (!target) return;
      if (!target.boundingSphere) target.computeBoundingSphere();
      _sphere.copy(target.boundingSphere);
      _sphere.radius -= target.userData.groundPad || 0;
      _sphere.applyMatrix4(o.matrixWorld);
      const scale = o.matrixWorld.getMaxScaleOnAxis() || 1;
      const pad = ground.maxLiftNear(_sphere.center.x, _sphere.center.z, _sphere.radius) / scale;
      pads.set(target, Math.max(pads.get(target) || 0, pad));
    });
    for (const [target, pad] of pads) {
      target.boundingSphere.radius += pad - (target.userData.groundPad || 0);
      target.userData.groundPad = pad;
    }
  };

  // The grid's lon / lat for the host to sample its terrain at (makeGround samples())
  function groundSamples(spacing) {
    return ground.samples(spacing);
  }

  // The host's terrain heights at groundSamples()' points (m above its ellipsoid), and options.seaLevel, its mean sea
  // level there (makeGround set()). After it, frame.height0 is where the host puts the world frame's origin, and the
  // city stands on the host's ground
  function setGround(heights, options) {
    ground.set(heights, options);
    const { x0, z0, dx, dz, cols, rows } = ground.grid;
    const old = groundNodes.map.value;
    groundNodes.map.value = makeOffsetMap(ground.offsets, cols, rows);
    old.dispose();
    groundNodes.box.value.set(x0, z0, 1 / (cols * dx), 1 / (rows * dz));
    groundNodes.texel.value.set(0.5 / cols, 0.5 / rows);
    groundNodes.on.value = 1;
    groundNodes.curvature.value = ground.curvature;
    frame.height0 = ground.height0;
    padBounds();
  }

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.35, 60000);
  camera.position.set(0, 400, 1200);
  camera.lookAt(0, 0, 0);
  // The camera as the simulation sees it: lowered by the ground under it, onto the plane the city is built on
  const simCamera = new THREE.PerspectiveCamera();

  let elapsed = 0;

  // The host's camera in the world frame (applyView, THE HOST'S FRAME): { matrixWorld, projectionMatrix }, column-major,
  // and optionally near and far, which a host with them in hand (Cesium's frustum) should pass
  function setView(view) {
    applyView(camera, view);
  }

  // logDepth's uniforms for this frustum: { near, oneOverLog2FarDepthFromNearPlusOne } (Cesium's names, its
  // ExternalRenderer parameters), or null for the standard depth. False if the guest wasn't made with logDepth
  function setDepth(params) {
    if (!logDepthNodes) return false;
    if (params) {
      logDepthNodes.near.value = params.near;
      logDepthNodes.oneOverLog2.value = params.oneOverLog2FarDepthFromNearPlusOne;
      logDepthNodes.on.value = 1;
    } else {
      logDepthNodes.on.value = 0;
    }
    return true;
  }

  // composite: true for linear output (a host rendering in HDR, tone mapping later), false for sRGB (the default).
  // False if the guest wasn't made with composite
  function setLinearOutput(linear) {
    if (!compositeNodes) return false;
    compositeNodes.linear.value = linear ? 1 : 0;
    return true;
  }

  // What the guest draws, in the world frame: the flat scene's box (taken once), raised and lowered by the ground
  let flatBox = null;
  function bounds() {
    if (!flatBox) {
      scene.updateMatrixWorld();
      flatBox = new THREE.Box3().setFromObject(scene);
    }
    return liftBounds(flatBox, ground);
  }

  // One simulation step (seconds): signals, traffic, pedestrians, the tram, building LODs, prop culling, shadow reach
  function update(dt) {
    dt = Math.min(Math.max(dt, 0.001), 0.05);
    elapsed += dt;
    camera.updateMatrixWorld();
    simCamera.copy(camera);
    simCamera.matrixAutoUpdate = false; // copy() takes the camera's
    simCamera.matrixWorldAutoUpdate = false;
    simCamera.position.y -= ground.offsetAt(camera.position.x, camera.position.z);
    simCamera.matrixWorld.compose(simCamera.position, simCamera.quaternion, simCamera.scale);
    simCamera.matrixWorldInverse.copy(simCamera.matrixWorld).invert();
    const pos = simCamera.position;
    streetDetails.signalClock.value = elapsed;
    trafficSystem.update(dt, elapsed, pos, null, 'car', simCamera);
    highwayTraffic.update(dt, simCamera, null, 'car');
    if (boroughs.update) boroughs.update(elapsed);
    cityBlocks.update(pos.x, pos.z);
    if (cityBlocks.updateLights) cityBlocks.updateLights(simCamera);
    if (streetDetails.update) streetDetails.update(simCamera);
    lighting.update(pos);
    updateSceneCulling(pos);
    if (ground.on) {
      for (const light of lights) {
        liftY(light);
        if (light.target) liftY(light.target);
      }
    }
  }

  function render() {
    renderer.render(scene, camera);
  }

  function setSize(w, h) {
    renderer.setSize(w, h, false);
    if (camera.matrixAutoUpdate) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }

  // Compile every material's pipelines now rather than on the frames that first meet them (frustum culling off, as
  // main.js's warm-up frame)
  async function compile() {
    const culled = [];
    scene.traverse((o) => {
      if (o.frustumCulled) {
        culled.push(o);
        o.frustumCulled = false;
      }
    });
    try {
      await renderer.compileAsync(scene, camera);
    } finally {
      for (const o of culled) o.frustumCulled = true;
    }
  }

  return {
    renderer,
    scene,
    camera,
    lighting,
    trafficSystem,
    frame,
    groundSamples,
    setGround,
    groundOffsetAt: (x, z) => ground.offsetAt(x, z),
    composite: opts.composite,
    logDepth: opts.logDepth,
    setView,
    setDepth,
    setLinearOutput,
    bounds,
    // The direction to the sun in the world frame, y up: any { x, y, z } (a THREE.Vector3, a Cesium Cartesian3)
    setSun: (dir) => lighting.setSunDirection(dir),
    update,
    render,
    setSize,
    compile
  };
}

// The ground's offsets as a linearly filtered half-float map (core in WebGL2, where float32 filtering is an extension)
function makeOffsetMap(values, cols, rows) {
  const data = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) data[i] = THREE.DataUtils.toHalfFloat(values[i]);
  const map = new THREE.DataTexture(data, cols, rows, THREE.RedFormat, THREE.HalfFloatType);
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  return map;
}

Object.assign(window.NYC, { createGuest, makeGeoFrame, makeGround, guestOptions, prepareMaterials, applyView, liftBounds });
})();
