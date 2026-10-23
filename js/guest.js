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

// The lift moves vertices, and a flat triangle stays flat between them: a layer built from a few long triangles (the
// road deck is the island's outline cut into ~700 triangles kilometres long; the seawall's top and the lawns are alike)
// cuts straight through a hill, metres under or over the finely built layers on it (the sidewalks, the paint, the
// paths), which the ground carries on the hill itself. Under guest.html's demo hill the deck ran up to 29 m below the
// ground and Central Park's lawn 14 m above it, crossing the layers a few centimetres over them in long bands of
// z-fighting. So once the ground is set, the ground layers' triangles split where the ground bends away from them:
// along their longest edge, until the ground is within DRAPE_TOLERANCE of each triangle at seven points over it (the
// paint stands 12 mm over the deck), or it is under DRAPE_MIN_EDGE across; none stays longer than DRAPE_MAX_CELLS of
// the ground's cells. Flat ground costs nothing, a hill what its bends need. The layers are the triangles at the street
// (DRAPE_BAND, world y: buildings, lamps and trees leave it by their tops) of the ground's groups (DRAPE_ROOTS), but not
// the faces looking down. The instanced slabs among them (the rectangular sidewalks and their curbs, up to ~500 m long,
// the blocks' back yards) are baked into one mesh each when the guest is built. Each setGround() splits the layers again from their flat
// geometry. The shadow stand-ins (scene-culling.js) are copies of the flat geometry: a curb's shadow on a hill can
// stray by the curb's lift error.
// That detail is for a ground with a few smooth hills (the demo's). Real terrain bends a little everywhere: sampled
// from Terrarium on a 100 m grid, the 4 mm tolerance split every layer down to a few metres across the whole island,
// for minutes and gigabytes (the page hung). A host that sees the city from afar (a globe) passes setGround a coarser
// drape ({ tolerance, minEdge, maxCells, maxTriangles }: DRAPE_DEFAULTS' fields), and maxTriangles bounds it whatever
// the ground: each layer splits within its share of it (by area), a pass at a time, so it stays watertight
const DRAPE_ROOTS = ['ManhattanCityGrid', 'RoadMarkings'];
const DRAPE_SLAB_ROOTS = ['ManhattanCityBlocks']; // only their instanced slabs (the back yards), not the buildings
const DRAPE_BAND = [-3, 3.5];
const DRAPE_TOLERANCE = 0.004;
const DRAPE_MIN_EDGE = 2;
const DRAPE_MAX_CELLS = 4;
const SLIVER_HEIGHT = 1e-3; // a triangle narrower than this across its longest edge (m) is a sliver (subdivideTriangles)
const DRAPE_DEFAULTS = { tolerance: DRAPE_TOLERANCE, minEdge: DRAPE_MIN_EDGE, maxCells: DRAPE_MAX_CELLS, maxTriangles: Infinity };
// Where in a triangle the ground is checked: barycentric (u, v) for the second and third corners
const DRAPE_PROBES = [[1 / 3, 1 / 3], [0.5, 0], [0, 0.5], [0.5, 0.5], [2 / 3, 1 / 6], [1 / 6, 2 / 3], [1 / 6, 1 / 6]];

