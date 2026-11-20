// js/terrarium.mjs
// Real heights for the app's ground (index.html?ground=terrain, js/ground.js THE APP ON THE GROUND): AWS's public
// Terrarium elevation tiles (Mapzen's Terrain Tiles on the Registry of Open Data, CORS-enabled), 256 px web-mercator
// PNGs whose pixels hold metres above mean sea level as height = R·256 + G + B/256 − 32768. ground.js imports this
// module only for that mode, as the app starts, and nothing here runs at import: the decoding and sampling are pure
// functions (tests/terrarium.test.mjs), and loadTerrarium() is the only one that fetches.
//
// Zoom 13 (14.5 m pixels at Manhattan's latitude) resolves what the data has: over the island its heights match zoom
// 14's to 0.35 m RMS, and across the Morningside cliff and Coogan's Bluff zooms 13, 14 and 15 agree to half a metre
// (the source is the USGS's ~10 m elevation model). The 13 tiles under Manhattan are
// 1.1 MB, against 33 tiles and 2.4 MB at zoom 14. The data's few pits and spikes (a 38 m spike at Foley Square at zoom
// 14, 5 m pits a few pixels across) are taken out by a 3 × 3 median over each tile's pixels (medianFilter3), before the
// grid's points sample them.

export const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRARIUM_ZOOM = 13;
const TILE = 256;

// Metres above mean sea level from a pixel's red, green and blue
export function decodeTerrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

// A tile's RGBA pixels (256 × 256 × 4, as ImageData's) as its heights, row by row
export function decodeTerrariumTile(rgba, size = TILE) {
  const heights = new Float32Array(size * size);
  for (let i = 0; i < heights.length; i++) heights[i] = decodeTerrarium(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]);
  return heights;
}

// Web mercator pixel coordinates (whole tiles of 256 px at `zoom`) of a lon / lat in degrees: pixel (i, j)'s centre is at
// (i + 0.5, j + 0.5)
export function terrariumPixel(lon, lat, zoom) {
  const n = TILE * 2 ** zoom;
  const phi = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n
  };
}

// The bilinear footprint of a lon / lat: the four pixels around it, as global pixel indices, and its weights
function footprint(lon, lat, zoom) {
  const p = terrariumPixel(lon, lat, zoom);
  const fx = p.x - 0.5;
  const fy = p.y - 0.5;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  return { i, j, tx: fx - i, ty: fy - j };
}

const tileKey = (zoom, x, y) => `${zoom}/${x}/${y}`;

// The tiles that the samples need (lonLat: lon / lat pairs; keep, optional: per sample, whether it is wanted), as
// { zoom, x, y, key } in a stable order
export function terrariumTiles(lonLat, zoom = TERRARIUM_ZOOM, keep = null) {
  const found = new Map();
  for (let s = 0; s < lonLat.length / 2; s++) {
    if (keep && !keep[s]) continue;
    const { i, j } = footprint(lonLat[2 * s], lonLat[2 * s + 1], zoom);
    for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const x = Math.floor((i + di) / TILE);
      const y = Math.floor((j + dj) / TILE);
      const key = tileKey(zoom, x, y);
      if (!found.has(key)) found.set(key, { zoom, x, y, key });
    }
  }
  return [...found.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}

// Heights at the samples, bilinear between pixel centres, from tiles: a Map of key → Float32Array (decodeTerrariumTile).
// Under the sea is clamped to it (the rivers' beds and the harbour's bathymetry are 0), so the shore isn't pulled
// down; a sample keep says no to is 0, and one whose tile is missing NaN
export function sampleTerrarium(lonLat, tiles, zoom = TERRARIUM_ZOOM, keep = null) {
  const out = new Float64Array(lonLat.length / 2);
  const at = (i, j) => {
    const x = Math.floor(i / TILE);
    const y = Math.floor(j / TILE);
    const t = tiles.get(tileKey(zoom, x, y));
    return t ? t[(j - y * TILE) * TILE + (i - x * TILE)] : NaN;
  };
  for (let s = 0; s < out.length; s++) {
    if (keep && !keep[s]) continue;
    const { i, j, tx, ty } = footprint(lonLat[2 * s], lonLat[2 * s + 1], zoom);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * tx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
    out[s] = clampBathymetry(a + (b - a) * ty);
  }
  return out;
}

// Anything under mean sea level is at it (NaN stays NaN)
export function clampBathymetry(h) {
  return h < 0 ? 0 : h;
}

// A 3 × 3 median over a grid of values (rows of cols), skipping NaN, the edges by what of the window is there
export function medianFilter3(values, cols, rows) {
  const out = new Float64Array(values.length);
  const win = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      win.length = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          const v = values[rr * cols + cc];
          if (!Number.isNaN(v)) win.push(v);
        }
      }
      if (!win.length) {
        out[r * cols + c] = NaN;
        continue;
      }
      win.sort((a, b) => a - b);
      const m = win.length >> 1;
      out[r * cols + c] = win.length % 2 ? win[m] : (win[m - 1] + win[m]) / 2;
    }
  }
  return out;
}

// A tile's PNG as its RGBA pixels, in a browser: decoded with no colour management or premultiplication, which would
// change the bytes that encode the heights
async function decodePng(blob) {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(bitmap.width, bitmap.height)
    : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

// Fetches the tiles under the samples and resolves to their heights (each tile's pixels median-filtered, then
// sampleTerrarium). Each tile is fetched once, with one retry; it rejects if any tile can't be had, so the caller falls
// back as a whole rather than draping a ground with holes. options: zoom, keep, url (a template with {z} {x} {y}),
// fetch, decode (Blob → RGBA), concurrency. Resolves to { heights, tiles, bytes, ms }
export async function loadTerrarium(lonLat, options = {}) {
  const {
    zoom = TERRARIUM_ZOOM, keep = null, url = TERRARIUM_URL,
    fetch: get = globalThis.fetch, decode = decodePng, concurrency = 6
  } = options;
  const t0 = performance.now();
  const wanted = terrariumTiles(lonLat, zoom, keep);
  const tiles = new Map();
  let bytes = 0;
  const one = async (t) => {
    const href = url.replace('{z}', t.zoom).replace('{x}', t.x).replace('{y}', t.y);
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await get(href, { mode: 'cors' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        bytes += blob.size;
        tiles.set(t.key, Float32Array.from(medianFilter3(decodeTerrariumTile(await decode(blob)), TILE, TILE)));
        return;
      } catch (err) {
        last = err;
      }
    }
    throw new Error(`terrarium tile ${t.key}: ${last && last.message}`);
  };
  const queue = wanted.slice();
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await one(queue.shift());
  }));
  const heights = sampleTerrarium(lonLat, tiles, zoom, keep);
  return { heights, tiles: wanted.length, bytes, ms: Math.round(performance.now() - t0) };
}
