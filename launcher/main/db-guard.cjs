'use strict';

// Run under the bundled server Node.js, keeping SQLite out of Electron's ABI.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
let lock;
try {
    const filename = path.resolve(process.argv[2]);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const canonical = fs.existsSync(filename) ? fs.realpathSync(filename)
        : path.join(fs.realpathSync(path.dirname(filename)), path.basename(filename));
    lock = new DatabaseSync(`${canonical}.access.sqlite`);
    lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;');
    process.send({ type: 'ready' });
} catch (error) {
    process.send({ type: 'error', message: /locked|busy/i.test(error.message)
        ? 'This world is in use. Stop the server and any database operations before updating.' : error.message });
    process.exit(1);
}
function close() { lock?.close(); process.exit(0); }
process.on('message', close);
process.on('disconnect', close);
process.on('SIGTERM', close);