// Splits triangles in turn along their longest edge (in x, z) while needsSplit(ax, az, bx, bz, cx, cz, longest) says so
// (the corners' world x and z, and their longest edge's length in x, z), splitting each edge that is split in every
// triangle that has it, so the mesh stays watertight. needsSplit may be a number: split while the longest edge is
// longer. mesh: { attrs: { name: { array, itemSize } } per vertex, index (or null), world (x, y, z per vertex) }. A
// triangle takes part when its corners' world y are within band and it doesn't face down. Every attribute is
// interpolated linearly ('normal' renormalised). It stops before a pass that could take the mesh past maxTriangles (a
// split edge adds at most two triangles). Returns null when nothing was split, else { attrs: { name: Float32Array },
// index: Uint32Array, vertices, triangles, capped }
function subdivideTriangles(mesh, needsSplit, band = DRAPE_BAND, maxTriangles = Infinity) {
  if (typeof needsSplit === 'number') {
    const maxEdge = needsSplit;
    needsSplit = (ax, az, bx, bz, cx, cz, longest) => longest > maxEdge;
  }
  const count = mesh.world.length / 3;
  const tris = mesh.index || Uint32Array.from({ length: count }, (_, i) => i);
  // The vertices: the mesh's own (read in place), then the new ones
  const names = Object.keys(mesh.attrs);
  const sizes = names.map((n) => mesh.attrs[n].itemSize);
  const own = names.map((n) => mesh.attrs[n].array);
  const added = names.map(() => []);
  const ownW = mesh.world;
  const addedW = [];
  const X = (p) => (p < count ? ownW[3 * p] : addedW[3 * (p - count)]);
  const Y = (p) => (p < count ? ownW[3 * p + 1] : addedW[3 * (p - count) + 1]);
  const Z = (p) => (p < count ? ownW[3 * p + 2] : addedW[3 * (p - count) + 2]);
  const len = (p, q) => {
    const dx = X(p) - X(q);
    const dz = Z(p) - Z(q);
    return Math.sqrt(dx * dx + dz * dz); // not Math.hypot: several times slower, and this runs millions of times
  };
  // An edge is known by its midpoint, to the centimetre (an edge's two triangles may hold copies of its corners with
  // their own normals and uvs). x and z within ±10 km, y clamped (exact within the band): under 2^53
  const edgeKey = (p, q) => {
    const y = Math.min(Math.max(Math.round((Y(p) + Y(q)) * 50) + 500, 0), 999);
    return (Math.round((X(p) + X(q)) * 50) + 1e6) * 4e9 + (Math.round((Z(p) + Z(q)) * 50) + 1e6) * 1e3 + y;
  };
  const kept = [];
  let active = [];
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t];
    const b = tris[t + 1];
    const c = tris[t + 2];
    const [ay, by, cy] = [Y(a), Y(b), Y(c)];
    // facing down: the normal's y under -0.5
    const e1x = X(b) - X(a);
    const e1y = by - ay;
    const e1z = Z(b) - Z(a);
    const e2x = X(c) - X(a);
    const e2y = cy - ay;
    const e2z = Z(c) - Z(a);
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const inBand = Math.min(ay, by, cy) >= band[0] && Math.max(ay, by, cy) <= band[1];
    (inBand && ny >= -0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz) ? active : kept).push(a, b, c);
  }
  const mid = (p, q) => {
    const v = count + addedW.length / 3;
    for (let k = 0; k < names.length; k++) {
      const n = sizes[k];
      const d = added[k];
      const at = (r, j) => (r < count ? own[k][r * n + j] : d[(r - count) * n + j]);
      const o = d.length;
      for (let j = 0; j < n; j++) d.push((at(p, j) + at(q, j)) / 2);
      if (names[k] === 'normal' && n === 3) {
        const l = Math.hypot(d[o], d[o + 1], d[o + 2]) || 1;
        for (let j = 0; j < 3; j++) d[o + j] /= l;
      }
    }
    addedW.push((X(p) + X(q)) / 2, (Y(p) + Y(q)) / 2, (Z(p) + Z(q)) / 2);
    return v;
  };
  // Triangles found not to need splitting aren't asked again while no neighbour's split reaches them; each triangle's
  // longest edge is kept alongside. A split triangle's first child takes its place, the others go at the end
  const longestOf = (a, b, c) => Math.max(len(a, b), len(b, c), len(c, a));
  const settled = [];
  const longests = [];
  let capped = false;
  for (let t = 0; t < active.length; t += 3) {
    settled.push(0);
    longests.push(longestOf(active[t], active[t + 1], active[t + 2]));
  }
  const put = (slot, a, b, c) => {
    if (slot < 0) {
      active.push(a, b, c);
      settled.push(0);
      longests.push(longestOf(a, b, c));
    } else {
      active[3 * slot] = a;
      active[3 * slot + 1] = b;
      active[3 * slot + 2] = c;
      settled[slot] = 0;
      longests[slot] = longestOf(a, b, c);
    }
  };
  for (;;) {
    const marked = new Set();
    let shortest = Infinity; // of the edges to split: no shorter edge is one of them
    const n0 = settled.length;
    for (let i = 0; i < n0; i++) {
      if (settled[i]) continue;
      const a = active[3 * i];
      const b = active[3 * i + 1];
      const c = active[3 * i + 2];
      const longest = longests[i];
      // A sliver (its corners in a line, as the deck's triangulation leaves along straight shores) covers nothing, so
      // it never asks for a split: it splits only along with its neighbours' edges. Split for itself, it never settled
      // on real terrain (its halves were slivers on the same line, whose edges' midpoints, their keys, coincided), and
      // the splitting went on for ever. A wall isn't one: its corners are in a line across x, z, but not in space
      const ux = X(b) - X(a);
      const uy = Y(b) - Y(a);
      const uz = Z(b) - Z(a);
      const vx = X(c) - X(a);
      const vy = Y(c) - Y(a);
      const vz = Z(c) - Z(a);
      const twiceArea = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      if (twiceArea < SLIVER_HEIGHT * longest || !needsSplit(X(a), Z(a), X(b), Z(b), X(c), Z(c), longest)) {
        settled[i] = 1;
        continue;
      }
      const lab = len(a, b);
      const lbc = len(b, c);
      marked.add(longest === lab ? edgeKey(a, b) : longest === lbc ? edgeKey(b, c) : edgeKey(c, a));
      shortest = Math.min(shortest, longest);
    }
    if (!marked.size) break;
    if (kept.length / 3 + settled.length + 2 * marked.size > maxTriangles) {
      capped = true;
      break;
    }
    const reach = shortest - 1e-3;
    const isMarked = (p, q) => len(p, q) >= reach && marked.has(edgeKey(p, q));
    for (let i = 0; i < n0; i++) {
      if (longests[i] < reach) continue;
      let [a, b, c] = [active[3 * i], active[3 * i + 1], active[3 * i + 2]];
      let m = [isMarked(a, b), isMarked(b, c), isMarked(c, a)];
      const n = m[0] + m[1] + m[2];
      if (n === 0) continue;
      // Turned so the split edges come first: ab (one), ab and bc (two)
      if ((n === 1 && m[1]) || (n === 2 && !m[0])) [a, b, c, m] = [b, c, a, [m[1], m[2], m[0]]];
      else if ((n === 1 && m[2]) || (n === 2 && !m[1])) [a, b, c, m] = [c, a, b, [m[2], m[0], m[1]]];
      if (n === 1) {
        const ab = mid(a, b);
        put(i, a, ab, c);
        put(-1, ab, b, c);
      } else if (n === 2) {
        const ab = mid(a, b);
        const bc = mid(b, c);
        put(i, ab, b, bc);
        put(-1, a, ab, bc);
        put(-1, a, bc, c);
      } else {
        const ab = mid(a, b);
        const bc = mid(b, c);
        const ca = mid(c, a);
        put(i, a, ab, ca);
        put(-1, ab, b, bc);
        put(-1, ca, bc, c);
        put(-1, ab, bc, ca);
      }
    }
  }
  if (!addedW.length) return null;
  const vertices = count + addedW.length / 3;
  const attrs = {};
  names.forEach((name, k) => {
    const a = new Float32Array(vertices * sizes[k]);
    a.set(own[k]);
    a.set(added[k], own[k].length);
    attrs[name] = a;
  });
  const index = new Uint32Array(kept.length + active.length);
  index.set(kept);
  index.set(active, kept.length);
  return { attrs, index, vertices, triangles: index.length / 3, capped };
}

