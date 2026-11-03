'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const source = path.resolve(__dirname, '../..');

function node(nodePath, code, args = []) {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    return execFileSync(nodePath, ['-e', code, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function prepareWorld(root, nodePath) {
    for (const name of ['scripts/saved-games.js', 'scripts/world-wipe.js', 'scripts/database-access.js', 'src/HistoryStore.js',
        'src/DatabaseRestore.js', 'src/DatabaseStatements.js', 'database/sql/sqlite.sql', 'database/sql/history.sql']) {
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(source, name), target);
    }
    fs.appendFileSync(path.join(root, 'config/local.ini'), '\n[Database]\npath = tmp/world-data.sqlite\nhistoryPath = tmp/world-history.sqlite\n');
    node(nodePath, `
        const fs = require('node:fs'), path = require('node:path');
        const { DatabaseSync } = require('node:sqlite');
        const root = process.argv[1];
        fs.mkdirSync(path.join(root, 'tmp'), {recursive:true});
        const world = new DatabaseSync(path.join(root, 'tmp/world-data.sqlite'));
        world.exec(fs.readFileSync(path.join(root, 'database/sql/sqlite.sql'), 'utf8'));
        world.exec("INSERT INTO world_meta VALUES ('historyToken', 'desktop-fixture'); INSERT INTO accounts VALUES ('bot_fixture','pw'),('player_fixture','pw');");
        world.exec("INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ) VALUES (11,'bot_fixture','Bot',0,0,100,100,0,0,0,0,0,0,0),(21,'player_fixture','Player',0,0,100,100,0,0,0,0,0,0,0)");
        world.close();
        const Store = require(path.join(root, 'src/HistoryStore.js'));
        const history = Store.open(path.join(root, 'tmp/world-history.sqlite'));
        Store.setMeta(history, Store.WORLD_TOKEN_KEY, 'desktop-fixture');
        for (const characterId of [11,21]) Store.APPLY.life_events(history, {characterId, events:[{eventType:'death',summary:'original',weight:1,createdAt:1}]});
        history.close();
    `, [root]);
}
function query(root, nodePath, sql, history = false) {
    return JSON.parse(node(nodePath, `
        const path = require('node:path');
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(path.join(process.argv[1], process.argv[3]));
        const result = db.prepare(process.argv[2]).all(); db.close();
        process.stdout.write(JSON.stringify(result));
    `, [root, sql, history ? 'tmp/world-history.sqlite' : 'tmp/world-data.sqlite']));
}
module.exports = { prepareWorld, query };
