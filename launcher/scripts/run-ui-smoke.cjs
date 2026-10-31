'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2solo-desktop-ui-'));
const env = { ...process.env, L2SOLO_SMOKE_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
console.log(`Desktop UI artifacts: ${directory}`);
const result = spawnSync(require('electron'), ['.'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'inherit', timeout: 60000 });
if (result.error) console.error(result.error.message);
const report = path.join(directory, 'result.json');
const passed = result.status === 0 && fs.existsSync(report) && JSON.parse(fs.readFileSync(report, 'utf8')).passed === true;
if (!passed) console.error('Desktop UI test did not produce a successful report. Close other development launcher instances and try again.');
process.exitCode = passed ? 0 : 1;
