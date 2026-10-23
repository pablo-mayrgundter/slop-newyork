// js/guest-cesium.mjs
// For a Cesium host of the guest (js/guest.js): the city's ground from the host's terrain, and the matrix that places
// the city's world frame on the globe. Cesium is passed in (the host's own build), not imported: these use only a
// few of its functions, so any recent Cesium serves.
//
//   const height0 = await groundFromCesium(guest, Cesium, viewer.terrainProvider);
//   const modelMatrix = cityModelMatrix(guest, Cesium); // world frame → Earth-fixed (ECEF)

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
