'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn, execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const WorldWipe = require('../scripts/world-wipe');
const HistoryStore = require('../src/HistoryStore');
const { acquireDatabaseAccess } = require('../scripts/database-access');

const root = path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'world-wipe-test-'));
const worldSchema = fs.readFileSync(path.join(root, 'database/sql/sqlite.sql'), 'utf8');

function fixture(file = ':memory:') {
    const world = new DatabaseSync(file);
    const history = HistoryStore.open(file === ':memory:' ? ':memory:' : HistoryStore.pathFor(file));
    world.exec(worldSchema);
    require('../src/GameServer/Social/InteractionMemoryRows').install(world);
    require('../src/GameServer/AfkTrade/TradeMeetingSchema').install(world);
    world.exec(`PRAGMA foreign_keys=ON;
        INSERT INTO accounts VALUES ('bot_test','pw'),('player_test','pw'),('empty_player','pw');
        INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES (11,'bot_test','Bot',0,0,100,100,0,0,0,0,0,0,0),(21,'player_test','Player',0,0,100,100,0,0,0,0,0,0,0);
        INSERT INTO clans(id,name,leaderId) VALUES (7,'BotClan',11),(8,'PlayerClan',21);
        UPDATE characters SET clanId=CASE id WHEN 11 THEN 7 ELSE 8 END;
        INSERT INTO interaction_owners VALUES (11,1,0),(21,1,0);
        INSERT INTO board_trade_participants(characterId) VALUES (11),(21);
        INSERT INTO history_outbox(kind,payload) VALUES ('life_events','{"characterId":11,"events":[{"eventType":"death","summary":"pending","weight":1,"createdAt":2}]}');`);
    for (const id of [11,21]) {
        HistoryStore.APPLY.life_events(history, { characterId: id,
            events: [{ eventType: 'death', summary: 'history', weight: 1, createdAt: 1 }] });
        HistoryStore.APPLY.market_store(history, { storeId: `store-${id}`, characterId: id, characterName: 'Test',
            storeType: 1, eventType: 'opened', reason: 'test', occurredAt: 1, openedAt: 1, itemsJson: '[]' });
        HistoryStore.APPLY.market_trade(history, { eventKey: `trade-${id}`, occurredAt: 1, channel: 'test',
            sourceType: 'test', selfId: 57, itemName: 'Adena', quantity: 1, unitPrice: 1, totalPrice: 1,
            sellerCharacterId: id, buyerCharacterId: id });
        HistoryStore.APPLY.clan_goal_event(history, { clanId: id === 11 ? 7 : 8,
            eventType: 'test', goalType: '', plan: '', reasonCode: '', payloadJson: '{}', occurredAt: 1 }, id);
    }
    history.exec("INSERT INTO economy_flow_hour VALUES (1,'test','inventory',57,1,1); INSERT INTO pvp_conflict_hour VALUES (1,'test','combat','win',1,0,0,0)");
    return { world, history, close() { world.close(); history.close(); } };
}

const count = (db, table) => Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
function drain(history, world) {
    for (;;) {
        const result = HistoryStore.transfer(history, world);
        assert.strictEqual(result.failed, 0, result.errors.join('; '));
        world.prepare('DELETE FROM history_outbox WHERE id<=?').run(result.upTo);
        if (!result.moved) return;
    }
}

function meeting(world) {
    world.exec(`INSERT INTO board_trade_meetings(id,token,terms,actorA,actorB,seqA,seqB,town,locX,locY,locZ,routeA,routeB)
        VALUES (1,'test','{}',11,21,1,1,'Giran',0,0,0,'[]','[]');
        UPDATE board_trade_participants SET meetingId=1;
        INSERT INTO board_trade_meeting_lines(meetingId,ordinal,payer,selfId,enchant,count,price,heldCount,name)
        VALUES (1,0,0,57,0,1,1,1,'Adena')`);
}

