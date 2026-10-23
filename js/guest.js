(function () {
// js/guest.js
// Slop New York as a guest: the city drawn into another engine's frame, e.g. as a NetGL guest of a globe (Cesium) at
// Manhattan's place on the Earth. No HUD, no player, no camera rig and no post-processing: the host owns the camera,
// the sun, the canvas and the frame, and calls update() and render() from its own loop. js/guest-entry.mjs loads this
// file and the city scripts into any page; guest.html runs it on a canvas of its own.

const { THREE } = window.NYC;
const { Fn, texture, uniform, vec3, vec4, dot, positionLocal, modelWorldMatrix, modelWorldMatrixInverse } = window.NYC.TSL;
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
    worldToEnu,
    worldToLonLat,
    lonLatToWorld
  };
}

// =====================================================================================================================
// THE GROUND
// The city is built on a plane (the road deck at y = 0); the real ground under it has hills, and a host's globe curves
// away from the plane (d² / 2R: ~3 m 6 km from 42nd St, ~13 m at the island's tips). The host samples its own terrain
// at the points samples() names (lon / lat on a grid over the island), and set() takes those heights (metres above the
// host's ellipsoid): every vertex is then raised by the ground's height over height0, its height at (LON0, LAT0), less
// the curve. The host puts the world frame's origin at height0. Only the drawing follows the ground: the simulation
// (traffic, colliders, culling) stays on the plane.
// =====================================================================================================================
// The island and its piers, with a margin (world metres)
const GROUND_BOUNDS = { x0: -2700, x1: 2900, z0: -7400, z1: 6800 };

