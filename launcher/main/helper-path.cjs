'use strict';

const path = require('node:path');

function helperPath(filename) {
    // Electron understands ASAR paths; the standalone server Node.js does not.
    // These two helper scripts are explicitly unpacked by the application build.
    return path.join(__dirname.replace(/\.asar(?=[\\/])/, '.asar.unpacked'), filename);
}

module.exports = { helperPath };
