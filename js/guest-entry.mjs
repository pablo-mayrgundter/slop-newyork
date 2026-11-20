// js/guest-entry.mjs
// Loads Slop New York into any page as a guest (js/guest.js) and creates one:
//
//   const { createNYCGuest } = await import('https://<host>/slop-newyork/js/guest-entry.mjs');
//   const guest = await createNYCGuest({ canvas, context, width, height });
//   // each frame: guest.setView({ matrixWorld, projectionMatrix }); guest.update(dt); guest.render();
//
// The city is native ES modules (as index.html loads them): importing this module imports the guest and, through it, the
// city's modules and data from next to itself. They import three.js by bare names ('three/webgpu', 'three/tsl',
// 'three/addons/'), so the host's page maps those names to the three.js dev build index.html's import map pins, in an
// import map of its own; a page whose map serves another three.js gets that one.

import { createGuest } from './guest.js';

// options: those of createGuest (js/guest.js)
export async function createNYCGuest(options = {}) {
  return createGuest(options);
}