// The ground layers' meshes (above), each holding its flat geometry in userData.flatGeometry, the instanced slabs
// among them baked into plain meshes: when the guest is built, before the culling set-up and the materials' pass
function groundLayers(scene) {
  scene.updateMatrixWorld(true);
  const found = [];
  for (const name of [...DRAPE_ROOTS, ...DRAPE_SLAB_ROOTS]) {
    const root = scene.getObjectByName(name);
    const slabsOnly = DRAPE_SLAB_ROOTS.includes(name);
    if (root) root.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || o.name === 'HarborWater' || Array.isArray(o.material)) return;
      if (!slabsOnly || o.isInstancedMesh) found.push(o);
    });
  }
  const layers = [];
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  for (let o of found) {
    const geo = o.geometry;
    if (!geo || !geo.attributes.position || Object.keys(geo.morphAttributes).length) continue;
    const named = Object.entries(geo.attributes);
    if (named.some(([, a]) => a.isInterleavedBufferAttribute || !(a.array instanceof Float32Array))) continue;
    if (o.isInstancedMesh) {
      // Baked when every instance lies in the band (slabs, not posts) and some reach past a ground cell
      if (o.instanceColor || o.count * geo.attributes.position.count > 2e5) continue;
      let inBand = true;
      let reach = 0;
      const box = geo.boundingBox || (geo.computeBoundingBox(), geo.boundingBox);
      for (let k = 0; k < o.count && inBand; k++) {
        o.getMatrixAt(k, m).premultiply(o.matrixWorld);
        for (const [x, y, z] of [[box.min.x, box.min.y, box.min.z], [box.max.x, box.max.y, box.max.z]]) {
          v.set(x, y, z).applyMatrix4(m);
          inBand = inBand && v.y >= DRAPE_BAND[0] && v.y <= DRAPE_BAND[1];
        }
        reach = Math.max(reach, v.set(box.max.x - box.min.x, 0, box.max.z - box.min.z).applyMatrix3(new THREE.Matrix3().setFromMatrix4(m)).length());
      }
      if (!inBand || reach < 40) continue;
      o = bakeInstances(o);
    } else if (geo.groups.length) {
      // One material: its groups (an extrusion's caps and sides) say nothing
      o.geometry = geo.clone();
      o.geometry.clearGroups();
    }
    o.userData.flatGeometry = o.geometry;
    layers.push(o);
  }
  return layers;
}

