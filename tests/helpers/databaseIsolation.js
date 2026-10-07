'use strict';
// Preloaded by the runner before any game modules or worker threads. A typo
// in fixture configuration must fail before a native connection can write.
const path = require('node:path'), fs = require('node:fs');
const { fileURLToPath } = require('node:url');
const sqlite = require('node:sqlite');
const NativeDatabase = sqlite.DatabaseSync;
const root = path.resolve(__dirname, '../..');
const live = [path.join(root, 'tmp/nodel2.sqlite'), path.join(root, 'tmp/nodel2-history.sqlite')];
const resolved = value => {
    if (value === ':memory:') return value;
    const absolute = path.resolve(value instanceof URL ? fileURLToPath(value) : String(value));
    return fs.existsSync(absolute) ? fs.realpathSync(absolute) : absolute;
};
const protectedPaths = live.map(resolved);
class IsolatedDatabase extends NativeDatabase {
    constructor(filename, options = {}) {
        const target = resolved(filename);
        if (!options?.readOnly && protectedPaths.some(base => target === base || target.startsWith(base + '.'))) {
            throw Error(`Test isolation: refusing a writable connection to ${target}; configure an isolated database before initialization`);
        }
        super(filename, options);
    }
}
sqlite.DatabaseSync = IsolatedDatabase;
