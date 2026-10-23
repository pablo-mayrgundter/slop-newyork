(function () {
// js/guest.js
// Slop New York as a guest: the city drawn into another engine's frame, e.g. as a NetGL guest of a globe (Cesium) at
// Manhattan's place on the Earth. No HUD, no player, no camera rig and no post-processing: the host owns the camera,
// the sun, the canvas and the frame, and calls update() and render() from its own loop. js/guest-entry.mjs loads this
// file and the city scripts into any page; guest.html runs it on a canvas of its own.

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
    worldToEnu,
    worldToLonLat,
    lonLatToWorld
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

  const camera = new THREE.PerspectiveCamera(50, width / height, 0.35, 60000);
  camera.position.set(0, 400, 1200);
  camera.lookAt(0, 0, 0);

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
    const pos = camera.position;
    streetDetails.signalClock.value = elapsed;
    trafficSystem.update(dt, elapsed, pos, null, 'car', camera);
    highwayTraffic.update(dt, camera, null, 'car');
    if (boroughs.update) boroughs.update(elapsed);
    cityBlocks.update(pos.x, pos.z);
    if (cityBlocks.updateLights) cityBlocks.updateLights(camera);
    if (streetDetails.update) streetDetails.update(camera);
    lighting.update(pos);
    updateSceneCulling(pos);
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
    frame: makeGeoFrame(),
    setView,
    setSun: (dir) => lighting.setSunDirection(dir),
    update,
    render,
    setSize,
    compile
  };
}

Object.assign(window.NYC, { createGuest, makeGeoFrame });
})();