function makeGround(frame, bounds = GROUND_BOUNDS) {
  // The Earth's mean radius of curvature at LAT0 on WGS84 (√(MN)): within ~6 cm of either principal curve at 13 km
  const A = 6378137.0;
  const E2 = 6.69437999014e-3;
  const w = 1 - E2 * Math.sin((LAT0 * Math.PI) / 180) ** 2;
  const radius = Math.sqrt((A / Math.sqrt(w)) * ((A * (1 - E2)) / Math.pow(w, 1.5)));
  const curvature = 1 / (2 * radius);
  const tangent = frame.lonLatToWorld(LON0, LAT0);

  let grid = null; // { x0, z0, dx, dz, cols, rows }
  let offsets = null; // the ground over height0 at each grid point, rows along z
  let height0 = 0;
  let maxOffset = 0;

  const bilinear = (values, x, z) => {
    const fx = Math.min(Math.max((x - grid.x0) / grid.dx, 0), grid.cols - 1);
    const fz = Math.min(Math.max((z - grid.z0) / grid.dz, 0), grid.rows - 1);
    const i = Math.min(Math.floor(fx), grid.cols - 2);
    const j = Math.min(Math.floor(fz), grid.rows - 2);
    const tx = fx - i;
    const tz = fz - j;
    const at = (c, r) => values[r * grid.cols + c];
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
    // The most any vertex moves, for bounding volumes
    get maxOffset() { return maxOffset; },

    // The grid's points as lon / lat pairs (degrees), row by row along z, `spacing` metres apart or a little less
    samples(spacing = 40) {
      const cols = Math.ceil((bounds.x1 - bounds.x0) / spacing) + 1;
      const rows = Math.ceil((bounds.z1 - bounds.z0) / spacing) + 1;
      grid = { x0: bounds.x0, z0: bounds.z0, dx: (bounds.x1 - bounds.x0) / (cols - 1), dz: (bounds.z1 - bounds.z0) / (rows - 1), cols, rows };
      const lonLat = new Float64Array(cols * rows * 2);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const { lon, lat } = frame.worldToLonLat(grid.x0 + c * grid.dx, grid.z0 + r * grid.dz);
          lonLat[(r * cols + c) * 2] = lon;
          lonLat[(r * cols + c) * 2 + 1] = lat;
        }
      }
      offsets = null;
      return { lonLat, cols, rows };
    },

    // Heights (m above the host's ellipsoid) at samples()' points, in its order
    set(heights) {
      if (!grid || heights.length !== grid.cols * grid.rows) throw new Error('setGround: heights must match groundSamples()');
      height0 = bilinear(heights, tangent.x, tangent.z);
      offsets = Float32Array.from(heights, (h) => h - height0);
      maxOffset = 0;
      for (const v of offsets) maxOffset = Math.max(maxOffset, Math.abs(v));
      const corners = [[bounds.x0, bounds.z0], [bounds.x1, bounds.z0], [bounds.x0, bounds.z1], [bounds.x1, bounds.z1]];
      maxOffset += Math.max(...corners.map(([x, z]) => curve(x, z)));
    },

    // How far the ground at world (x, z) lifts what stands there (0 before set())
    offsetAt(x, z) {
      return offsets ? bilinear(offsets, x, z) - curve(x, z) : 0;
    }
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
// =====================================================================================================================
async function createGuest(options = {}) {
  const canvas = options.canvas;
  const width = options.width || (canvas && canvas.width) || 800;
  const height = options.height || (canvas && canvas.height) || 600;

  const renderer = new THREE.WebGPURenderer({
    canvas,
    context: options.context,
    forceWebGL: true,
    antialias: false,
    alpha: true,
    reversedDepthBuffer: false // its EXT_clip_control call bypasses a NetGL recorder (an extension-object method)
  });
  renderer.setPixelRatio(options.pixelRatio || 1);
  renderer.setSize(width, height, false);
  renderer.setClearColor(0x000000, options.clearAlpha ?? 0);
  renderer.shadowMap.enabled = options.shadows !== false;
  if (ClusteredLighting) renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  await renderer.init();

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
  if (options.extent !== 'all') {
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
  // flat and switched off; setGround() then swaps the map and sets the uniforms, which recompiles nothing.
  const frame = makeGeoFrame();
  const ground = makeGround(frame);
  const groundMap = texture(makeOffsetMap(new Float32Array(4), 2, 2));
  const uGroundBox = uniform(new THREE.Vector4(0, 0, 1, 1)); // x0, z0, 1 / (cols dx), 1 / (rows dz)
  const uGroundTexel = uniform(new THREE.Vector2(0.25, 0.25)); // half a texel: grid points sit on texel centres
  const uGroundOn = uniform(0);
  const uCurvature = uniform(0);
  const uTangent = uniform(new THREE.Vector2(ground.tangent.x, ground.tangent.z));
  const groundOffset = Fn(([xz]) => {
    const uv = xz.sub(uGroundBox.xy).mul(uGroundBox.zw).add(uGroundTexel);
    const d = xz.sub(uTangent);
    return groundMap.sample(uv).level(0).r.mul(uGroundOn).sub(dot(d, d).mul(uCurvature));
  });
  // A material's own position (or the vertex's, instanced), raised in world space and taken back to the object's.
  // Sprites are placed by their positionNode (none: the object's origin) and billboarded after it
  const lifted = (material, node) => Fn(() => {
    const p = node ?? (material.isSpriteNodeMaterial ? vec3(0) : positionLocal);
    const xz = modelWorldMatrix.mul(vec4(p, 1.0)).xz;
    return p.add(modelWorldMatrixInverse.mul(vec4(0.0, groundOffset(xz), 0.0, 0.0)).xyz);
  })();
  const liftedMaterials = new Set();
  scene.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      if (!m.isNodeMaterial || liftedMaterials.has(m)) continue;
      liftedMaterials.add(m);
      if (m.castShadowPositionNode) m.castShadowPositionNode = lifted(m, m.castShadowPositionNode);
      m.positionNode = lifted(m, m.positionNode);
    }
  });
  // Lights (street and store lamps, the cars' pools) are placed on the CPU: lifted each frame. One whose y has changed
  // since (a car's lamp, re-placed every frame) is lifted from its new y
  const lights = [];
  scene.traverse((o) => {
    if (o.isLight && !o.isDirectionalLight && !o.isHemisphereLight && !o.isAmbientLight) lights.push(o);
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
  // Bounding spheres, padded by the most anything moves, so frustum culling keeps what the ground raised into view
  const padBounds = (pad) => {
    const padded = new Set();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      if (g && !padded.has(g)) {
        padded.add(g);
        if (!g.boundingSphere) g.computeBoundingSphere();
        g.boundingSphere.radius += pad - (g.userData.groundPad || 0);
        g.userData.groundPad = pad;
      }
      if ((o.isInstancedMesh || o.isBatchedMesh) && o.frustumCulled) {
        if (!o.boundingSphere) o.computeBoundingSphere();
        o.boundingSphere.radius += pad - (o.userData.groundPad || 0);
        o.userData.groundPad = pad;
      }
    });
  };

  // The grid's lon / lat for the host to sample its terrain at (makeGround samples())
  function groundSamples(spacing) {
    return ground.samples(spacing);
  }

  // The host's terrain heights at groundSamples()' points (m above its ellipsoid). After it, frame.height0 is where
  // the host puts the world frame's origin, and the city stands on the host's ground
  function setGround(heights) {
    ground.set(heights);
    const { x0, z0, dx, dz, cols, rows } = ground.grid;
    const old = groundMap.value;
    groundMap.value = makeOffsetMap(ground.offsets, cols, rows);
    old.dispose();
    uGroundBox.value.set(x0, z0, 1 / (cols * dx), 1 / (rows * dz));
    uGroundTexel.value.set(0.5 / cols, 0.5 / rows);
    uGroundOn.value = 1;
    uCurvature.value = ground.curvature;
    frame.height0 = ground.height0;
    padBounds(ground.maxOffset);
  }

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.35, 60000);
  camera.position.set(0, 400, 1200);
  camera.lookAt(0, 0, 0);
  // The camera as the simulation sees it: lowered by the ground under it, onto the plane the city is built on
  const simCamera = new THREE.PerspectiveCamera();

  let elapsed = 0;

  // The host's camera in the world frame: its world matrix and projection (column-major arrays, as three's and
  // Cesium's). fov, aspect, near and far are read back from a symmetric projection, so a later
  // updateProjectionMatrix() (the shadow cascades fit to near / far) reproduces it.
  function setView({ matrixWorld, projectionMatrix }) {
    camera.matrixAutoUpdate = false;
    camera.matrixWorldAutoUpdate = false;
    camera.matrixWorld.fromArray(matrixWorld);
    camera.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    const p = projectionMatrix;
    camera.fov = (2 * Math.atan(1 / p[5]) * 180) / Math.PI;
    camera.aspect = p[5] / p[0];
    camera.near = p[14] / (p[10] - 1);
    camera.far = p[14] / (p[10] + 1);
    camera.projectionMatrix.fromArray(p);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
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
    setView,
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

Object.assign(window.NYC, { createGuest, makeGeoFrame, makeGround });
})();
