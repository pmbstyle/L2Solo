'use strict';

const { performance } = require('node:perf_hooks');
const yieldToLoop = require('../../EventLoopTurn');

// One generator step is one candidate or relationship check. A time budget
// plus a step cap also bounds cheap work when the clock barely advances.
async function run(steps, { current = () => true, now = () => performance.now(), yieldNow = yieldToLoop,
    sliceMs = 2, maxSteps = 32, onSlice } = {}) {
    sliceMs = Math.max(.25, Number(sliceMs) || 2);
    maxSteps = Math.max(1, Math.floor(Number(maxSteps) || 32));
    let started = now(), units = 0;
    try {
        while (current()) {
            const next = steps.next();
            units++;
            const elapsed = now() - started;
            if (next.done) {
                onSlice?.({ ms: elapsed, steps: units, done: true });
                return next.value;
            }
            if (units >= maxSteps || elapsed >= sliceMs) {
                onSlice?.({ ms: elapsed, steps: units, done: false });
                await yieldNow();
                if (!current()) break;
                started = now(); units = 0;
            }
        }
        return null;
    } finally {
        steps.return?.();
    }
}

module.exports = { run, yieldToLoop };
