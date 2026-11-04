'use strict';

// When a crashed worker thread is started again: 1, 2, 5, 10 s, then every
// 30 s, forever (a worker is never given up). A worker that stayed up 30 s was
// healthy, so its next crash starts from the first delay again.
// Callers (main thread): ColdSimulationCoordinator (the cold worker, up from
// its world load), PathfindingWorkerPool (each slot, up from its spawn).
const DELAYS_MS = Object.freeze([1000, 2000, 5000, 10000, 30000]);
const HEALTHY_MS = 30000;

// crashes: the crashes in a row before this one; upSince: when the crashed
// worker came up (0 when it never did). Returns the delay and the new run.
function next(crashes, upSince, now) {
    const run = upSince && now - upSince > HEALTHY_MS ? 0 : Math.max(0, Number(crashes) || 0);
    return { delayMs: DELAYS_MS[Math.min(run, DELAYS_MS.length - 1)], crashes: run + 1 };
}

module.exports = { next, DELAYS_MS, HEALTHY_MS };
