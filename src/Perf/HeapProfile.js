'use strict';

const { frameOf } = require('./CpuProfile');

// Reads a V8 sampling heap profile (.heapprofile: a call tree whose nodes hold selfSize, V8's
// estimate of the bytes still alive that were allocated at that stack). The sampler runs from the
// recorder's start without a reset, so a later profile minus an earlier one is what the code kept
// in between: a leak shows as a function whose live bytes only grow. Pure; shared by the live
// recorder and scripts/perf.js.

const MB = 1048576;

// Live bytes per frame: self (allocated right there, native frames included) and code (project
// frames on the stack, each once, so a caller holds what its callees allocated).
function sizes(profile) {
    const self = new Map(), code = new Map();
    let total = 0;
    const stack = profile?.head ? [{ node: profile.head, keys: [] }] : [];
    while (stack.length) {
        const { node, keys } = stack.pop();
        const frame = frameOf(node.callFrame);
        const own = frame.project && !keys.includes(frame.key) ? [...keys, frame.key] : keys;
        const bytes = node.selfSize || 0;
        if (bytes) {
            total += bytes;
            self.set(frame.key, (self.get(frame.key) || 0) + bytes);
            for (const key of own) code.set(key, (code.get(key) || 0) + bytes);
        }
        for (const child of node.children || []) stack.push({ node: child, keys: own });
    }
    return { total, self, code };
}

const rows = (map, count) => [...map].sort((a, b) => b[1] - a[1]).slice(0, count)
    .map(([fn, bytes]) => ({ fn, mb: Math.round(bytes / MB * 10) / 10 }));

function summarize(profile, { top = 8 } = {}) {
    const s = sizes(profile);
    return { liveMb: Math.round(s.total / MB * 10) / 10, self: rows(s.self, top), code: rows(s.code, top) };
}

// What grew from profile a to profile b, largest first (a frame new in b grows from 0).
function diff(a, b, { top = 15 } = {}) {
    const before = sizes(a), after = sizes(b);
    const growth = (from, to) => {
        const delta = new Map();
        for (const key of new Set([...from.keys(), ...to.keys()])) delta.set(key, (to.get(key) || 0) - (from.get(key) || 0));
        return rows(new Map([...delta].filter(([, bytes]) => bytes > 0)), top);
    };
    return { beforeMb: Math.round(before.total / MB * 10) / 10, afterMb: Math.round(after.total / MB * 10) / 10,
        self: growth(before.self, after.self), code: growth(before.code, after.code) };
}

module.exports = { summarize, diff };