function testScopes() {
    assert.strictEqual(WorldWipe.validateScope('BOTS'), 'bots');
    assert.throws(() => WorldWipe.validateScope('characters'), /bots, players, or all/);
    for (const scope of ['bots','players','all']) {
        const f = fixture();
        try {
            if (scope === 'all') meeting(f.world);
            assert.deepStrictEqual(WorldWipe.wipeWithConnection(f.world, scope), {
                scope, characters: scope === 'all' ? 2 : 1, accounts: scope === 'bots' ? 1 : scope === 'players' ? 2 : 3
            });
            drain(f.history, f.world);
            for (const table of ['characters','interaction_owners','board_trade_participants']) {
                assert.strictEqual(count(f.world, table), scope === 'all' ? 0 : 1, table);
            }
            assert.strictEqual(count(f.world, 'history_outbox'), 0);
            assert.deepStrictEqual(f.world.prepare('PRAGMA foreign_key_check').all(), []);
            if (scope === 'all') {
                for (const table of [...HistoryStore.MOVED_TABLES,'clan_actions']) assert.strictEqual(count(f.history, table), 0, table);
            } else {
                const survivor = scope === 'bots' ? 21 : 11;
                assert(f.world.prepare('SELECT id FROM characters WHERE id=?').get(survivor));
                for (const [table,column] of [['bot_life_events','characterId'],['market_store_events','characterId'],['market_trades','sellerCharacterId']]) {
                    assert(f.history.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`).get(survivor));
                    assert.strictEqual(count(f.history, table), table === 'bot_life_events' && scope === 'players' ? 2 : 1,
                        'pending history must be retained only for surviving characters');
                }
                assert.strictEqual(count(f.history, 'clan_goal_events'), 1);
            }
        } finally { f.close(); }
    }
    const f = fixture();
    try {
        meeting(f.world);
        assert.throws(() => WorldWipe.wipeWithConnection(f.world, 'bots'), /Cancel active trades/);
        assert.strictEqual(count(f.world, 'characters'), 2, 'unsafe partial wipes must roll back');
        f.world.exec("UPDATE board_trade_meetings SET state='completed'; UPDATE board_trade_meeting_lines SET heldCount=0");
        WorldWipe.wipeWithConnection(f.world, 'bots');
        assert.strictEqual(count(f.world, 'board_trade_meetings'), 0);
        assert.strictEqual(f.world.prepare('SELECT meetingId FROM board_trade_participants WHERE characterId=21').get().meetingId, null);
    } finally { f.close(); }
}

function testRecovery() {
    const f = fixture();
    try {
        assert.throws(() => WorldWipe.wipeWithConnection(f.world, 'all', () => { throw new Error('history unavailable'); }),
            /World data was wiped, but history cleanup is pending: history unavailable/);
        assert.strictEqual(count(f.world, 'characters'), 0);
        assert.strictEqual(count(f.world, 'history_outbox'), 1, 'failed history cleanup must retain its reset instruction');
        f.history.exec("CREATE TRIGGER reject_wipe BEFORE DELETE ON bot_life_events BEGIN SELECT RAISE(ABORT,'injected failure'); END;");
        assert.throws(() => HistoryStore.transfer(f.history, f.world), /injected failure/);
        assert.strictEqual(HistoryStore.cursor(f.history), 0, 'failed reset must not advance the history cursor');
        assert.strictEqual(count(f.history, 'market_trades'), 2, 'history deletions must roll back together');
        f.history.exec('DROP TRIGGER reject_wipe'); drain(f.history, f.world);
        assert.strictEqual(count(f.history, 'bot_life_events'), 0);
        const id = f.world.prepare('INSERT INTO history_outbox(kind,payload) VALUES (?,?)').run('life_events',
            JSON.stringify({ characterId: 99, events: [{ eventType: 'death', summary: 'new world', weight: 1, createdAt: 3 }] })).lastInsertRowid;
        assert(Number(id) > HistoryStore.cursor(f.history), 'new events must stay above the preserved cursor');
        drain(f.history, f.world); assert.strictEqual(count(f.history, 'bot_life_events'), 1);
    } finally { f.close(); }
}

async function testUi(html) {
    const elements = new Map();
    const element = () => ({ value: '', textContent: '', className: '', disabled: false, handlers: {},
        classList: { contains: () => true }, querySelector: element, querySelectorAll: () => [],
        addEventListener(name, callback) { this.handlers[name] = callback; }, append() {}, replaceChildren() {} });
    let fail = true, finishRequest;
    const state = { phase: 'stopped', logs: [{ line: 'polled server log' }], lastWipe: { characters: 2, accounts: 3 } };
    const context = { document: {
        getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement: element
    }, window: { confirm: () => true }, setInterval() {}, fetch: async route => {
        if (route === '/api/wipe') {
            await new Promise(resolve => { finishRequest = resolve; });
            return fail ? { ok: false, text: async () => '{"error":"injected wipe error"}' } : { ok: true, json: async () => state };
        }
        return { ok: true, json: async () => route === '/api/saves' ? { saves: [] } : state };
    } };
    vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
    await new Promise(resolve => setImmediate(resolve));
    elements.get('wipeScope').value = 'all'; elements.get('wipeConfirmation').value = 'WIPE ALL';
    const failure = elements.get('wipe').handlers.click();
    assert.strictEqual(elements.get('wipe').disabled, true); assert.strictEqual(elements.get('start').disabled, true);
    finishRequest(); await failure;
    assert.strictEqual(elements.get('wipeMessage').textContent, 'injected wipe error');
    assert.strictEqual(elements.get('wipeMessage').className, 'error');
    assert.strictEqual(elements.get('log').textContent, 'polled server log', 'polling must not replace the wipe error');
    fail = false;
    const success = elements.get('wipe').handlers.click(); finishRequest(); await success;
    assert.strictEqual(elements.get('wipeMessage').textContent, 'Wiped 2 characters and 3 accounts.');
    assert.strictEqual(elements.get('wipeConfirmation').value, '');
}

async function testLauncherAndCli() {
    const file = path.join(directory, 'api.sqlite'); fixture(file).close();
    const config = path.join(directory, 'instance.ini');
    fs.writeFileSync(config, `[Database]\npath=${file}\n[AI]\nenabled=false\n`);
    const net = require('net');
    const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0,'127.0.0.1', () => {
        const port = server.address().port; server.close(() => resolve(port));
    }); });
    const env = { ...process.env, L2NODE_CONFIG_FILE: config, L2NODE_SHARED_CONFIG_FILE: '',
        L2NODE_RUNTIME_DIR: directory, L2NODE_LAUNCHER_PORT: String(port), L2NODE_NO_BROWSER: '1' };
    const child = spawn(process.execPath, ['scripts/start.js'], { cwd: root, env, stdio: 'ignore' });
    const request = (route,payload) => fetch(`http://127.0.0.1:${port}${route}`, payload === undefined ? {} : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    try {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            try { await request('/api/status'); ready = true; break; } catch (_) { await new Promise(resolve => setTimeout(resolve,30)); }
        }
        assert(ready, 'test launcher must become ready'); await testUi(await (await request('/')).text());
        assert.strictEqual((await request('/api/wipe', { scope: 'all', confirmation: '' })).status, 400);
        const release = acquireDatabaseAccess(file);
        try { assert.strictEqual((await request('/api/wipe', { scope: 'all', confirmation: 'WIPE ALL' })).status, 409); }
        finally { release(); }
        const response = await request('/api/wipe', { scope: 'all', confirmation: 'WIPE ALL' });
        assert.strictEqual(response.status, 200);
        const result = await response.json(); assert.deepStrictEqual([result.lastWipe.characters,result.lastWipe.accounts], [2,3]);
        const world = new DatabaseSync(file, { readOnly: true }), history = new DatabaseSync(HistoryStore.pathFor(file), { readOnly: true });
        try { assert.strictEqual(count(world,'characters'), 0); assert.strictEqual(count(history,'market_trades'), 0); }
        finally { world.close(); history.close(); }
        const cli = JSON.parse(execFileSync(process.execPath, ['scripts/world-wipe.js','--scope=all'], { cwd: root,env,stdio: ['ignore','pipe','ignore'] }));
        assert.deepStrictEqual(cli, { scope: 'all',characters: 0,accounts: 0 });
        assert.match(execFileSync(process.execPath, ['scripts/wipe-bots.js'], { cwd: root,env,stdio: ['ignore','pipe','ignore'] }).toString(), /Wiped 0 bot characters/);
    } finally {
        if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit',resolve)); child.kill(); await exited; }
    }
}

(async () => {
    try {
        testScopes(); testRecovery(); await testLauncherAndCli();
        console.log('world wipe: migrated schema, scopes, meeting references, history recovery, launcher UI/API and CLI ok');
    } finally { fs.rmSync(directory, { recursive: true,force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
