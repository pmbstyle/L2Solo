'use strict';

// The live recorder's own thread: a CPU chunk is parsed, analyzed and written here, not on main.
// A minute of the cold worker's profile is megabytes of JSON; parsed and analyzed on main it held
// turns of 200-400 ms (measured on the server, 2026-11-03), the very long turns the recorder looks
// for. Main hands over the text and gets the analysis back.

const fs = require('fs');
const { parentPort } = require('worker_threads');
const CpuProfile = require('./CpuProfile');

// prefix: the file path without its end; a kept chunk becomes <prefix>-<longest>ms.cpuprofile,
// text that does not parse <prefix>.unparsed.txt (when keepUnparsed).
parentPort.on('message', ({ id, text, since, longTurnMs, keepProfileMs, forced, prefix, keepUnparsed }) => {
    let parsed;
    try {
        parsed = CpuProfile.parse(text);
    } catch (error) {
        const unparsed = keepUnparsed ? `${prefix}.unparsed.txt` : null;
        if (unparsed) fs.writeFileSync(unparsed, text);
        parentPort.postMessage({ id, error: error.message, unparsed });
        return;
    }
    try {
        const analysis = CpuProfile.analyze(parsed.profile, { longTurnMs, since });
        // A starved chunk's longest run is the chunk itself: not a spike worth its file.
        const longest = analysis.starved ? 0 : analysis.longest?.ms || 0;
        const file = forced || longest >= keepProfileMs ? `${prefix}-${Math.round(longest)}ms.cpuprofile` : null;
        if (file) fs.writeFileSync(file, parsed.text);
        parentPort.postMessage({ id, analysis, endTime: parsed.profile.endTime || 0, file });
    } catch (error) {
        parentPort.postMessage({ id, error: error.message, unparsed: null });
    }
});