// An instanced mesh as one plain mesh in its place, its instances' matrices baked into the vertices
function bakeInstances(o) {
  const geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
  const m = new THREE.Matrix4();
  const parts = [];
  for (let k = 0; k < o.count; k++) {
    o.getMatrixAt(k, m);
    parts.push(geo.clone().applyMatrix4(m));
  }
  const merged = window.NYC.Addons.mergeGeometries(parts, false);
  const baked = new THREE.Mesh(merged, o.material);
  for (const k of ['name', 'castShadow', 'receiveShadow', 'renderOrder', 'frustumCulled', 'visible']) baked[k] = o[k];
  baked.layers.mask = o.layers.mask;
  baked.position.copy(o.position);
  baked.quaternion.copy(o.quaternion);
  baked.scale.copy(o.scale);
  const parent = o.parent;
  parent.add(baked);
  parent.remove(o);
  baked.updateMatrixWorld();
  return baked;
}

// Splits the ground layers for the ground set (above), each from its flat geometry, to the drape's detail (options:
// DRAPE_DEFAULTS' fields). Returns the vertices and triangles of the layers before and after
function drapeGroundLayers(layers, ground, options = {}) {
  const { tolerance, minEdge, maxCells, maxTriangles } = { ...DRAPE_DEFAULTS, ...options };
  const cap = maxCells * Math.max(ground.grid.dx, ground.grid.dz);
  const off = (x, z) => ground.offsetAt(x, z);
  const needsSplit = (ax, az, bx, bz, cx, cz, longest) => {
    if (longest <= minEdge) return false;
    if (longest > cap) return true;
    const la = off(ax, az);
    const lb = off(bx, bz);
    const lc = off(cx, cz);
    for (const [u, v] of DRAPE_PROBES) {
      const t = 1 - u - v;
      if (Math.abs(la * t + lb * u + lc * v - off(ax * t + bx * u + cx * v, az * t + bz * u + cz * v)) > tolerance) return true;
    }
    return false;
  };
  const stats = { layers: layers.length, split: 0, capped: 0, vertices: [0, 0], triangles: [0, 0], ms: 0 };
  const t0 = performance.now();
  const v = new THREE.Vector3();
  // Each layer's world positions, and its area across x, z (for its share of maxTriangles)
  const worlds = layers.map((o) => {
    const pos = o.userData.flatGeometry.attributes.position;
    const world = new Float32Array(pos.count * 3);
    o.updateWorldMatrix(true, false);
    for (let i = 0; i < pos.count; i++) v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).toArray(world, 3 * i);
    return world;
  });
  const areas = layers.map((o, k) => {
    if (!Number.isFinite(maxTriangles)) return 0;
    const flat = o.userData.flatGeometry;
    const w = worlds[k];
    const index = flat.index && flat.index.array;
    const n = index ? index.length : w.length / 3;
    let area = 0;
    for (let t = 0; t < n; t += 3) {
      const a = 3 * (index ? index[t] : t);
      const b = 3 * (index ? index[t + 1] : t + 1);
      const c = 3 * (index ? index[t + 2] : t + 2);
      area += Math.abs((w[b] - w[a]) * (w[c + 2] - w[a + 2]) - (w[c] - w[a]) * (w[b + 2] - w[a + 2])) / 2;
    }
    return area;
  });
  const totalArea = areas.reduce((sum, a) => sum + a, 0) || 1;
  layers.forEach((o, k) => {
    const flat = o.userData.flatGeometry;
    const pos = flat.attributes.position;
    const attrs = {};
    for (const [n, a] of Object.entries(flat.attributes)) attrs[n] = { array: a.array, itemSize: a.itemSize };
    const triangles = (flat.index ? flat.index.count : pos.count) / 3;
    const budget = Number.isFinite(maxTriangles) ? Math.max(triangles, Math.floor((maxTriangles * areas[k]) / totalArea)) : Infinity;
    const out = subdivideTriangles({ attrs, index: flat.index && flat.index.array, world: worlds[k] }, needsSplit, DRAPE_BAND, budget);
    stats.vertices[0] += pos.count;
    stats.triangles[0] += triangles;
    let geo = flat;
    if (out) {
      geo = new THREE.BufferGeometry();
      for (const [n, a] of Object.entries(flat.attributes)) geo.setAttribute(n, new THREE.BufferAttribute(out.attrs[n], a.itemSize, a.normalized));
      geo.setIndex(new THREE.BufferAttribute(out.index, 1));
      stats.split++;
      if (out.capped) stats.capped++;
    }
    stats.vertices[1] += out ? out.vertices : pos.count;
    stats.triangles[1] += out ? out.triangles : triangles;
    if (o.geometry !== flat && o.geometry !== geo) o.geometry.dispose();
    o.geometry = geo;
  });
  stats.ms = Math.round(performance.now() - t0);
  return stats;
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

