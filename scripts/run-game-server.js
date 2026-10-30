'use strict';

const fs = require('fs');
const path = require('path');
const { releaseGeodataUsage } = require('./geodata-bootstrap');
const usageFile = process.env.L2NODE_GEODATA_USAGE_FILE;
delete process.env.L2NODE_GEODATA_USAGE_FILE;
let started = false;

process.on('exit', () => releaseGeodataUsage(usageFile));
function onDisconnect() { if (!started) process.exit(0); }
process.on('disconnect', onDisconnect);
function onMessage(message) {
    if (message?.type === 'shutdown' && !started) process.exit(0);
    if (message?.type !== 'geodata_ready' || started) return;
    const lease = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    if (lease.pid !== process.pid) throw new Error('NodeL2 cannot start without its own geodata lease');
    started = true;
    process.removeListener('message', onMessage);
    process.removeListener('disconnect', onDisconnect);
    require(path.resolve(__dirname, '../src/NodeL2'));
}
process.on('message', onMessage);
