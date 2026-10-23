# Project conventions for AI assistants

Working norms for AI agents (Claude Code, Codex, etc.) contributing to
this repository. `CLAUDE.md` is a symlink to this file. Read it before
starting work, and keep it current when you learn something the next
session would otherwise rediscover.

This repo is pablo-mayrgundter's fork of
[mrdoob/slop-newyork](https://github.com/mrdoob/slop-newyork): a
three.js simulation of Manhattan on WebGPURenderer and TSL, built
against three.js's dev branch. The fork adds a *guest* mode that draws
the city inside another engine.

## Where to look

There are no design docs beyond the README. Each script opens with a
header comment that says what it builds and why, and long files are cut
into banner-commented sections (`// ====`). Read the header before the
code.

| Working on | Read first |
|---|---|
| What the project is, the live demo | [README.md](./README.md) |
| How the app boots: script order, the three.js import map, `window.NYC` | [index.html](./index.html) (`nycAppScripts`, the import map, the module script that fills `window.NYC`), then [js/main.js](./js/main.js) `initApp` |
| The city as a guest in another engine (a NetGL guest of a globe) | README [As a guest in another engine](./README.md#as-a-guest-in-another-engine); [js/guest.js](./js/guest.js) (its header, `THE HOST'S FRAME` and `THE GUEST`); [js/guest-entry.mjs](./js/guest-entry.mjs); [guest.html](./guest.html), its demo page |
| The ground under the city (the frame on the Earth, heights, the lift, the drape, the lamps), shared by the guest and the app's `?ground=demo` and `?ground=terrain` | [js/ground.js](./js/ground.js): `THE FRAME ON THE EARTH`, `THE GROUND`, `THE DRAPE`, `THE DEMO GROUND`, `THE APP ON THE GROUND`; the real heights, [js/terrarium.mjs](./js/terrarium.mjs) |
| The host side of the guest (recorder, replay, compositing) | [portal](https://github.com/pablo-mayrgundter/portal): its AGENTS.md and [portal-netgl DESIGN.md](https://github.com/pablo-mayrgundter/portal/blob/main/packages/portal-netgl/DESIGN.md) |
| The world frame, lon/lat to world | [tools/geo-base.mjs](./tools/geo-base.mjs) section 1, FRAME; [js/boroughs.js](./js/boroughs.js) `LL()` |
| The real geography and how it's built | [tools/build-geodata.mjs](./tools/build-geodata.mjs) and the `tools/geo-*.mjs` it imports; inputs in `tools/data/` (Overpass queries `q_*.overpassql`, fetched with `tools/overpass.sh`) |
| Sun, sky, fog, IBL, shadow cascades, time-of-day presets | [js/lighting.js](./js/lighting.js) |
| Ground, coastline, sidewalks, harbour water | [js/city-grid.js](./js/city-grid.js); the other boroughs and New Jersey, [js/boroughs.js](./js/boroughs.js) |
| Buildings, landmarks, street furniture, trees | [js/buildings.js](./js/buildings.js), [js/landmarks.js](./js/landmarks.js), [js/street-details.js](./js/street-details.js), [js/trees.js](./js/trees.js) |
| Roads, lane paint, traffic, crowds | [js/road-network.js](./js/road-network.js), [js/road-paint.js](./js/road-paint.js), [js/traffic.js](./js/traffic.js), [js/pedestrians.js](./js/pedestrians.js), [js/vehicle-lights.js](./js/vehicle-lights.js) |
| Materials (TSL) | [js/tsl-materials.js](./js/tsl-materials.js); vehicles, [js/actor-models.js](./js/actor-models.js) |
| Player, cameras, input, minimap | [js/controllers.js](./js/controllers.js), [js/cameras.js](./js/cameras.js), [js/touch-controls.js](./js/touch-controls.js), [js/nyc-map.js](./js/nyc-map.js) |
| Culling of the island-wide instanced meshes | [js/scene-culling.js](./js/scene-culling.js) |
| Tone mapping, grading, bloom | [js/post-processing.js](./js/post-processing.js) |
| Tests | `tests/`: `*.test.cjs` and `*.test.mjs` |
| Deploys and PR previews | `.github/workflows/pages.yml` and `.github/workflows/pr-preview.yml` |

## Working efficiently

- **No build and no package.json.** The app is classic scripts, each an
  IIFE that reads what it needs from `window.NYC` and adds its own
  exports to it. index.html loads them in a fixed order
  (`nycAppScripts`), after an import map that serves three.js dev from
  jsDelivr (`cdn.jsdelivr.net/gh/mrdoob/three.js@dev/...`). To run it,
  serve the repo root with any static server (e.g.
  `python3 -m http.server 8000`) and open `/`.
  - A new script goes into `nycAppScripts` at the point where what it
    reads from `window.NYC` is already defined.
- **Tests:** `node --test tests/*.cjs tests/*.mjs` (123 tests, about
  45 s). Plain `node --test tests/` fails, so use the globs. The tests
  run the scripts in `node:vm` with stubs for `window.NYC`, three.js
  and the DOM, or parse index.html and the scripts as text. No GPU and
  no three.js download are needed.
- **The guest** (js/guest.js, js/guest-entry.mjs) builds the city
  without the HUD, the player, the camera rig, the sky, the fog or the
  post-processing, and draws it with a canvas and context the host
  hands it. The host sets the camera and the sun each frame and calls
  `update()` and `render()`.
  - `guest-entry.mjs`'s `SCRIPTS` list must stay in step with
    index.html's `nycAppScripts`, minus the app-only scripts
    (controllers, touch-controls, cameras, nyc-map, post-processing,
    main), then `guest.js`. `tests/guest.test.cjs` enforces it, so a
    script added to index.html goes into `SCRIPTS` too, unless it's
    app-only (then add it to the test's `APP_ONLY`).
  - The guest always runs on three's WebGL2 backend
    (`forceWebGL: true`), because NetGL records WebGL2.
  - The ground's code (the frame, `makeGround`, the lift, the drape, the
    lamps' lift, the demo hill) is js/ground.js, a classic script that
    both index.html and `SCRIPTS` load and that runs nothing at load
    (tests load it in `node:vm` with a stub of three that has only
    `Matrix4`: make any other three object on first use). guest.js and
    main.js only call it: don't copy ground code into either.
  - guest.html takes `?shadows=0` and `?extent=all` (the default,
    `manhattan`, leaves out the other boroughs and the harbour's water),
    `?lights=0` (no lamps, no ClusteredLighting), `?ground=demo`,
    `?view=aerial|street|park` and `?dpr=1`, and reads out fps, the frame
    time and the JS time in `update()` and `render()`. The app takes
    `?webgl` to force the WebGL2 backend in a browser with WebGPU,
    `?ground=demo` to drive over the demo hill (`&hill=<m>` its height,
    default 40, `&spread=<m>` its σ, default 1100), and `?ground=terrain`
    to drive over Manhattan's real ground (Terrarium tiles).
  - A material's own `mrtNode` replaces its colour output when it draws
    into a render target with no MRT, and WebGL2 then rejects the draw
    ("Active draw buffers with missing fragment shader outputs"). The
    guest has no MRT, so `prepareMaterials` drops every `mrtNode`.
  - The ground's lift moves vertices only, so `setGround()` splits the
    flat ground layers where the ground bends (THE GROUND,
    `drapeGroundLayers`). A new big flat layer at the street goes under
    `ManhattanCityGrid` or into `DRAPE_ROOTS`, or it cuts through hills.
  - Test the drape on real heights, not only the demo hill: real terrain
    bends everywhere, and the default 4 mm detail splits the island to
    metres (minutes, gigabytes). A host from afar passes `drape`
    (`{ tolerance, minEdge, maxCells, maxTriangles }`). Slivers (corners
    in a line, as the deck's triangulation leaves along straight shores)
    never ask for a split themselves: split for themselves they never
    settled, and the splitting looped for ever on real terrain.
  - What an option leaves out isn't built (`extent: 'manhattan'`: no
    boroughs; `shadows: false`: no shadow stand-ins; `crowds: false`: no
    pedestrians). `guest.stats.build` has each build step's ms and
    `guest.stats.drape` the last drape's.
  - A builder's scratch arrays outlive the build when anything made in
    the same function scope does (a material's TSL `Fn`, a returned
    `update()`): V8 keeps the whole scope. The waterfront's accumulators
    (city-grid.js `addMesh`) and the facade boxes (buildings.js
    `buckets`) held ~130 MB of plain arrays that way; they're emptied once
    copied into their geometry. Find such things with CDP
    `HeapProfiler.startSampling` / `stopSampling` over a load: it reports
    the live heap by allocation site.
  - A host that draws the guest into its own framebuffer (Cesium's
    `scene.externalRenderers`, js/guest-cesium.mjs
    `cesiumExternalRenderer`) needs `composite: true` and, under log
    depth, `logDepth: true` (js/guest.js, THE HOST'S FRAME). Without
    `composite`, WebGPURenderer's sRGB output draws into a target of its
    own and copies it over the whole screen with no depth, which blacks
    out the host's frame; without `logDepth` the city fails the depth
    test everywhere under Cesium's log depth. Anything that changes every
    material goes into `prepareMaterials`, the one pass before compile.
  - Depth goes in through a material's `setupDepth`, not its
    `depthNode`: three's shadow pass takes the material's `depthNode` for
    the shadow map (`_getShadowNodes` in three.webgpu.js), so a log
    `depthNode` would corrupt the cascades.
  - The headless Cesium harness (the fork's
    `Build/CesiumUnminified`, AWS Terrarium terrain through
    `CustomHeightmapTerrainProvider`, the city through
    `cesiumExternalRenderer`) takes 35–50 s to compile the city's
    programs on its first frame at 480×300, then 0.05–0.2 s a frame.
    Freeze the terrain (`RequestScheduler.maximumRequests = 0`) once the
    tiles settle, so frames repeat bit for bit.
  - The sun's cascades reach only 300–720 m from the camera
    (lighting.js `update`). A view whose ground starts farther away (a
    camera 450 m up pitched −11° meets the ground 2.3 km out) shows no
    shadows: frames with shadows on and off then differ only in noise.
- **The world frame:** 1 unit = 1 m, x = grid east, y = up, z = grid
  south (north is -z), origin at the centrelines of 5th Ave & 42nd St.
  It's the tangent plane at 40.75318°N, 73.98185°W on WGS84, turned
  29.02° with the street grid (tools/geo-base.mjs). `LL()` in
  boroughs.js, exported as `window.NYC.lonLatToWorld`, is the lon/lat
  to world map; guest.js's `makeGeoFrame()` inverts it and gives
  `worldToEnu`.
- **js/nyc-geodata.js is generated** by tools/build-geodata.mjs from
  `tools/data/` (`GEO_DATA=tools/data node --max-old-space-size=8192
  tools/build-geodata.mjs`). Never edit it by hand: change the tool or
  its data and rebuild.
- **The WebGL2 fallback.** Browsers without WebGPU, and the guest, run
  WebGPURenderer's WebGL2 backend. Two WebGPU-only paths broke there and
  are now guarded on `renderer.backend.isWebGPUBackend`:
  - storage instance matrices (main.js's swap to
    `StorageInstancedBufferAttribute`) drew the towers as streaks, so
    on WebGL2 the instance matrices stay vertex attributes;
  - the crowds read a storage buffer by index
    (`attributeArray(...).element(i)` in pedestrians.js) and smeared
    into a sheet, so on WebGL2 the `PeopleNear` and `PeopleFar` meshes
    are removed (the people still walk, undrawn).

  Anything new that uses storage buffers, compute or `attributeArray`
  random access needs a WebGL2 path or a guard on
  `renderer.backend.isWebGPUBackend`.
- **The app on a ground** (`index.html?ground=demo`, `&hill=`,
  `&spread=`, or `?ground=terrain`; js/ground.js THE APP ON THE GROUND):
  main.js makes `appGround` before the build (null without the parameter,
  and every use is `if (appGround)`), takes the layers before the culling
  set-up, awaits `attach()` (the lift, then the heights: the terrain's
  tiles load while the city builds) before the shaders compile, and calls
  `beforeRender(cameraSystem)` between the simulation and the render.
  Both grounds take one path; only the heights differ. Things to know:
  - The simulation, the physics, the colliders and the camera system all
    stay flat. Only the drawing is lifted: the lamps each frame, and the
    camera for the render only (cameras.js places it flat again each
    frame, before anything else reads it; traffic.js's `updateView` calls
    `camera.updateMatrixWorld()`, so the sim's frustum is the flat one).
  - Its ground differs from a host's: no globe's curve (the app's 60 km
    water plane is two triangles whose corners the curve would sink 70 m),
    `height0` at the flat land (the demo) or the deck's 2.2 m freeboard
    (the terrain, in metres above the sea, its bathymetry clamped to 0) so
    the shore and the water stay put, and a grid out to where the ground
    is 0 (the demo's grows with `spread`: 6.5 σ from the hill).
  - The ground is Manhattan's only (`manhattanMask`), for both grounds:
    the boroughs and New Jersey model relief of their own (the Palisades,
    Jersey City Heights, Governors Island), which real heights or a wide
    hill's tail under them would double. The George Washington Bridge is
    `userData.groundFixed` (no lift, no shadow stand-in): the flat city
    ramps its approach up to the real bluff's height already. Anything at
    or under the harbour's surface keeps its height (`SHORE_RAMP`), so a
    seawall's foot stays in the water as its top rises with the shore.
  - The app's ground is linear over its grid's triangles (makeGround
    `linear`; the GPU reads the cell's four texels, `map.load`), and its
    layers are cut along the grid's lines and diagonals
    (`conformTriangles`): exact, watertight, so the paint stays 12 mm over
    the deck on any slope. Don't go back to a tolerance drape for real
    terrain: celestiary's lean one (10 cm, 8 m, 1.5 M) left the deck more
    than 12 mm over the ground at 43% of the island, up to 29 m where its
    budget ran out, in 24 s; cut to the 40 m grid it's exact, ~3.0 M
    triangles. Cost is edge length times line density, not area: the
    sidewalks' strips and walls are most of it (20 m: 7.6 M, 30 m: 4.9 M,
    40 m: 3.0 M). The slabs' undersides at the deck (`dropUnder`, y ≤
    0.35 m, FrontSide only) are left out: cut they'd cost a quarter more,
    whole they'd stand over concave ground (the roof bug below). A drape
    lab in node (the layers' flat geometry dumped from a headless page,
    ground.js in `node:vm` with three.core.js) answers cost questions in
    seconds instead of a five-minute page load.
  - What isn't a ground layer rides the vertex lift: a building's foot is
    a chord between its corners, over the ground where it bends, so on the
    linear ground the buildings, landmarks, street furniture and boroughs
    (`skirtObjects`, `userData.groundSkirt`) sink their geometry's lowest
    vertices by 40 × the slope (≤ 12 m), and lit materials tilt their
    normals with the lift (the map's RGBA: offset and gradient). Assigning
    `normalLocal` inside a `positionNode` works (after instancing too);
    check `builder.geometry.hasAttribute('normal')` first or TSL warns.
  - With the tolerance drape (the guest's), every face of a ground layer
    in the band follows the ground, its underside too. An unsplit triangle
    is a chord of the hill: under the ground on the crown, but over it
    past σ, where the hill is concave. Central Park's extrusions had 4 km
    undersides that stood 4–11 m over Sheep Meadow and north of it, a
    roof at a driver's eye, and their shadow stand-ins shaded the meadow.
    The ground layers cast their own shadows (scene-culling.js skips
    `userData.flatGeometry`). To find such a layer, project each mesh's
    triangle under a point with each corner lifted, and compare that
    with the ground there plus its flat height. Look past the crown,
    where the hill is concave.
  - Terrarium (`s3.amazonaws.com/elevation-tiles-prod`) answers curl in
    the sandbox; in a headless probe serve the tiles from Node in
    `page.route` (Chromium doesn't trust the sandbox proxy's CA), with
    `access-control-allow-origin: *`, cached on disk. The car, the person
    and the bike can't go north of ~129th St (`findTeleportPosition`
    clamps to the detailed island): see Washington Heights by helicopter,
    or with a camera placed after `beforeRender`. Zoom 13 matches 14 and 15 over the
    island to 0.35 m RMS (the source is ~10 m); its pits and spikes (a
    38 m spike at Foley Square at zoom 14) go in a 3 × 3 median per tile.
  - It keeps the materials' `mrtNode`s (`prepareMaterials` `keepMRT`):
    the scene pass's MRT for SSR and bloom joins them.
  - `window.__NYC_APP.ground.stats` has the drape's numbers and
    `setGroundMs`; the `[init]` log line has a `ground` step.
  - The lift is the material's `positionNode`, which three applies after
    instancing (NodeMaterial.setupPosition: `instancedMesh()` assigns
    `positionLocal` from the instance matrix, an attribute on WebGL2 or a
    storage buffer on WebGPU), so it sees each instance's position on
    both backends.
- **Shade by height above the street with `NYC.deckPosition()`**, not
  `positionWorld`. In the guest every vertex is lifted onto the host's
  terrain (js/ground.js, THE GROUND), so `positionWorld.y` there is the
  lifted height. Patterns keyed to height above the deck (storeys,
  waterlines, lens colours, crevices) read `deckPosition()`, which takes
  the lift back off; in the app it is `positionWorld` itself. View
  vectors and distances keep `positionWorld`.
- **Headless checks in cloud sessions:**
  - Use Chromium on SwiftShader:
    `--use-angle=swiftshader --enable-unsafe-swiftshader`. Chromium is
    preinstalled (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`), so don't
    run `playwright install`. Playwright is global at
    `/opt/node-tools/node_modules/playwright`.
  - There's no WebGPU headless, so the app runs on the WebGL2 backend
    there. What you see headless is the fallback, not the WebGPU path.
  - jsDelivr is blocked by the sandbox proxy, but
    raw.githubusercontent.com isn't. Vendor three.js dev from
    `raw.githubusercontent.com/mrdoob/three.js/dev/`:
    `build/three.webgpu.js`, `build/three.tsl.js`,
    `build/three.core.js`, and the addons index.html imports, following
    their relative imports. Serve them with `page.route` in place of
    the jsDelivr URLs. Keep the vendored copy in the scratchpad, not
    the repo.
  - A full city frame (8–13M triangles with the shadow cascades) takes
    minutes on SwiftShader, and `page.screenshot` times out. Use small
    viewports (480×300 or less), shadows off where you can (guest.html
    `?shadows=0`), and read `canvas.toDataURL()` in the same task as
    the render. Put long runs in the background.
  - Pixel diffs of the app: seed `Math.random` in an init script (and
    reseed when the app's loop starts: the compile consumes a varying
    amount), freeze `performance.now` once ready and set
    `renderer._nodes.nodeFrame` `time` and `lastTime` (three's `time`
    node, the water and the clouds), and gate the loop's callback
    (wrap `WebGPURenderer.prototype.setAnimationLoop`, hooked from a
    setter on `window.NYC`) to run N frames with synthetic timestamps.
    Two builds then render bit for bit alike. `page.goto` with
    `waitUntil: 'commit'`: the load event waits on the city's build.
  - The app is ready when `window.__NYC_APP.ready` is true. The guest
    page exposes the guest as `window.__NYC_GUEST`. Read state with
    `page.evaluate` rather than inferring it from pixels.
  - three's own rAF loop (its `Animation`) advances the node frame and
    resets `renderer.info`. A probe that renders frames back to back
    without yielding to rAF renders stale ones: the shadow maps and a
    RenderPipeline's passes update once per node frame and are skipped.
    `await new Promise(requestAnimationFrame)` between frames.
  - To find the draws behind a GL error, wrap the
    `WebGL2RenderingContext.prototype` draw calls with a `getError()`
    after each, and `renderer.backend.draw` to know the render object
    (material, object, `context.renderTarget`) of each.
  - The guest's canvas is transparent where it draws nothing, and
    `toDataURL` gives unpremultiplied colours: composite a PNG over the
    page's background (#6f8fb8) before reading it, or faint additive
    effects show as saturated wedges.
  - To find what draws a bad region, render with one top-level group
    hidden at a time (`ManhattanCityGrid`, `ManhattanCityBlocks`,
    `ManhattanStreetDetails`, `ManhattanLandmarks`, `Boroughs`, ...).
    Raycasting can't see geometry placed in the vertex shader (the
    instanced crowds, the guest's ground lift).
- **Killing processes.** `pkill -f <pattern>` or `pgrep -f` inside a
  shell command whose own text contains the pattern matches that shell
  and kills it (exit 144). Kill by PID instead, e.g.
  `ps -eo pid,args | awk '$2=="node" && $3=="probe.mjs" {print $1}' | xargs -r kill`.
  Don't kill browser or server processes you didn't start.
- **Keep diffs to the app minimal and additive:** new files, and small
  guarded changes to the existing ones (an option with the old
  behaviour as its default, as `LightingSystem`'s `sky` and `fog`).
  That keeps merges from upstream mrdoob/slop-newyork easy.
- **Ask early for anything only the user can supply:** allowed hosts,
  repository settings, a real device to test on. Say exactly what's
  needed, and keep working on what doesn't depend on it.

## Verification and reporting

- **Serving:**
  - production is GitHub Pages at
    `https://pablo-mayrgundter.github.io/slop-newyork/`, deployed from
    `main` (`.github/workflows/pages.yml`);
  - each PR gets a preview at
    `https://pablo-mayrgundter.github.io/slop-newyork/pr-preview/pr-<n>/`
    (`.github/workflows/pr-preview.yml`, rossjrw/pr-preview-action).
- **Rendering changes need visual evidence:** screenshots, or the PR
  preview. Unit tests don't catch a shader that draws streaks.
- **Report what you couldn't verify**, and say why: no real GPU, no
  WebGPU headless (so the WebGPU path went untested), a host the
  sandbox denies. Name what the user should check on the preview, and
  in which browser (one with WebGPU, and one without for the fallback).

## Pull requests

- **Subscribe to PR activity on open.** Immediately after creating a
  pull request, subscribe to its activity stream, so CI failures and
  review comments arrive in the session. In Claude Code, use
  `subscribe_pr_activity` with the PR number, without being asked;
  where it's available, also schedule a check-in about an hour out, and
  cancel it once the PR merges. Investigate each event as it arrives:
  - fix small, clear issues directly;
  - ask before changes that are architecturally significant or
    ambiguous;
  - skip events that don't need action.
- **Merge only when the user says so.** A green PR waits for their
  go-ahead.
- **Keep the PR description current:** when later pushes change what the
  PR does or fixes, update the description to match.

## Recording what you learn

- **How a script works and why** goes in its header comment or the
  banner of the section it concerns, as the existing scripts do. If a
  topic outgrows that, start a doc and add it to the table above.
- **How to use the guest** (its options and frame) goes in README's
  *As a guest in another engine* and guest.js's header.
- **Findings about NetGL or a host engine** go in the portal repo's
  portal-netgl DESIGN.md.
- **Workflow tips** for future sessions go here, in *Working
  efficiently*.
