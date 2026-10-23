// js/guest-cesium.mjs
// For a Cesium host of the guest (js/guest.js): the city's ground from the host's terrain, the matrix that places
// the city's world frame on the globe, its bounding volume and sun there, and an ExternalRenderer that draws it inside
// Cesium's frame (scene.externalRenderers, a Cesium with the external render pass). Cesium and portal-netgl are passed
// in (the host's own builds), not imported: these use only a few of their functions, so any recent build serves.
//
//   const height0 = await groundFromCesium(guest, Cesium, viewer.terrainProvider);
//   const modelMatrix = cityModelMatrix(guest, Cesium); // world frame → Earth-fixed (ECEF)
//   scene.externalRenderers.add(cesiumExternalRenderer(guest, Cesium, { link, guestCtx, screen }));

// Mean sea level at Manhattan in heights above the WGS84 ellipsoid: the geoid lies about 32.7 m under the ellipsoid
// there (to within a metre or so; a few decimetres across the island). Ellipsoidal terrain (Cesium World Terrain) has
// its water about here
export const MANHATTAN_SEA_LEVEL = -32.7;

// Samples the host's terrain at the guest's ground grid (guest.groundSamples) and hands the heights to
// guest.setGround. A provider with tile availability (Cesium World Terrain) is sampled at its most detailed tiles;
// one without (a CustomHeightmapTerrainProvider, say) at options.level. options:
//   spacing    metres between the grid's points (default the guest's, 40)
//   level      the tile level to sample a provider without availability at (default 14, ~7 m texels here)
//   seaLevel   the provider's mean sea level, in its datum (default MANHATTAN_SEA_LEVEL; 0 for heights above sea
//              level): the ground holds the city's freeboard over it at the shore and the piers
// Resolves to the ground's height at the frame's tangent point (guest.frame.height0), where the host puts the city.
export async function groundFromCesium(guest, Cesium, terrainProvider, options = {}) {
  const { spacing, level = 14, seaLevel = MANHATTAN_SEA_LEVEL } = options;
  const { lonLat } = guest.groundSamples(spacing);
  const n = lonLat.length / 2;
  const positions = new Array(n);
  for (let i = 0; i < n; i++) positions[i] = Cesium.Cartographic.fromDegrees(lonLat[2 * i], lonLat[2 * i + 1]);
  const sampled = terrainProvider.availability
    ? await Cesium.sampleTerrainMostDetailed(terrainProvider, positions)
    : await Cesium.sampleTerrain(terrainProvider, level, positions);
  // A position whose tile failed keeps an undefined height: setGround fills it from its neighbours
  const heights = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const h = sampled[i].height;
    heights[i] = Number.isFinite(h) ? h : NaN;
  }
  guest.setGround(heights, { seaLevel });
  return guest.frame.height0;
}

// The city's world frame (metres, x = grid east, y = up, z = grid south) in Cesium's Earth-fixed frame: east-north-up
// at the frame's tangent point, at the ground's height there (0 before setGround), times frame.worldToEnu. A
// primitive's modelMatrix, or the inverse taking Cesium's camera into the frame for guest.setView.
export function cityModelMatrix(guest, Cesium, result) {
  const { lon0, lat0, height0 = 0, worldToEnu } = guest.frame;
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(lon0, lat0, height0));
  const toEnu = Cesium.Matrix4.fromColumnMajorArray(worldToEnu.elements);
  return Cesium.Matrix4.multiply(enu, toEnu, result || new Cesium.Matrix4());
}

// The box in the world frame that holds what the guest draws (guest.bounds(): the flat scene's, raised and lowered by
// the ground), on the globe: a Cesium.OrientedBoundingBox, its centre and half axes taken through modelMatrix
// (default cityModelMatrix). ExternalRenderer.boundingVolume takes it, and Cesium's culling and its near / far fit
// work on it as on a sphere, but closer: the island is 14 km long and 5 km wide, and a few hundred metres tall
export function cityBoundingVolume(guest, Cesium, modelMatrix = cityModelMatrix(guest, Cesium), result) {
  const { min, max } = guest.bounds();
  const half = [(max.x - min.x) / 2, (max.y - min.y) / 2, (max.z - min.z) / 2];
  const centre = new Cesium.Cartesian3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
  const m = modelMatrix;
  // Columns: the world frame's axes in ECEF (modelMatrix's columns), each times its half extent
  const halfAxes = Cesium.Matrix3.fromColumnMajorArray([
    m[0] * half[0], m[1] * half[0], m[2] * half[0],
    m[4] * half[1], m[5] * half[1], m[6] * half[1],
    m[8] * half[2], m[9] * half[2], m[10] * half[2]
  ]);
  const box = result || new Cesium.OrientedBoundingBox();
  Cesium.Matrix4.multiplyByPoint(m, centre, box.center);
  Cesium.Matrix3.clone(halfAxes, box.halfAxes);
  return box;
}

// The sphere around cityBoundingVolume's box, for an API that takes only a Cesium.BoundingSphere
export function cityBoundingSphere(guest, Cesium, modelMatrix = cityModelMatrix(guest, Cesium), result) {
  return Cesium.BoundingSphere.fromOrientedBoundingBox(cityBoundingVolume(guest, Cesium, modelMatrix), result);
}

