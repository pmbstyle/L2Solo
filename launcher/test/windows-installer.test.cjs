'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('installer build failures stay nonzero after Electron Builder async cleanup', () => {
    const script = path.resolve(__dirname, '../scripts/check-windows-installer.cjs');
    const result = spawnSync(process.execPath, ['-e', `
        const Module = require('node:module');
        require('async-exit-hook')(done => setTimeout(done, 1));
        const load = Module._load;
        Module._load = function(request, ...args) {
            if (request === 'electron-builder') return {
                build: async () => { throw new Error('injected installer build failure'); },
                Platform: { WINDOWS: { createTarget: () => new Map() } }, Arch: { x64: 1 }
            };
            return load.call(this, request, ...args);
        };
        require(${JSON.stringify(script)});
    `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000 });
    const directory = result.stdout?.match(/^Windows installer check artifacts: (.+)$/m)?.[1].trim();
    try {
        assert.equal(result.error, undefined);
        assert.match(result.stderr, /injected installer build failure/);
        assert.equal(result.status, 1, 'a rejected installer build must fail CI despite process.exit(0) in cleanup');
    } finally {
        if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
    }
});
