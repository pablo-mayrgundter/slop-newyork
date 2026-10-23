# Slop New York

A New York City simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore Manhattan on foot, by car, by bicycle, or by helicopter.

[Try it live](https://mrdoob.github.io/slop-newyork/)

[`?ground=demo`](https://pablo-mayrgundter.github.io/slop-newyork/?ground=demo) drives the city over a 40 m hill (a test ground)

## Make it your own

Fork it, remix it, improve it, break it. Make games, animations, films, experiments, or something completely different. Use it as a starting point and take it wherever you want. Have fun!

## As a guest in another engine

`js/guest-entry.mjs` loads the city into any page as a *guest*: no HUD, player, camera rig, sky, fog or post-processing,
on three.js's WebGL2 backend, drawn with a canvas and context you hand it (a [NetGL](https://github.com/pablo-mayrgundter/portal)
recorder, say) from a camera and sun you set each frame. [`guest.html`](guest.html) runs it on a page of its own.

```js
const { createNYCGuest } = await import('./js/guest-entry.mjs');
const guest = await createNYCGuest({ canvas, context, width, height }); // extent: 'manhattan' (default) or 'all';
                                                                          // shadows, lights, crowds (default true)
await guest.compile();
// each frame
guest.setView({ matrixWorld, projectionMatrix }); // the camera in the city's frame, column-major
guest.setSun(sunDirection);                       // { x, y, z } toward the sun in the city's frame, y up
guest.update(dt);
guest.render();
```

The city's frame is metres, x = grid east, y = up, z = grid south, centred on 5th Ave & 42nd St. `guest.frame.worldToEnu`
takes it to east-north-up metres about `guest.frame.lon0, lat0` on WGS84, and `guest.frame.waterY` is the harbour's
surface (mean sea level) under the flat city. three.js comes from the page's import map (as in `index.html`), or pass
`three: { THREE, TSL, Addons }`.

### On the host's ground

The city is built flat, but the ground under it isn't, and a globe curves away from a plane (d²/2R, ~4 m at the drawn
island's ends). The host can hand the guest its terrain, and the city is then drawn draped over it: every vertex rises
by the ground's height over `height0` (the ground at `frame.lon0, lat0`), less the curve. The simulation, and the
shading's storeys, kerbs and waterlines, stay on the flat deck; only the drawing moves.

```js
const { lonLat, cols, rows } = guest.groundSamples(40);   // lon/lat pairs (degrees) on a grid over the island, 40 m apart
guest.setGround(heights, { seaLevel });                   // the host's terrain height at each (m above its ellipsoid)
guest.frame.height0;                                      // where the host puts the frame's origin, (lon0, lat0, height0)
guest.groundOffsetAt(x, z);                               // how far the ground lifts world (x, z)
```

`heights` may hold `NaN` where the host had no terrain (its neighbours fill it). `seaLevel` is the host's mean sea level
in the same datum: the ground never sinks below the city's own freeboard over it (2.2 m), so the piers and the shore
stay above a host's water and river beds. Outside the grid (only the boroughs of `extent: 'all'`) the ground holds its
edge. A host on Cesium can use [`js/guest-cesium.mjs`](js/guest-cesium.mjs), which takes the host's `Cesium` as an
argument rather than importing it:

```js
import { groundFromCesium, cityModelMatrix } from './js/guest-cesium.mjs';
await groundFromCesium(guest, Cesium, viewer.terrainProvider);  // sampleTerrainMostDetailed (or sampleTerrain at `level`
                                                                 // for a provider without availability), then setGround
const modelMatrix = cityModelMatrix(guest, Cesium);              // ENU at (lon0, lat0, height0) × frame.worldToEnu
```

`cityModelMatrix` takes the city's frame to Cesium's Earth-fixed one; its inverse times the Cesium camera's
`inverseViewMatrix` is the `matrixWorld` for `setView`. `seaLevel` defaults to −32.7 m (mean sea level over the WGS84
ellipsoid at Manhattan, as in Cesium World Terrain). [`guest.html?ground=demo`](guest.html?ground=demo) drapes the city
over a made-up 40 m hill on Midtown, with no host, and [`index.html?ground=demo`](index.html?ground=demo) drives the app over
the same hill (the ground's code, [`js/ground.js`](js/ground.js), is shared by the two).

The lift moves vertices, and the city's flat layers at the street (the road deck, the seawall, the lawns, the
sidewalks' slabs, the paint) are partly built from long triangles, which would cut straight through a hill. So
`setGround` also splits those layers where the ground bends away from them, until it is within 4 mm of every triangle:
flat ground costs nothing, the demo hill ~0.7 M more triangles and a few seconds of main thread on each `setGround`.

That detail is for a smooth made-up hill. Real terrain bends a little everywhere: on Terrarium heights over the island
the road deck alone split to 2.9 M triangles in 140 s, and the whole drape ran for minutes and gigabytes. A host that
sees the city from afar passes a coarser drape, `createNYCGuest({ drape })` or `setGround(heights, { seaLevel, drape })`:

```js
guest.setGround(heights, { seaLevel, drape: { tolerance: 0.1, minEdge: 8, maxTriangles: 1.5e6 } });
guest.stats.drape;   // { layers, split, capped, vertices: [before, after], triangles: [before, after], ms }
```

`tolerance` (m, default 0.004), `minEdge` (m, default 2: no edge is split shorter), `maxCells` (default 4: no edge
longer than this many ground cells) and `maxTriangles` (default unbounded: each layer splits within its share of it,
by area, a layer keeping at least its own; it stops before a pass that would pass it, so it stays watertight). With
the drape above, the same heights on a 100 m grid take 1.7 M triangles and ~5 s on a slow CPU. Slivers (triangles whose
corners are in a line, as the deck's triangulation leaves along straight shores) never ask for a split themselves:
on real terrain they never settled, and the drape looped for ever.

### What the guest doesn't build

What a guest leaves out isn't built: `extent: 'manhattan'` builds none of the other boroughs (their ~117k buildings,
the bridges and islands), `shadows: false` no shadow stand-ins, and `crowds: false` no pedestrians (they're never drawn
on WebGL2, but walk and are skinned every frame, about 5 ms of `update()` at street level; the cars then meet nobody at
the crosswalks). `guest.stats.build` has each build step's milliseconds (`cityGrid`, `cityBlocks`, `streetDetails`,
`traffic`, ... and `compile`).

### Measuring it

[`guest.html`](guest.html) reads out the frame rate, the frame time and the JavaScript time in `update()` and
`render()` (render's includes any wait on the GPU), with the draws and triangles of a frame. It takes
`?view=aerial` (the orbit, the default), `street` (5th Ave at 37th St, looking north) or `park`; `?ground=demo`;
`?shadows=0`; `?lights=0` (no lamps and no ClusteredLighting, `createGuest({ lights: false })`); and `?dpr=1` (the
drawing buffer in CSS pixels; by default it is in device pixels, 4× as many on a 2× screen, where the app renders at a
pixel ratio of 1). The app takes `?webgl` to run three's WebGL2 backend, as the guest does, in a browser with WebGPU.

### Inside a host's frame

A host that draws the guest into its own framebuffer, against its own depth, rather than compositing a separate canvas,
creates it with two more options:

```js
const guest = await createNYCGuest({ canvas, context, width, height, composite: true, logDepth: true });
guest.setView({ matrixWorld, projectionMatrix, near, far });             // near and far as the host has them
guest.setDepth({ near, oneOverLog2FarDepthFromNearPlusOne });            // each frustum, or null for standard depth
guest.setLinearOutput(false);                                             // true for a host rendering in linear HDR
```

- **`composite`** (default `false`): no clears, no output render target and no tone mapping. With an sRGB output or a
  tone mapping, three's WebGPURenderer draws into a target of its own and copies it over the whole screen with no depth,
  which wipes the host's frame; so the renderer outputs linear and each material encodes sRGB itself (its
  `outputNode`), or not, with `setLinearOutput(true)`.
- **`logDepth`** (default `false`): every material writes the host's logarithmic depth, Cesium's
  `log2(w − near + 1) · oneOverLog2FarDepthFromNearPlusOne` (`w` the distance along the view direction), from uniforms
  `setDepth()` sets; `setDepth(null)` writes the standard depth of the camera's near and far. It goes in through each
  material's `setupDepth`, so the shadow maps keep the light's own depth.
- **`setView`'s `near` and `far`** are optional; without them they are read back from the projection, which is
  ill-conditioned when far / near is large (Cesium's single log-depth frustum is ~1e7).
- `guest.bounds()` is what the guest draws, a `{ min, max }` box in the city's frame with the ground's lift.

Both go in with the ground's lift, in one pass over the materials before they compile; with neither the guest is as
before. On Cesium with `scene.externalRenderers` (a Cesium with the external render pass, as
[celestiary's fork](https://github.com/celestiary/cesium/tree/celestiary/external-render-pass)), `js/guest-cesium.mjs`
builds the whole renderer, the guest replaying through a [NetGL](https://github.com/pablo-mayrgundter/portal) immediate
link into Cesium's own context:

```js
import { makeNetGLImmediateLink, makeNetGLGuestContext } from 'portal-netgl';
import { groundFromCesium, cesiumScreenFramebuffer, cesiumExternalRenderer } from './js/guest-cesium.mjs';

const screen = cesiumScreenFramebuffer(); // the replay's screen: the framebuffer of the pass the city is drawn in
const link = makeNetGLImmediateLink({ gl: scene.context._gl, replay: { screenFramebuffer: screen } });
const guestCtx = makeNetGLGuestContext({ canvas, transport: link.transport });
const guest = await createNYCGuest({ canvas, context: guestCtx.gl, width, height, composite: true, logDepth: true });
await groundFromCesium(guest, Cesium, scene.terrainProvider);
await guest.compile();
scene.externalRenderers.add(cesiumExternalRenderer(guest, Cesium, { link, guestCtx, screen }));
```

Cesium calls it in each frustum the city's box overlaps, after the opaque geometry: it takes Cesium's view × the city's
model matrix in doubles into `setView` with the frustum's near and far, sets `setDepth` when Cesium writes log depth,
points the replay at the pass's framebuffer and runs one guest frame on the link. Once a Cesium frame (by
`frameNumber`) it sets the sun from Cesium's and steps the simulation (`dt: (p) => seconds` to step it otherwise,
`sun: false` to set the sun yourself). The link's `screenFramebuffer` is fixed when the link is made, before the
guest and its renderer exist, hence `screen`: a function the renderer points at each pass's framebuffer. The other
helpers, for a host of your own:

```js
cityBoundingVolume(guest, Cesium, modelMatrix);  // a Cesium.OrientedBoundingBox of guest.bounds() on the globe
cityBoundingSphere(guest, Cesium, modelMatrix);  // the sphere around it
sunFromCesium(guest, Cesium, p, modelMatrix);    // p.sunDirectionWC in the city's frame, for guest.setSun
```

The renderer's bounding volume follows the ground when `setGround` moves it. It assumes the pass's viewport starts at
the origin (Cesium's does, outside VR), and resizes the guest to the pass.

## License and data

The project code is available under the [MIT License](LICENSE).

Geographic data: NYC Open Data and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Third-party data and dependencies retain their respective licenses.
