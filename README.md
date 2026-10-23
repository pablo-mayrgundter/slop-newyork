# Slop New York

A New York City simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore Manhattan on foot, by car, by bicycle, or by helicopter.

[Try it live](https://mrdoob.github.io/slop-newyork/)

## Make it your own

Fork it, remix it, improve it, break it. Make games, animations, films, experiments, or something completely different. Use it as a starting point and take it wherever you want. Have fun!

## As a guest in another engine

`js/guest-entry.mjs` loads the city into any page as a *guest*: no HUD, player, camera rig, sky, fog or post-processing,
on three.js's WebGL2 backend, drawn with a canvas and context you hand it (a [NetGL](https://github.com/pablo-mayrgundter/portal)
recorder, say) from a camera and sun you set each frame. [`guest.html`](guest.html) runs it on a page of its own.

```js
const { createNYCGuest } = await import('./js/guest-entry.mjs');
const guest = await createNYCGuest({ canvas, context, width, height }); // extent: 'manhattan' (default) or 'all'
await guest.compile();
// each frame
guest.setView({ matrixWorld, projectionMatrix }); // the camera in the city's frame, column-major
guest.setSun(sunDirection);                       // a THREE.Vector3 in the city's frame, y up
guest.update(dt);
guest.render();
```

The city's frame is metres, x = grid east, y = up, z = grid south, centred on 5th Ave & 42nd St. `guest.frame.worldToEnu`
takes it to east-north-up metres about `guest.frame.lon0, lat0` on WGS84, and `guest.frame.waterY` is the harbour's
surface (mean sea level). three.js comes from the page's import map (as in `index.html`), or pass
`three: { THREE, TSL, Addons }`.

## License and data

The project code is available under the [MIT License](LICENSE).

Geographic data: NYC Open Data and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Third-party data and dependencies retain their respective licenses.