// Each node material in the scene, once: the ground's lift (lift(material), for those that don't place their own
// vertices), the output encoding (output(outputNode) → outputNode) and the depth (setupDepth, the material's method).
// A material's program then differs from one with the same nodes without these, so its cache key says which it has.
// Every material also loses its own MRT outputs (mrtNode: tsl-materials.js _transparentEffectMRT and the like, the
// normal and metalRough the app's SSR pass reads). The guest draws with no MRT, and drawn into a render target (the
// renderer's sRGB output buffer) with none, a material's mrtNode replaces its colour output instead of joining it
// (NodeMaterial.setupOutput), leaving its fragment shader no output for the colour buffer: WebGL2 rejects the draw
// (GL_INVALID_OPERATION, "Active draw buffers with missing fragment shader outputs"), and the lane paint, the
// highways' markings, the park lamps' pools, the steam, the god rays, the cars' contact shadows, headlight beams and
// flares and the tunnels' shade went undrawn. Returns how many materials it saw
function prepareMaterials(scene, { lift = null, output = null, setupDepth = null } = {}) {
  const seen = new Set();
  scene.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      if (!m || !m.isNodeMaterial || seen.has(m)) continue;
      seen.add(m);
      if (m.mrtNode) m.mrtNode = null;
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
//   lights            the street, store and car lamps, clustered (default true). false leaves them out, and with them
//                     ClusteredLighting's work each frame (on WebGL2 a transform-feedback pass over every cluster)
//   drape             how finely the ground layers follow the host's ground (THE GROUND, DRAPE_DEFAULTS: { tolerance,
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

  // The ground's nodes go in before the city is built: its materials' storeys and kerbs read NYC.groundLift
  const frame = makeGeoFrame();
  const ground = makeGround(frame);
  const groundNodes = getGroundNodes(ground.tangent);

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

  // The ground layers, split for the ground in setGround() (THE GROUND, drapeGroundLayers), their instanced slabs baked
  // before the culling set-up
  const layers = step('groundLayers', () => groundLayers(scene));

  const cullingRoots = ['ManhattanCityGrid', 'ManhattanCityBlocks', 'ManhattanStreetDetails', 'ManhattanLandmarks', 'Boroughs']
    .map((name) => scene.getObjectByName(name))
    .filter(Boolean);
  // The shadow stand-ins only the cascades draw: none without shadows
  step('culling', () => setupSceneCulling(scene, cullingRoots, opts.shadows ? lighting.sunLight.shadow : null));
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
  // level there (makeGround set()), and options.drape, the layers' detail (THE GROUND; default the guest's drape). After
  // it, frame.height0 is where the host puts the world frame's origin, and the city stands on the host's ground
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
    scene.userData.groundDrape = stats.drape = drapeGroundLayers(layers, ground, (options && options.drape) || opts.drape || {});
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
    if (boroughs && boroughs.update) boroughs.update(elapsed);
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

Object.assign(window.NYC, { createGuest, makeGeoFrame, makeGround, guestOptions, prepareMaterials, applyView, liftBounds, subdivideTriangles });
})();
