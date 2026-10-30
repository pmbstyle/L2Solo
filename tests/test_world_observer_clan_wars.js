const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), vm = require('vm');
require('../src/Global');
const DB = invoke('Database'), War = invoke('GameServer/Clan/ClanWarRuntime'), Clans = invoke('GameServer/Clan/ClanService');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Ui = require('../src/WorldObserver/public/clanWars');
const { ClanWarDirector } = require('../src/GameServer/Clan/ClanWarDirector');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-observer-wars-'));
options.default.Database.path = path.join(dir, 'world.sqlite');
const changes = [], patch = (object, key, value) => { const old = object[key]; changes.push(() => { object[key] = old; }); object[key] = value; };
let server;
async function run() {
    DB.init();
    await DB.execute(["INSERT INTO clans(id,name,leaderId,level) VALUES (10,'Minions',1,3),(20,'StrongHold',16,4)"]);
    await Clans.reload();
    const at = Date.now();
    for (let n = 1; n <= 90; n++) await DB.execute([`INSERT INTO clan_war_events(fromClanId,toClanId,actorId,action,reason,createdAt)
        VALUES (10,20,1,'declare','manual',?)`, [at - (91 - n) * 60000]]);
    War.view.replace([{ fromClanId: 10, toClanId: 20, active: 1, revision: 1, declaredAt: at - 60000 },
        { fromClanId: 20, toClanId: 10, active: 1, revision: 2, declaredAt: at - 30000 }]);
    const operation = { id: 'test-war', clanId: 10, enemyClanId: 20, memberIds: [1, 2, 3], status: 'assembling',
        phase: 'traveling', targetSpotId: 'test', homeSpotId: 'home', livingMembers: 2, arrivalAt: at + 25000, expiresAt: at + 900000 };
    patch(Population, 'clanWars', { inspect: () => ({ active: true, plans: [{ clanId: 10,
        lastDecision: { accepted: true, action: 'declare', reason: 'repeated_clan_aggression', targetClanId: 20, at } }], operations: [operation] }) });
    patch(invoke('GameServer/Bot/Population/SpotProfiles'), 'findById', id => ({ id, name: id === 'test' ? 'Enemy farm' : 'Home farm' }));
    const execute = DB.execute; let reads = 0;
    patch(DB, 'execute', function (...args) { if (args[0][0].includes('FROM clan_war_events')) reads++; return execute.apply(this, args); });
    const Observer = invoke('WorldObserver/WorldObserverServer');
    server = http.createServer(Observer.route);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/observer/api/clans/wars`;
    const responses = await Promise.all([fetch(url), fetch(url)]);
    assert(responses.every(r => r.status === 200));
    const [snapshot, same] = await Promise.all(responses.map(r => r.json()));
    assert.equal(reads, 1, 'overlapping observers share one bounded history query');
    assert.deepEqual(snapshot, same);
    assert.equal(snapshot.events.length, 80); assert.equal(snapshot.events[0].id, 90); assert.equal(snapshot.events.at(-1).id, 11);
    assert.equal(snapshot.campaigns.operations[0].targetName, 'Enemy farm');
    assert.equal((await fetch(url, { method: 'POST' })).status, 405, 'the observer cannot change diplomacy');
    const script = await fetch(url.replace('/api/clans/wars', '/clanWars.js'));
    assert.equal(script.status, 200); assert((await script.text()).includes('WorldObserverClanWars'), 'the native server delivers the new UI module');
    assert.equal(Ui.summary(snapshot, 10).mutual, 1);
    assert.equal(Ui.relations({ declarations: snapshot.declarations.slice(0, 1) }, 20)[0].status, 'incoming');
    assert.equal(Ui.summary({ declarations: [] }, 10).label, 'At peace');
    assert.equal(Ui.summary(null, 10), null, 'unavailable data must not be described as peace');
    const html = Ui.render(snapshot, 10, { now: at, relative: () => '1m ago', time: () => '12:30' });
    assert(html.includes('At war') && html.includes('Traveling to the target') && html.includes('Arrival in 25s'));
    assert(html.includes('Enemy farm') && html.includes('2/3') && html.includes('War history'));
    const cooling = Ui.render({ ...snapshot, campaigns: { ...snapshot.campaigns, plans: [{ clanId: 10,
        ceasefires: { 20: { until: at + 3600000 }, 30: { until: at - 1 } } }] } }, 10, { now: at, time: () => '16:29' });
    assert(cooling.includes('Cooling off against') && cooling.includes('New declarations can still be answered.'));
    assert(cooling.includes('/observer/clans/20') && !cooling.includes('/observer/clans/30'), 'only the relevant unexpired opponent pause is shown');
    assert(Ui.render(snapshot, 20).includes('Incoming raid'), 'the defender sees an approaching expedition');
    assert(Ui.render(snapshot, 10, { error: 'offline' }).includes('Showing the last received'));
    const waiting = { ...snapshot, campaigns: { ...snapshot.campaigns, operations: [], assembly: {
        queue: [{ clanId: 10, enemyClanId: 20, members: 9, reason: 'party_capacity_wait', queuedAt: at - 300000 }] } } };
    const waitingHtml = Ui.render(waiting, 10, { time: () => '12:30' });
    assert(waitingHtml.includes('Roster ready · 9 members') && waitingHtml.includes('Waiting for a shared party slot'));
    assert(waitingHtml.includes('Priority held since 12:30') && waitingHtml.includes('No military parties deployed.'));
    assert(waitingHtml.includes('0 active'), 'a waiting roster is not a deployed expedition');
    assert(Ui.render({ ...snapshot, campaigns: { ...snapshot.campaigns, assembly: {
        readiness: [{ clanId: 10, reason: 'roster_not_ready' }] } } }, 10).includes('Waiting for a healer and two fighters'));
    const hostile = { ...snapshot, clans: [{ id: 20, name: '<img src=x onerror=alert(1)>' }],
        campaigns: { ...snapshot.campaigns, operations: [{ ...operation, targetName: '<script>evil()</script>' }] } };
    const safe = Ui.render(hostile, 10);
    assert(!safe.includes('<img') && !safe.includes('<script>') && safe.includes('&lt;img'), 'clan names and destinations are escaped');

    const World = invoke('GameServer/World/World');
    patch(World, 'registeredActorById', id => ({ actor: { fetchHp: () => id === 3 ? 0 : 100 },
        session: { spotRelocation: id === 1 ? { completesAt: at + 20000 } : null, pvpDefense: id === 2 ? {} : null } }));
    const director = new ClanWarDirector({ parties: { admitted: () => [{ partyId: 'hot-war', status: 'hot',
        memberIds: [1, 2, 3], stats: { warOperation: operation } }] }, life: { cachedState: () => null } });
    const live = director.inspect().operations[0];
    assert.equal(live.phase, 'fighting'); assert.equal(live.livingMembers, 2); assert.equal(live.arrivalAt, at + 20000);
    patch(World, 'registeredActorById', () => ({ actor: { fetchHp: () => 100 }, session: { spotRelocation: {} } }));
    assert.equal(director.inspect().operations[0].phase, 'traveling', 'visible movement reads the native travel owner');
    patch(World, 'registeredActorById', () => null);
    assert.equal(director.inspect().operations[0].livingMembers, null, 'an actor handoff must not be presented as a dead roster');

    const source = fs.readFileSync('src/WorldObserver/public/app.js', 'utf8');
    const code = source.slice(source.indexOf('async function loadClanWars('), source.indexOf('async function loadClanDirectory('));
    const state = { clanOpen: true, live: true, worldEpoch: 'one', clanWarLoadedAt: 0 };
    const calls = []; let rendered = 0, now = at;
    const context = vm.createContext({ state, document: { hidden: false }, Date: { now: () => now }, AbortController,
        window: { setTimeout: () => 1, clearTimeout() {} }, renderClans() {}, renderClanWars: () => { rendered++; },
        fetch: (url, options) => new Promise(resolve => calls.push({ url, options, resolve })) });
    vm.runInContext(code, context); const load = vm.runInContext('loadClanWars', context);
    const pending = load(); await load({ force: true }); assert.equal(calls.length, 1, 'slow requests cannot overlap');
    calls[0].resolve({ ok: true, json: async () => snapshot }); await pending;
    assert.equal(state.clanWars, snapshot); assert.equal(rendered, 1);
    await load(); assert.equal(calls.length, 1, 'polls are bounded to ten seconds');
    now += 10001; context.document.hidden = true; await load(); assert.equal(calls.length, 1);
    context.document.hidden = false; state.live = false; await load(); assert.equal(calls.length, 1);
    state.live = true; const stale = load(); state.worldEpoch = 'two';
    calls[1].resolve({ ok: true, json: async () => ({ declarations: [] }) }); await stale;
    assert.equal(state.clanWars, snapshot, 'a response from an old server epoch cannot replace the current snapshot');
    const failed = load(); calls[2].resolve({ ok: false, status: 503 }); await failed;
    assert.equal(state.clanWars, snapshot); assert(state.clanWarError, 'a failed poll retains the last known state with a stale notice');
    await load(); assert.equal(calls.length, 3, 'failures retain the same ten-second retry bound');
    console.log('Observer clan wars: bounded cached history, read-only API, directed diplomacy, expeditions, native phases, safe rendering and polling passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await new Promise(resolve => server ? server.close(resolve) : resolve());
    changes.reverse().forEach(restore => restore()); War.view.replace([]);
    await DB.close(); fs.rmSync(dir, { recursive: true, force: true });
});
