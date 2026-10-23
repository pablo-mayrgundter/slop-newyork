// js/guest-entry.mjs
// Loads Slop New York into any page as a guest (js/guest.js) and creates one:
//
//   const { createNYCGuest } = await import('https://<host>/slop-newyork/js/guest-entry.mjs');
//   const guest = await createNYCGuest({ canvas, context, width, height });
//   // each frame: guest.setView({ matrixWorld, projectionMatrix }); guest.update(dt); guest.render();
//
// The city scripts are classic scripts sharing window.NYC (as index.html loads them); this module adds them to the
// page in order, from next to itself. three.js comes from options.three ({ THREE, TSL, Addons }, with the Addons
// index.html imports), or else from the page's import map ('three/webgpu', 'three/tsl', 'three/addons/'): a host
// whose page maps 'three' to another three.js passes its own copy of the dev build.

// The scripts index.html loads, without the app's own (the player's controllers, the camera rig, the map, the
// post-processing and main.js), then the guest. tests/guest.test.cjs keeps it in step with index.html.
const SCRIPTS = [
  'nyc-geodata.js',
  'city-config.js',
  'tsl-materials.js',
  'trees.js',
  'actor-models.js',
  'vehicle-lights.js',
  'pedestrians.js',
  'lighting.js',
  'city-grid.js',
  'boroughs.js',
  'buildings.js',
  'landmarks.js',
  'street-details.js',
  'road-network.js',
  'road-paint.js',
  'traffic.js',
  'scene-culling.js',
  'ground.js',
  'guest.js'
];

async function importThree() {
  const [THREE, TSL, bgu, sky, sun, sunNode, clustered] = await Promise.all([
    import('three/webgpu'),
    import('three/tsl'),
    import('three/addons/utils/BufferGeometryUtils.js'),
    import('three/addons/objects/SkyMesh.js'),
    import('three/addons/lights/SunLight.js'),
    import('three/addons/lights/SunLightNode.js'),
    import('three/addons/lighting/ClusteredLighting.js')
  ]);
  return {
    THREE,
    TSL,
    Addons: {
      mergeGeometries: bgu.mergeGeometries,
      mergeVertices: bgu.mergeVertices,
      SkyMesh: sky.SkyMesh,
      SunLight: sun.SunLight,
      SunLightNode: sunNode.SunLightNode,
      ClusteredLighting: clustered.ClusteredLighting
    }
  };
}

function loadScripts(version) {
  const base = new URL('./', import.meta.url);
  return Promise.all(SCRIPTS.map((name) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL(version ? `${name}?v=${version}` : name, base).href;
    s.async = false; // in order, as index.html
    s.onload = resolve;
    s.onerror = () => reject(new Error(`slop-newyork guest: failed to load ${s.src}`));
    document.head.appendChild(s);
  })));
}

let loading = null;

// options: those of createGuest (js/guest.js), and three ({ THREE, TSL, Addons }) and version (a cache-busting tag for
// the scripts' URLs)
export async function createNYCGuest(options = {}) {
  if (!loading) {
    loading = (async () => {
      const three = options.three || (await importThree());
      window.NYC = Object.assign(window.NYC || {}, three);
      await loadScripts(options.version);
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  await loading;
  return window.NYC.createGuest(options);
}

export { SCRIPTS };
