'use strict';

// Database work runs under the bundled server Node.js, outside Electron's ABI.
const fs = require('node:fs');
const path = require('node:path');

async function main() {
    const root = path.resolve(process.argv[2]);
    const action = process.argv[3];
    const options = JSON.parse(process.argv[4] || '{}');
    const databasePath = path.resolve(options.databasePath);
    const savesDir = path.join(root, 'tmp/saves');
    const supported = ['scripts/saved-games.js', 'scripts/world-wipe.js', 'scripts/database-access.js', 'src/HistoryStore.js']
        .every(file => fs.existsSync(path.join(root, file)));
    if (!supported) {
        if (action !== 'list') throw new Error('Update this server to enable backups and world management.');
        return { supported: false, databaseExists: fs.existsSync(databasePath), backups: [] };
    }
    const SavedGames = require(path.join(root, 'scripts/saved-games.js'));
    const HistoryStore = require(path.join(root, 'src/HistoryStore.js'));
    const historyPath = HistoryStore.pathFor(databasePath, options.historyPath || '', root);
    const info = async () => ({ supported: true, databaseExists: fs.existsSync(databasePath),
        backups: await SavedGames.list(savesDir) });
    if (action === 'list') return info();
    let result;
    if (['create', 'load', 'delete'].includes(action)) {
        result = await SavedGames.run({ operation: action, databasePath, historyPath, savesDir,
            name: options.name, id: options.id });
    } else if (action === 'wipe') {
        const WorldWipe = require(path.join(root, 'scripts/world-wipe.js'));
        const scope = WorldWipe.validateScope(options.scope);
        if (options.confirmation !== `WIPE ${scope.toUpperCase()}`) throw new Error('Wipe confirmation does not match.');
        const { acquireDatabaseAccess } = require(path.join(root, 'scripts/database-access.js'));
        const release = acquireDatabaseAccess(databasePath);
        try { result = await WorldWipe.wipe(scope); } finally { release(); }
    } else throw new Error('Unknown world data operation.');
    return { ...await info(), result };
}

main().then(result => process.send({ type: 'result', result }), error => {
    process.send({ type: 'error', message: error.message });
    process.exitCode = 1;
}).finally(() => process.disconnect?.());
