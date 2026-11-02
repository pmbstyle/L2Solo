'use strict';

const path = require('node:path');
const { prepareRuntime } = require('../main/runtime.cjs');

const version = require('../package.json').serverRuntimeVersion;
prepareRuntime(path.resolve(__dirname, '../runtime'), { version }).then(() => {
    console.log(`Bundled Node.js ${version} (${process.platform}/${process.arch})`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
