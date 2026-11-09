'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { confirmDatabaseRestore } = require('../main/database-recovery.cjs');
const { resolveDatabasePaths } = require('../../scripts/database-access.js');

test('server rejects a single file configured as both world and history', () => {
    assert.throws(() => resolveDatabasePaths(os.tmpdir(), { path: 'same.sqlite', historyPath: 'same.sqlite' }),
        /different database files/);
});

test('database recovery dialog offers yes/no and defaults to keeping current data', async () => {
    const window = {};
    const journal = { startupDatabasePaths: [{ canonicalPath: '/world/current.sqlite' }, { canonicalPath: '/world/current.history.sqlite' }] };
    for (const response of [0, 1]) {
        let shown = false;
        const result = await confirmDatabaseRestore({ async showMessageBox(parent, options) {
            shown = true;
            assert.equal(parent, window);
            assert.deepEqual(options.buttons, ['Yes, restore backup', 'No, keep current data']);
            assert.equal(options.defaultId, 1);
            assert.equal(options.cancelId, 1);
            assert.ok(options.detail.includes('/world/current.sqlite'));
            assert.ok(options.detail.includes('/world/current.history.sqlite'));
            return { response };
        } }, window, journal);
        assert.equal(shown, true);
        assert.equal(result, response === 0);
    }
});