// Cesium's sun (an ExternalRenderer's parameters' sunDirectionWC, or anything with it) in the city's world frame,
// normalised, for guest.setSun: modelMatrix's inverse taken to the direction (modelMatrix default cityModelMatrix)
export function sunFromCesium(guest, Cesium, p, modelMatrix = cityModelMatrix(guest, Cesium), result) {
  const inverse = Cesium.Matrix4.inverse(modelMatrix, new Cesium.Matrix4());
  const sun = Cesium.Matrix4.multiplyByPointAsVector(inverse, p.sunDirectionWC, result || new Cesium.Cartesian3());
  return Cesium.Cartesian3.normalize(sun, sun);
}

// The framebuffer Cesium's pass draws into, for the NetGL replay. A link's replay takes screenFramebuffer, a function,
// when the link is made, before the guest (whose context needs the link's transport) and so before the renderer that
// knows the framebuffer: this is that function, and the renderer sets its framebuffer each frustum.
//
//   const screen = cesiumScreenFramebuffer();
//   const link = makeNetGLImmediateLink({ gl: scene.context._gl, replay: { screenFramebuffer: screen } });
export function cesiumScreenFramebuffer() {
  const screen = () => screen.framebuffer;
  screen.framebuffer = null;
  return screen;
}

// A Cesium.ExternalRenderer that draws the guest inside Cesium's frame, depth-composited with the globe and the
// primitives. The guest is made with composite (and logDepth, for a scene with scene.logarithmicDepthBuffer, Cesium's
// default) and draws through a NetGL guest context (guestCtx) on an immediate link (link) into Cesium's context,
// whose replay's screenFramebuffer is `screen` (cesiumScreenFramebuffer). Per frustum the renderer is called in, it
//   - takes the camera into the city's frame: Cesium's view × cityModelMatrix in doubles, inverted, for setView with
//     the frustum's projection, near and far;
//   - sets logDepth's uniforms (setDepth), or the standard depth when Cesium writes that;
//   - points the replay at the pass's framebuffer, and runs one guest frame on the link.
// Once per Cesium frame (p.frameNumber), on the first frustum it's called in, it sets the sun (options.sun, default
// true) and steps the simulation (guest.update) by options.dt(p) seconds, default the wall clock since the last frame.
// The model matrix and the bounding volume (cityBoundingVolume) follow the ground (guest.setGround) when it changes.
// options: link, guestCtx, screen (required), sun, dt, show. Assumes the pass's viewport starts at the origin (as
// Cesium's does outside VR), and resizes the guest to its size.
export function cesiumExternalRenderer(guest, Cesium, options = {}) {
  const { link, guestCtx, screen, sun = true, dt, show } = options;
  if (!link || !guestCtx || typeof screen !== 'function') {
    throw new Error('cesiumExternalRenderer: options.link, options.guestCtx and options.screen (cesiumScreenFramebuffer) are needed');
  }
  const { Matrix4 } = Cesium;
  let model = null;
  let volume = null;
  let key = null;
  const refresh = () => {
    const b = guest.bounds();
    const k = `${guest.frame.height0}|${b.min.y}|${b.max.y}`;
    if (k === key) return;
    key = k;
    model = cityModelMatrix(guest, Cesium, model || undefined);
    volume = cityBoundingVolume(guest, Cesium, model, volume || undefined);
  };
  refresh();

  const modelView = new Matrix4();
  const cameraWorld = new Matrix4();
  const matrixWorld = new Array(16);
  const projectionMatrix = new Array(16);
  const sunDir = new Cesium.Cartesian3();
  let lastFrame = null;
  let lastTime = null;
  let warned = false;

  const renderer = new Cesium.ExternalRenderer({
    show,
    boundingVolume: volume,
    render(p) {
      refresh();
      // The pass's size
      const ratio = guest.renderer.getPixelRatio ? guest.renderer.getPixelRatio() : 1;
      const canvas = guest.renderer.domElement;
      if (canvas && (canvas.width !== p.viewport.width || canvas.height !== p.viewport.height)) {
        guest.setSize(p.viewport.width / ratio, p.viewport.height / ratio);
      }
      // The camera in the city's frame
      Matrix4.multiply(p.viewMatrix, model, modelView);
      Matrix4.inverse(modelView, cameraWorld);
      guest.setView({
        matrixWorld: Matrix4.toArray(cameraWorld, matrixWorld),
        projectionMatrix: Matrix4.toArray(p.projectionMatrix, projectionMatrix),
        near: p.near,
        far: p.far
      });
      if (p.logarithmicDepth) {
        if (!guest.setDepth(p) && !warned) {
          warned = true;
          console.warn('cesiumExternalRenderer: Cesium writes log depth, and the guest was made without logDepth: it will fail the depth test');
        }
      } else {
        guest.setDepth(null);
      }
      guest.setLinearOutput(!!p.highDynamicRange);
      // Once a frame: the sun and the simulation
      if (p.frameNumber !== lastFrame) {
        lastFrame = p.frameNumber;
        if (sun) guest.setSun(sunFromCesium(guest, Cesium, p, model, sunDir));
        const now = performance.now();
        const step = dt ? dt(p) : lastTime === null ? 1 / 60 : (now - lastTime) / 1000;
        lastTime = now;
        guest.update(step);
      }
      screen.framebuffer = p.framebuffer;
      link.frame(() => {
        guest.render();
        guestCtx.endFrame();
      });
    }
  });
  // Read each frame by Cesium's view: the box as the ground last left it
  Object.defineProperty(renderer, 'boundingVolume', {
    configurable: true,
    enumerable: true,
    get() {
      refresh();
      return volume;
    }
  });
  return renderer;
}
