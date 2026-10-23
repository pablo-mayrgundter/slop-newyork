(function () {
// js/guest.js
// Slop New York as a guest: the city drawn into another engine's frame, e.g. as a NetGL guest of a globe (Cesium) at
// Manhattan's place on the Earth. No HUD, no player, no camera rig and no post-processing: the host owns the camera,
// the sun, the canvas and the frame, and calls update() and render() from its own loop. js/guest-entry.mjs loads this
// file and the city scripts into any page; guest.html runs it on a canvas of its own. A host that draws the city into
// its own framebuffer, against its own depth (Cesium's scene.externalRenderers, js/guest-cesium.mjs), creates it with
// composite and logDepth (THE HOST'S FRAME). The frame on the Earth and the ground (the host's heights, the lift, the
// drape) are js/ground.js's, which the app shares for index.html?ground=demo.

const { THREE } = window.NYC;
const { ClusteredLighting } = window.NYC.Addons;
const { LightingSystem, createGroundDrape, prepareMaterials } = window.NYC;
const { buildCityGrid, buildBoroughs, buildLandmarks, buildCityBlocks, buildStreetDetails, buildRoadPaint } = window.NYC;
const { createTrafficSystem, createHighwayTraffic } = window.NYC;
const { setupSceneCulling, updateSceneCulling } = window.NYC;

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
    logDepth: options.logDepth === true,
    lights: options.lights !== false,
    crowds: options.crowds !== false,
    drape: options.drape || null
  };
}

