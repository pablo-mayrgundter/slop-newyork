(function () {
// js/ground.js
// The city on a ground that isn't flat: the world frame on the Earth, the ground's heights as lifts, the per-vertex
// lift every material takes, the ground layers split to follow it, and the lamps lifted with it. Shared by the guest
// (js/guest.js, on a host's terrain) and the app (js/main.js, index.html?ground=demo: a made-up hill, THE APP ON THE
// GROUND). Only the drawing follows the ground: the simulation, the physics and the colliders stay on the flat plane.
// Nothing here runs at load: TSL, lonLatToWorld (boroughs.js) and the addons are read when the functions are called.

const { THREE } = window.NYC;

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
  const { lonLatToWorld } = window.NYC;
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

// options.curve (default true): the globe's drop. The app, on a plane of its own (its sky, fog and 60 km harbour are
// flat), leaves it out
function makeGround(frame, bounds = GROUND_BOUNDS, { curve: curved = true } = {}) {
  // The Earth's mean radius of curvature at LAT0 on WGS84 (√(MN)): its d² / 2R is within 0.4% (~2 cm at 7 km) of the
  // drop along either principal direction
  const A = 6378137.0;
  const E2 = 6.69437999014e-3;
  const w = 1 - E2 * Math.sin((LAT0 * Math.PI) / 180) ** 2;
  const radius = Math.sqrt((A / Math.sqrt(w)) * ((A * (1 - E2)) / Math.pow(w, 1.5)));
  const curvature = curved ? 1 / (2 * radius) : 0;
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
    // harbour): a host's terrain over water is its sea surface or the river bed, where the piers and the shore stand.
    // height0, if given, is the height that lifts nothing (default the ground's at the tangent point, where a host puts
    // the frame's origin): the app keeps its shore and harbour in place with the flat land's
    set(heights, { seaLevel, height0: base } = {}) {
      const g = pending;
      if (!g || !heights || heights.length !== g.cols * g.rows) throw new Error('setGround: heights must match groundSamples()');
      const h = Float64Array.from(heights, (v) => (v === null ? NaN : v));
      if (seaLevel !== undefined) {
        const floor = seaLevel - WATER_Y;
        for (let i = 0; i < h.length; i++) if (h[i] < floor) h[i] = floor;
      }
      fillHoles(h, g.cols, g.rows);
      grid = g;
      height0 = Number.isFinite(base) ? base : bilinear(g, h, tangent.x, tangent.z);
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
// (DRAPE_BAND, world y: buildings, lamps and trees leave it by their tops) of the ground's groups (DRAPE_ROOTS), the
// faces looking down too. An underside left whole is a chord under its top where the ground is convex (the hill's
// crown: hidden), but over it where the ground is concave (past σ, the hill's foot): Central Park's curb island, lawn,
// wall and sidewalk are extrusions whose undersides are triangles 4 km long, and over Sheep Meadow and north of it
// they stood 4-11 m over the lawn, a roof at a driver's eye that also shaded the meadow. The instanced slabs among the
// layers (the rectangular sidewalks and their curbs, up to ~500 m long, the blocks' back yards) are baked into one mesh
// each when the guest is built. Each setGround() splits the layers again from their flat geometry. The ground layers
// cast their own shadows: the shadow stand-ins (scene-culling.js) are copies of the flat geometry, and the park's curb
// island's hovered over the meadow as its underside did.
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
// triangle takes part when its corners' world y are within band, whichever way it faces. Every attribute is
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
    (Math.min(ay, by, cy) >= band[0] && Math.max(ay, by, cy) <= band[1] ? active : kept).push(a, b, c);
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
// (roots: more groups whose flat layers follow the ground, as DRAPE_ROOTS')
function groundLayers(scene, roots = []) {
  scene.updateMatrixWorld(true);
  const found = [];
  for (const name of [...DRAPE_ROOTS, ...roots, ...DRAPE_SLAB_ROOTS]) {
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

// Each node material in the scene, once: the ground's lift (lift(material), for those that don't place their own
// vertices), the output encoding (output(outputNode) → outputNode) and the depth (setupDepth, the material's method).
// A material's program then differs from one with the same nodes without these, so its cache key says which it has.
// Every material also loses its own MRT outputs (mrtNode: tsl-materials.js _transparentEffectMRT and the like, the
// normal and metalRough the app's SSR pass reads). The guest draws with no MRT, and drawn into a render target (the
// renderer's sRGB output buffer) with none, a material's mrtNode replaces its colour output instead of joining it
// (NodeMaterial.setupOutput), leaving its fragment shader no output for the colour buffer: WebGL2 rejects the draw
// (GL_INVALID_OPERATION, "Active draw buffers with missing fragment shader outputs"), and the lane paint, the
// highways' markings, the park lamps' pools, the steam, the god rays, the cars' contact shadows, headlight beams and
// flares and the tunnels' shade went undrawn. The app draws its scene pass with an MRT (SSR's normal and metalRough,
// bloom's input), which the materials' own outputs join: it passes keepMRT. Returns how many materials it saw
function prepareMaterials(scene, { lift = null, output = null, setupDepth = null, keepMRT = false } = {}) {
  const seen = new Set();
  scene.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      if (!m || !m.isNodeMaterial || seen.has(m)) continue;
      seen.add(m);
      if (m.mrtNode && !keepMRT) m.mrtNode = null;
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

// =====================================================================================================================
// THE DRAPE
// What the guest and the app do with a ground, in this order:
//   createGroundDrape()   before the city is built: its nodes set NYC.groundLift, which the materials' deckPosition reads
//   takeLayers(scene)     once the city is built, before the culling set-up: the ground layers (their instanced slabs
//                         baked, groundLayers)
//   liftMaterial          prepareMaterials' lift, before the pipelines compile: every material's vertex stage adds the
//                         ground's offset at the vertex's world (x, z), from a half-float map of the offsets, less the
//                         curve. It goes in with the map flat and switched off; set() swaps the map and sets the
//                         uniforms, which recompiles nothing. It wraps the material's positionNode, which three applies
//                         after skinning, batching and instancing (NodeMaterial.setupPosition): positionLocal there is
//                         the instance's vertex, from an instanced attribute (WebGL2) or a storage buffer (WebGPU, the
//                         app's StorageInstancedBufferAttribute), so the lift sees where each instance stands
//   takeLights(scene)     the lamps (point and spot lights: street and store lights, the cars' and the player's), placed
//                         on the CPU and lifted each frame by liftLights()
//   set(heights, opts)    the ground (makeGround set(), and opts.drape over the drape's), splitting the layers for it
//                         (drapeGroundLayers) and padding the bounding spheres by what it moves
// =====================================================================================================================
// options: drape (the layers' detail, DRAPE_DEFAULTS' fields), bounds (the ground's grid, default GROUND_BOUNDS),
// curve (the globe's drop, default true), roots (more groups whose flat layers follow the ground)
function createGroundDrape({ drape = null, bounds = GROUND_BOUNDS, curve = true, roots = [] } = {}) {
  const frame = makeGeoFrame();
  const ground = makeGround(frame, bounds, { curve });
  const nodes = getGroundNodes(ground.tangent);
  let scene = null;
  let layers = [];
  let lights = [];
  let last = null;

  function liftMaterial(m) {
    if (m.castShadowPositionNode) m.castShadowPositionNode = nodes.lift(m, m.castShadowPositionNode);
    m.positionNode = nodes.lift(m, m.positionNode);
  }

  function takeLayers(s) {
    scene = s;
    layers = groundLayers(s, roots);
    return layers;
  }

  function takeLights(s) {
    lights = [];
    s.traverse((o) => {
      if (o.isPointLight || o.isSpotLight) lights.push(o);
    });
    return lights;
  }

  function set(heights, options = {}) {
    ground.set(heights, options);
    const { x0, z0, dx, dz, cols, rows } = ground.grid;
    const old = nodes.map.value;
    nodes.map.value = makeOffsetMap(ground.offsets, cols, rows);
    old.dispose();
    nodes.box.value.set(x0, z0, 1 / (cols * dx), 1 / (rows * dz));
    nodes.texel.value.set(0.5 / cols, 0.5 / rows);
    nodes.on.value = 1;
    nodes.curvature.value = ground.curvature;
    frame.height0 = ground.height0;
    last = drapeGroundLayers(layers, ground, options.drape || drape || {});
    const t0 = performance.now();
    if (scene) padBounds(scene, ground);
    last.padMs = Math.round(performance.now() - t0);
    return last;
  }

  // Each lamp (and a spot's target) at its own place, lifted (liftObject). Nothing before set()
  function liftLights() {
    if (!ground.on) return;
    for (const light of lights) {
      liftObject(light, ground);
      if (light.target) liftObject(light.target, ground);
    }
  }

  return {
    frame,
    ground,
    nodes,
    get layers() { return layers; },
    get lights() { return lights; },
    get stats() { return last; },
    liftMaterial,
    takeLayers,
    takeLights,
    set,
    liftLights,
    offsetAt: (x, z) => ground.offsetAt(x, z)
  };
}

// Bounding spheres (a geometry's, or an instanced mesh's own), padded by the most the ground moves anything in them,
// so frustum culling keeps what it raised into view. A geometry shared by several meshes takes the largest pad
function padBounds(scene, ground) {
  const _sphere = new THREE.Sphere();
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
}

// An object placed on the CPU (a lamp) raised straight up in the world by the ground under it, from where it was
// placed: one moved since its last lift (a car's lamp, re-placed every frame) is lifted from its new place, one that
// rides its parent (the player's headlights on the chassis) from where it stands on the parent. The lift is world up
// taken into the parent's frame, as a chassis pitches and a bike leans. The parent's world matrix is the last frame's
// (the render updates it): a lamp on a moving car lags its ground by a frame, a centimetre at 30 m/s on a 2% grade.
// Only point and spot lights: the sun (a SunLight, not a DirectionalLight) is placed by its direction, which a lift
// would tip under the horizon
let _liftP = null; // made on first use: tests load this file with a stub of three
let _liftM = null;
function liftObject(o, ground) {
  if (!_liftP) [_liftP, _liftM] = [new THREE.Vector3(), new THREE.Matrix3()];
  const u = o.userData;
  if (!u.groundLifted || !o.position.equals(u.groundLifted)) u.groundBase = (u.groundBase || new THREE.Vector3()).copy(o.position);
  const parent = o.parent;
  _liftP.copy(u.groundBase);
  if (parent) _liftP.applyMatrix4(parent.matrixWorld);
  _liftP.set(0, ground.offsetAt(_liftP.x, _liftP.z), 0);
  if (parent) _liftP.applyMatrix3(_liftM.setFromMatrix4(parent.matrixWorld).invert());
  o.position.copy(u.groundBase).add(_liftP);
  u.groundLifted = (u.groundLifted || new THREE.Vector3()).copy(o.position);
}

// =====================================================================================================================
// THE DEMO GROUND
// A ground as a host would hand it over, standing in for its terrain (guest.html?ground=demo, index.html?ground=demo):
// a smooth 40 m hill over Midtown (centred at world x -300, z -900, 1.1 km across its σ) on flat land 5 m above the sea,
// in heights above the ellipsoid (sea level 32.7 m under it, as at Manhattan). Its steepest grade is 2.2%, 1.1 km out
// =====================================================================================================================
const DEMO_SEA_LEVEL = -32.7;
const DEMO_LAND = 5;
const DEMO_HILL = { x: -300, z: -900, height: 40, sigma: 1100 };

// The demo's heights at groundSamples()' lon / lat pairs
function demoGroundHeights(lonLat, frame, seaLevel = DEMO_SEA_LEVEL) {
  const heights = new Float64Array(lonLat.length / 2);
  const { x, z, height, sigma } = DEMO_HILL;
  for (let i = 0; i < heights.length; i++) {
    const p = frame.lonLatToWorld(lonLat[2 * i], lonLat[2 * i + 1]);
    const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
    heights[i] = seaLevel + DEMO_LAND + height * Math.exp(-d2 / (2 * sigma ** 2));
  }
  return heights;
}

// =====================================================================================================================
// THE APP ON THE GROUND
// index.html?ground=demo: the app as it is (its backend, post-processing, HUD, controllers and cameras) over the demo
// ground. js/main.js calls createAppGround() before it builds the city, takeLayers() before the culling set-up,
// attach() before the shaders compile, and beforeRender() each frame between the simulation and the render; without
// ?ground the app never calls the rest (createAppGround returns null) and draws as before.
//   - The ground is the demo's, with two differences from a host's: the flat land lifts nothing (set()'s height0), so
//     the shore and the harbour's water stay where they are and the hill rises 40 m over Midtown (5th Ave & 42nd St
//     27.6 m up); and there's no globe's curve, since the app's world is a plane (its sky, fog and 60 km water plane of
//     two triangles, whose corners the curve would sink 70 m under the shore). Its grid reaches 7 km or more from
//     the hill's top, where the hill has gone (e^-21), so everything off it, the water's corners and New Jersey, holds
//     a ground of 0.
//   - Only Manhattan's ground layers are split (DRAPE_ROOTS). The hill's foot reaches Queens (1.5 m at Long Island
//     City), whose flat layers ride the vertex lift alone; split too ('Boroughs' in createGroundDrape's roots) they
//     took the drape from 4 s to 26 s headless and from 0.8 M to 6.4 M more triangles: the drape splits every edge
//     over 4 ground cells, and the boroughs' ground is kilometres-long triangles.
//   - The materials keep their MRT outputs (prepareMaterials keepMRT): the scene pass's MRT (SSR, bloom) joins them.
//   - The cameras are placed in the simulation's flat frame (cameras.js) and lifted for the render only: a follow
//     camera (chase, action, POV, the helicopter's) by the ground under its entity, so the framing holds on a slope, or
//     by the ground under itself where that is higher (looking down a hill); a scenic one by the ground under it, and
//     its look-at point by the ground under that. The next frame's camera update places it flat again.
//   - The vehicles, the player, trees and street furniture ride the vertex lift, each vertex by the ground under it:
//     a car's wheels stay on the slope and its body shears with it, which at the demo's 2.2% reads as its pitch. A
//     rigid tilt on top would double it, so there's none.
//   - The fog keeps positionWorld's (true) height: haze thins with altitude, and the camera and the fragment are both
//     lifted, so the haze between them is the air's, hill or not (deckPosition there would put Midtown's facades in
//     the denser air of the street, up to 4% (40 m / the haze's 900 m) more haze over the hill).
// =====================================================================================================================
const APP_GROUND_BOUNDS = { x0: -7500, x1: 7000, z0: -8500, z1: 7500 };

function createAppGround(mode) {
  if (mode !== 'demo') return null;
  const drape = createGroundDrape({ bounds: APP_GROUND_BOUNDS, curve: false });
  const stats = { materials: 0, lights: 0, samplesMs: 0, setGroundMs: 0, drape: null };
  return {
    drape,
    frame: drape.frame,
    stats,
    offsetAt: drape.offsetAt,
    takeLayers: (scene) => drape.takeLayers(scene),
    attach(scene, mark = () => {}) {
      const t = performance.now();
      stats.materials = prepareMaterials(scene, { lift: drape.liftMaterial, keepMRT: true });
      stats.lights = drape.takeLights(scene).length;
      stats.materialsMs = Math.round(performance.now() - t);
      const t0 = performance.now();
      const { lonLat } = drape.ground.samples(40);
      const heights = demoGroundHeights(lonLat, drape.frame);
      stats.samplesMs = Math.round(performance.now() - t0);
      stats.drape = drape.set(heights, { seaLevel: DEMO_SEA_LEVEL, height0: DEMO_SEA_LEVEL + DEMO_LAND });
      stats.setGroundMs = Math.round(performance.now() - t0);
      mark('ground');
    },
    beforeRender(cameraSystem) {
      drape.liftLights();
      liftAppCamera(cameraSystem, drape.ground);
    }
  };
}

// The camera system's camera, placed flat (cameraSystem.currentPos, currentLookAt), lifted onto the ground as above
function liftAppCamera(cameraSystem, ground) {
  const camera = cameraSystem.camera;
  const eye = cameraSystem.currentPos;
  const look = cameraSystem.currentLookAt;
  let liftEye;
  let liftLook;
  if (cameraSystem.getActivePreset().category === 'follow') {
    const p = cameraSystem.controllerManager.getActiveEntity().position;
    liftLook = ground.offsetAt(p.x, p.z);
    liftEye = Math.max(liftLook, ground.offsetAt(eye.x, eye.z));
  } else {
    liftEye = ground.offsetAt(eye.x, eye.z);
    liftLook = ground.offsetAt(look.x, look.z);
  }
  camera.position.set(eye.x, eye.y + liftEye, eye.z);
  camera.lookAt(look.x, look.y + liftLook, look.z);
}

Object.assign(window.NYC, {
  makeGeoFrame, makeGround, subdivideTriangles, prepareMaterials, createGroundDrape, demoGroundHeights, createAppGround,
  DEMO_SEA_LEVEL
});
})();
