'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');

module.exports = function isolatedSocialDatabase(prefix, root = path.resolve(__dirname, '../..')) {
    const directory = path.join(os.tmpdir(), `${prefix}-${randomUUID()}`);
    fs.mkdirSync(directory);
    const world = path.join(directory, 'world.sqlite'), history = path.join(directory, 'history.sqlite');
    const ini = path.join(directory, 'fixture.ini');
    const defaults = fs.readFileSync(path.join(root, 'config/default.ini'), 'utf8');
    const sections = defaults.indexOf('[AuthServer]'); assert(sections > 0);
    fs.writeFileSync(ini, `[Database]\npath = ${world}\nhistoryPath = ${history}\n\n${defaults.slice(sections)}`);
    process.env.L2NODE_CONFIG_FILE = ini; delete process.env.L2NODE_SHARED_CONFIG_FILE;
    return { directory, world, history, ini, assertConfigured(configuration) {
        assert.equal(configuration.Database.path, world);
        assert.equal(configuration.Database.historyPath, history);
        assert.equal(process.env.L2NODE_CONFIG_FILE, ini);
        assert.equal(process.env.L2NODE_SHARED_CONFIG_FILE, undefined);
        console.log('Isolated native paths:', world, history);
    } };
};
