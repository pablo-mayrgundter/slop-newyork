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
| The city as a guest in another engine (a NetGL guest of a globe) | README [As a guest in another engine](./README.md#as-a-guest-in-another-engine); [js/guest.js](./js/guest.js) (its header and the `THE FRAME ON THE EARTH`, `THE GROUND` and `THE GUEST` sections); [js/guest-entry.mjs](./js/guest-entry.mjs); [guest.html](./guest.html), its demo page |
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
- **Tests:** `node --test tests/*.cjs tests/*.mjs` (106 tests, about
  40 s). Plain `node --test tests/` fails, so use the globs. The tests
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
  - guest.html takes `?shadows=0` and `?extent=all` (the default,
    `manhattan`, leaves out the other boroughs and the harbour's water).
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
- **Shade by height above the street with `NYC.deckPosition()`**, not
  `positionWorld`. In the guest every vertex is lifted onto the host's
  terrain (js/guest.js, THE GROUND), so `positionWorld.y` there is the
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
  - The app is ready when `window.__NYC_APP.ready` is true. The guest
    page exposes the guest as `window.__NYC_GUEST`. Read state with
    `page.evaluate` rather than inferring it from pixels.
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
