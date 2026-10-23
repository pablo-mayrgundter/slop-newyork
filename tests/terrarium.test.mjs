import assert from 'node:assert/strict';
import test from 'node:test';

// js/terrarium.mjs: the decoding, the clamp, the tiles' arithmetic, the sampling and the loading, without the network
const T = await import('../js/terrarium.mjs');

test('Terrarium pixels decode to metres above the sea: R·256 + G + B/256 − 32768', () => {
  assert.equal(T.decodeTerrarium(128, 0, 0), 0);
  assert.equal(T.decodeTerrarium(128, 42, 128), 42.5);
  assert.equal(T.decodeTerrarium(127, 255, 0), -1);
  assert.equal(T.decodeTerrarium(0, 0, 0), -32768);
  assert.equal(T.decodeTerrarium(129, 0, 64), 256.25);
  // a tile's RGBA, row by row, the alpha ignored
  const rgba = new Uint8ClampedArray([128, 10, 0, 255, 127, 246, 0, 0, 128, 0, 128, 255, 128, 77, 192, 7]);
  assert.deepEqual([...T.decodeTerrariumTile(rgba, 2)], [10, -10, 0.5, 77.75]);
});

test('under the sea is the sea: the rivers\' beds clamp to 0, the land stays', () => {
  assert.equal(T.clampBathymetry(-14.2), 0);
  assert.equal(T.clampBathymetry(0), 0);
  assert.equal(T.clampBathymetry(37.5), 37.5);
  assert.ok(Number.isNaN(T.clampBathymetry(NaN)));
});

test('the tiles under Manhattan\'s points, at zoom 13', () => {
  // web mercator: the antimeridian and the equator at the edges and middle of the world
  assert.deepEqual(T.terrariumPixel(-180, 0, 0), { x: 0, y: 128 });
  assert.equal(T.terrariumPixel(0, 0, 13).x, 256 * 2 ** 12);
  // 5th Ave & 42nd St, Morningside Park, Inwood Hill
  const lonLat = [-73.98185, 40.75318, -73.9585, 40.8055, -73.926, 40.872];
  const tiles = T.terrariumTiles(lonLat, 13);
  assert.ok(tiles.every((t) => t.zoom === 13 && t.x >= 2410 && t.x <= 2415 && t.y >= 3074 && t.y <= 3080), JSON.stringify(tiles));
  assert.ok(tiles.some((t) => t.key === '13/2412/3078'), 'Midtown: x = 2412.5, y = 3078.0');
  // what keep leaves out isn't asked for
  assert.equal(T.terrariumTiles(lonLat, 13, [0, 0, 0]).length, 0);
  assert.deepEqual(T.terrariumTiles(lonLat, 13, [1, 0, 0]).map((t) => t.key), T.terrariumTiles(lonLat.slice(0, 2), 13).map((t) => t.key));
});

test('the samples are bilinear between pixel centres, clamped at the sea, 0 where not kept, NaN off the tiles', () => {
  // a world of one zoom-1 tile set: tile (0, 0) rising 1 m a pixel eastward from −10, the others missing
  const ramp = Float32Array.from({ length: 256 * 256 }, (_, i) => (i % 256) - 10);
  const tiles = new Map([['1/0/0', ramp]]);
  // a lon / lat at pixel x (centre of pixel i at i + 0.5) on row 100
  const lonAt = (px) => (px / 512) * 360 - 180;
  const latAt = (py) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / 512))) * 180) / Math.PI;
  const lat = latAt(100.5);
  const h = T.sampleTerrarium([lonAt(20.5), lat, lonAt(20.75), lat, lonAt(3.5), lat, lonAt(300), lat, lonAt(40.5), lat], tiles, 1, [1, 1, 1, 1, 0]);
  assert.ok(Math.abs(h[0] - 10) < 1e-6, `${h[0]}`);
  assert.ok(Math.abs(h[1] - 10.25) < 1e-6, `${h[1]}`);
  assert.equal(h[2], 0, 'pixel 3, 7 m under the sea');
  assert.ok(Number.isNaN(h[3]), 'tile (1, 0) is missing');
  assert.equal(h[4], 0, 'not kept');
});

test('a 3 × 3 median takes out a spike and a pit, and keeps a cliff', () => {
  const cols = 7;
  const rows = 5;
  // a cliff from 10 m to 40 m between columns 3 and 4, a spike at (1, 1) and a pit at (5, 3)
  const g = Float64Array.from({ length: cols * rows }, (_, i) => ((i % cols) < 4 ? 10 : 40));
  g[1 * cols + 1] = 48;
  g[3 * cols + 5] = 3;
  const m = T.medianFilter3(g, cols, rows);
  assert.equal(m[1 * cols + 1], 10);
  assert.equal(m[3 * cols + 5], 40);
  for (let r = 0; r < rows; r++) {
    assert.equal(m[r * cols + 2], 10);
    assert.equal(m[r * cols + 5], 40);
  }
  // NaN is skipped
  const n = T.medianFilter3([NaN, 1, 2, 3], 2, 2);
  assert.equal(n[0], 2);
});

test('loadTerrarium fetches each tile once, retries once, and fails as a whole', async () => {
  const lonLat = [-73.98185, 40.75318, -73.9585, 40.8055];
  const wanted = T.terrariumTiles(lonLat, 13);
  const asked = [];
  // every pixel 128, 20, 0: 20 m
  const decode = async () => {
    const rgba = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([128, 20, 0, 255], i);
    return rgba;
  };
  const ok = (url) => {
    asked.push(url);
    return Promise.resolve({ ok: true, blob: async () => ({ size: 1000 }) });
  };
  const r = await T.loadTerrarium(lonLat, { fetch: ok, decode });
  assert.equal(r.tiles, wanted.length);
  assert.equal(asked.length, wanted.length);
  assert.ok(asked.every((u) => /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\/13\/\d+\/\d+\.png$/.test(u)), asked[0]);
  assert.deepEqual([...r.heights], [20, 20]);
  assert.equal(r.bytes, 1000 * wanted.length);
  // a tile that fails once is asked again
  let first = true;
  const flaky = (url) => {
    if (first) {
      first = false;
      return Promise.reject(new Error('reset'));
    }
    return ok(url);
  };
  assert.equal((await T.loadTerrarium(lonLat, { fetch: flaky, decode })).tiles, wanted.length);
  // offline: it rejects, and the caller stays flat
  const offline = () => Promise.reject(new TypeError('Failed to fetch'));
  await assert.rejects(T.loadTerrarium(lonLat, { fetch: offline, decode }), /terrarium tile 13\/\d+\/\d+: Failed to fetch/);
  const notFound = () => Promise.resolve({ ok: false, status: 404 });
  await assert.rejects(T.loadTerrarium(lonLat, { fetch: notFound, decode }), /HTTP 404/);
});