// The renderer for a compositing host: no clears, and output with no render target of its own
function setCompositeOutput(renderer) {
  renderer.autoClear = false;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
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
//   lights            the street, store and car lamps, clustered (default true). false leaves them out, and with them
//                     ClusteredLighting's work each frame (on WebGL2 a transform-feedback pass over every cluster)
//   drape             how finely the ground layers follow the host's ground (js/ground.js THE GROUND, DRAPE_DEFAULTS: { tolerance,
//                     minEdge, maxCells, maxTriangles }; default the street-level detail, unbounded). setGround's
//                     options.drape overrides it for that ground
//   crowds            the pedestrians (default true). They are never drawn on WebGL2 (below); false doesn't build them,
//                     so they don't walk either: no rigs, no skinning each frame, and no one on the crosswalks
// What a guest leaves out is not built: extent 'manhattan' builds no other boroughs (their ~117k buildings, bridges and
// islands), and shadows false no shadow stand-ins (scene-culling.js). guest.stats.build has each step's milliseconds.
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
  if (ClusteredLighting && opts.lights) renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  await renderer.init();

  // The ground (js/ground.js, THE DRAPE) goes in before the city is built: its materials' storeys and kerbs read
  // NYC.groundLift
  const drape = createGroundDrape({ drape: opts.drape });
  const { frame, ground } = drape;

  // The city, built as main.js builds it, less what the options leave out. Each step's time goes in stats.build
  const stats = { build: {} };
  const step = (name, build) => {
    const t0 = performance.now();
    const out = build();
    stats.build[name] = Math.round(performance.now() - t0);
    return out;
  };
  const scene = new THREE.Scene();
  const lighting = step('lighting', () => new LightingSystem(scene, renderer, { sky: false, fog: false }));

  const cityGrid = step('cityGrid', () => buildCityGrid(scene));
  // extent 'manhattan' draws none of the boroughs: not built, rather than built and removed (their buildings, bridges
  // and islands are most of buildBoroughs' time, and its tram's update would keep them all in memory)
  const boroughs = opts.extent === 'all' ? step('boroughs', () => buildBoroughs(scene, { sidewalks: cityGrid.sidewalks })) : null;
  const { colliders: landmarkColliders } = step('landmarks', () => buildLandmarks(scene));
  const cityBlocks = step('cityBlocks', () => buildCityBlocks(scene));
  const allColliders = [...landmarkColliders, ...cityBlocks.colliders, ...(boroughs ? boroughs.colliders : []), ...(cityGrid.colliders || [])];
  const streetDetails = step('streetDetails', () => buildStreetDetails(scene));
  const trafficSystem = step('traffic', () => createTrafficSystem(scene, cityGrid.sidewalks, [
    ...cityGrid.footprints,
    ...streetDetails.footprints,
    ...allColliders.filter((c) => !c.obb)
  ], { pedestrians: opts.crowds }));
  const highwayTraffic = step('highwayTraffic', () => createHighwayTraffic(scene, cityGrid.highwayLanes));
  step('roadPaint', () => buildRoadPaint(scene, trafficSystem.network));
  // The crowds skin each person from a storage buffer read by index, which the WebGL2 backend can't do (it smears them
  // into a sheet): the pedestrians still walk and keep traffic waiting, undrawn
  const crowdMeshes = [];
  scene.traverse((o) => {
    if (o.name === 'PeopleNear' || o.name === 'PeopleFar') crowdMeshes.push(o);
  });
  for (const mesh of crowdMeshes) mesh.removeFromParent();
  // lights: false leaves out the lamps (point and spot lights): unclustered, every material would shade all of them
  if (!opts.lights) {
    const lamps = [];
    scene.traverse((o) => {
      if (o.isPointLight || o.isSpotLight) lamps.push(o);
    });
    for (const lamp of lamps) lamp.removeFromParent();
  }

  // Left out before the culling set-up below, which would otherwise chunk their props and give their buildings shadow
  // stand-ins (at the scene's top level, drawn whatever their group's visibility)
  if (opts.extent !== 'all') {
    for (const name of ['Boroughs', 'HarborWater']) {
      const o = scene.getObjectByName(name);
      if (o) o.removeFromParent();
    }
  }

  // The ground layers, split for the ground in setGround() (js/ground.js, THE GROUND, drapeGroundLayers), their
  // instanced slabs baked before the culling set-up
  step('groundLayers', () => drape.takeLayers(scene));

  const cullingRoots = ['ManhattanCityGrid', 'ManhattanCityBlocks', 'ManhattanStreetDetails', 'ManhattanLandmarks', 'Boroughs']
    .map((name) => scene.getObjectByName(name))
    .filter(Boolean);
  // The shadow stand-ins only the cascades draw: none without shadows
  step('culling', () => setupSceneCulling(scene, cullingRoots, opts.shadows ? lighting.sunLight.shadow : null));
  // Unlike main.js, instance matrices stay instanced vertex attributes: its swap to storage attributes spares WebGPU's
  // uniform buffers, and on the WebGL2 backend instance matrices are vertex attributes already

  // The ground's lift (js/ground.js, THE DRAPE) goes into every material now, before the pipelines compile, and with it,
  // in the same pass, composite's output encoding and logDepth's depth (THE HOST'S FRAME). The guest draws with no MRT,
  // so the materials' own MRT outputs go (prepareMaterials). Then the lamps, which the ground lifts each frame
  const compositeNodes = opts.composite ? makeCompositeNodes() : null;
  const logDepthNodes = opts.logDepth ? makeLogDepthNodes() : null;
  prepareMaterials(scene, {
    lift: drape.liftMaterial,
    output: compositeNodes && compositeNodes.encode,
    setupDepth: logDepthNodes && logDepthNodes.setupDepth
  });
  drape.takeLights(scene);

  // The grid's lon / lat for the host to sample its terrain at (makeGround samples())
  function groundSamples(spacing) {
    return ground.samples(spacing);
  }

  // The host's terrain heights at groundSamples()' points (m above its ellipsoid), and options.seaLevel, its mean sea
  // level there (makeGround set()), and options.drape, the layers' detail (THE GROUND; default the guest's drape). After
  // it, frame.height0 is where the host puts the world frame's origin, and the city stands on the host's ground
  function setGround(heights, options) {
    scene.userData.groundDrape = stats.drape = drape.set(heights, options || {});
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
    if (boroughs && boroughs.update) boroughs.update(elapsed);
    cityBlocks.update(pos.x, pos.z);
    if (cityBlocks.updateLights) cityBlocks.updateLights(simCamera);
    if (streetDetails.update) streetDetails.update(simCamera);
    lighting.update(pos);
    updateSceneCulling(pos);
    drape.liftLights();
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
    const t0 = performance.now();
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
      stats.build.compile = Math.round(performance.now() - t0);
    }
  }

  return {
    renderer,
    scene,
    camera,
    lighting,
    trafficSystem,
    stats,
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

Object.assign(window.NYC, { createGuest, guestOptions, applyView, liftBounds });
})();
