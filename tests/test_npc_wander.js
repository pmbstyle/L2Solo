const assert = require('node:assert/strict');
const { mock } = require('node:test');
require('../src/Global');
const Wander = invoke('GameServer/Npc/NpcWander');
const Npc = invoke('GameServer/Npc/Npc');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Aggro = invoke('GameServer/Npc/NpcAggro');
const Effects = invoke('GameServer/Effects/EffectStore');
const Formulas = invoke('GameServer/Formulas');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const SkillModel = invoke('GameServer/Model/Skill');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const World = invoke('GameServer/World/World');
const NpcIndex = invoke('GameServer/World/NpcObjectIndex');
const Session = invoke('GameServer/Session');
const BotSession = invoke('GameServer/Bot/BotSession');
const Response = invoke('GameServer/Network/Response');
const exclusions = require('../data/Npcs/wander-exclusions.json');
const template = require('../data/Npcs/npcs.json').find(row => row.template.kind === 'Monster');
const originalGeo = Object.fromEntries(['hasGeo', 'getHeight', 'hasLineOfSight', 'getCellData', 'findPath'].map(key => [key, Geo[key]]));
const originals = { npc: World.npc, user: World.user };
const created = new Set();
let nextId = 8000000;
let assertions = 0;
function check(name, fn) { fn(); assertions++; console.log(`PASS ${name}`); }
function npcAt(extra = {}) {
    const npc = new Npc(nextId++, { ...utils.crushOb(template), selfId: 1, kind: 'Monster',
        title: '', name: 'Wander Test Monster', locX: 8, locY: 8, locZ: 0, head: 0,
        walk: 60, run: 180, hostile: false, ...extra });
    npc.spawnOrigin = { locX: npc.fetchLocX(), locY: npc.fetchLocY(), locZ: npc.fetchLocZ() };
    npc.spawnDefinition = { spawn: { coords: [{ ...npc.spawnOrigin }] }, bounds: [] };
    created.add(npc);
    return npc;
}
function observer(x = 8, extra = {}) {
    const packets = [];
    return { accountId: 'player', packets, actor: { fetchId: () => 12345,
        fetchLocX: () => x, fetchLocY: () => 8, fetchLocZ: () => 0,
        fetchIsOnline: () => true, state: { fetchDead: () => false } },
    dataSendToMe(packet) { packets.push(packet); },
    dataSendToMeAndOthers(packet) { packets.push(packet); }, ...extra };
}
function worldFor(npcs, observers = [observer()]) {
    World.user = { sessions: observers };
    World.npc = { spawns: npcs, grid: {}, gridKeys: new WeakMap() };
    NpcIndex.reset(World);
    for (const npc of npcs) World.addNpcToGrid(npc);
    return World;
}
function wireObserver() {
    const player = observer();
    player.knownNpcIds = new Set();
    player.packData = Session.prototype.packData;
    player.recordOutboundPacket = () => {};
    player.dataSendToMe = Session.prototype.dataSendToMe;
    player.socket = { write(packet) { player.packets.push(packet.subarray(2)); } };
    return player;
}
function stop(npc) { npc.destructor({ dataSendToMeAndOthers() {} }); }
const moveRandom = () => 0.75; // Fixed home +100,+100.
const rolls = values => { let index = 0; return () => values[index++ % values.length]; };

mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 10000 });
try {
    Geo.hasGeo = () => true;
    Geo.getHeight = () => 0;
    Geo.hasLineOfSight = () => true;
    Geo.findPath = () => { throw Error('idle wandering must never invoke A*'); };

    check('all sourced classes and quest monster IDs remain stationary even when flattened to Monster', () => {
        assert.equal(exclusions.revision, 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975');
        for (const reason of ['L2RaidBoss', 'L2GrandBoss', 'L2Minion', 'L2Chest', 'L2Guard',
            'L2SepulcherMonster', 'L2FestivalMonster', 'QuestMonster']) assert(exclusions.groups[reason]?.length, reason);
        const npc = npcAt();
        for (const [reason, ids] of Object.entries(exclusions.groups)) for (const id of ids) {
            npc.model.selfId = id;
            assert.equal(Wander.eligible(npc), false, `${reason} ${id}`);
        }
        npc.model.selfId = 1;
        assert.equal(Wander.eligible(npc), true);
    });

    check('runtime exclusions: towns, bosses, pets, minions, dynamic quests and disabled actors', () => {
        for (const data of [{ kind: 'Guard' }, { kind: 'Merchant' }, { kind: 'Boss' }, { raidBoss: true },
            { isSummon: true }, { isPet: true }, { title: 'Quest Monster' }, { questMonster: true },
            { isQuestMonster: true }, { walk: 0 }, { stateInvisible: true }]) assert.equal(Wander.eligible(npcAt(data)), false, JSON.stringify(data));
        for (const field of ['minionGroup', 'minionLeader', 'minionBossObjectId', 'questSpawn']) {
            const npc = npcAt(); npc[field] = {}; assert.equal(Wander.eligible(npc), false, field);
        }
        for (const setter of ['setDead', 'setCombats', 'setHits', 'setCasts', 'setTowards']) {
            const npc = npcAt(); npc.state[setter](true); assert.equal(Wander.eligible(npc), false, setter);
        }
        const npc = npcAt(); npc.spawnDefinition = null; assert.equal(Wander.eligible(npc), false);
    });

    check('Lisvus probability is 1/30 per visible idle mob, shared sectors do not double-roll', () => {
        let randomCalls = 0, rays = 0;
        Geo.hasLineOfSight = () => { rays++; return true; };
        const npc = npcAt();
        const world = worldFor([npc], [observer(), observer()]);
        assert.equal(Wander.tick(world, { random: () => { randomCalls++; return 1 / 30; } }), 0);
        assert.equal(randomCalls, 1); assert.equal(rays, 0);
        assert.equal(Wander.tick(world, { random: rolls([0, 0.75, 0.75]) }), 1);
        assert.equal(rays, 1);
        assert.equal(npc.state.fetchTowards(), 'wander');
        stop(npc);
    });

    check('no world scan, no idle timers, no geo work without real nearby observers', () => {
        let rays = 0;
        Geo.hasLineOfSight = () => { rays++; return true; };
        const npc = npcAt();
        const world = worldFor([npc], [observer(8, { accountId: 'bot_hot' })]);
        Object.defineProperty(world.npc, 'spawns', { get() { throw Error('full world scan'); } });
        assert.equal(Wander.tick(world, { random: () => 0 }), 0);
        world.user.sessions = [observer(30000)];
        assert.equal(Wander.tick(world, { random: () => 0 }), 0);
        world.user.sessions = [observer(8, { actor: { fetchIsOnline: () => false } })];
        assert.equal(Wander.tick(world, { random: () => 0 }), 0);
        world.user.sessions = [observer()]; npc.model.locZ = -3000;
        assert.equal(Wander.tick(world, { random: () => 0 }), 0);
        assert.equal(rays, 0); assert.equal(npc.automation.moveInterpolation, undefined);
        assert.equal(npc.automation.timer.action.timer, undefined);
    });

    check('hard geo budget under density, with a single visit per active sector and no A*', () => {
        let rays = 0, visits = 0;
        const selected = [];
        Geo.hasLineOfSight = x => { rays++; selected.push(x); return false; };
        const npcs = Array.from({ length: 2000 }, (_, i) => npcAt({ locX: 8 + i }));
        const world = worldFor(npcs, [observer(), observer(), observer()]);
        const sector = world.npc.grid['0_0'];
        Object.defineProperty(world.npc.grid, '0_0', { get() { visits++; return sector; } });
        assert.equal(Wander.tick(world, { random: rolls([0, 0.75, 0.75]) }), 0);
        assert.equal(visits, 1);
        assert.equal(rays, Wander.MAX_GEO_CHECKS);
        selected.length = 0;
        Wander.tick(world, { random: () => 0 });
        assert(selected.includes(npcs.at(-1).fetchLocX()), 'late sectors/candidates can win the reservoir under saturation');
    });

    check('one initial MoveToLocation, walking duration and authoritative interpolation/arrival', () => {
        Geo.hasLineOfSight = () => true;
        const npc = npcAt({ stateRun: true }); const player = observer(); const world = worldFor([npc], [player]);
        assert.equal(Wander.start(npc, world, [player], moveRandom), true);
        const movement = npc.automation.moveInterpolation;
        assert.equal(npc.fetchStateRun(), false);
        assert.equal(movement.duration, npc.automation.ticksToMove(8, 8, 0, 108, 108, 0, 0, 60));
        assert.deepEqual(player.packets.map(p => p[0]), [0x2e, 0x01]);
        assert.equal(player.packets[1].readInt32LE(5), 108);
        assert.equal(player.packets[1].readInt32LE(9), 108);
        mock.timers.tick(500);
        assert(npc.fetchLocX() > 8 && npc.fetchLocX() < 108);
        mock.timers.tick(movement.duration + 1);
        assert.deepEqual([npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ()], [108, 108, 0]);
        assert.equal(npc.state.inMotion(), false);
        assert.equal(npc.automation.moveInterpolation, null);
        assert.equal(player.packets.length, 2, 'no periodic movement packet spam');
    });

    check('late observer receives NpcInfo then the remaining route from its snapshot position', () => {
        const npc = npcAt(); const first = wireObserver(); const late = wireObserver();
        first.knownNpcIds.add(npc.fetchId());
        const world = worldFor([npc], [first, late]);
        Wander.start(npc, world, [first, late], moveRandom);
        assert.deepEqual(first.packets.map(p => p[0]), [0x01]);
        assert.equal(late.packets.length, 0, 'never send movement before a client knows the NPC');
        const movement = npc.automation.moveInterpolation;
        mock.timers.tick(500);
        const info = Response.npcInfo(npc);
        // Production lookup must use the index even for a late observer.
        Object.defineProperty(world.npc, 'spawns', { get() { throw Error('full NPC scan during visibility sync'); } });
        late.dataSendToMe(info);
        assert.deepEqual(late.packets.map(p => p[0]), [0x16, 0x01]);
        const route = late.packets[1];
        assert.equal(route.readInt32LE(1), npc.fetchId());
        assert.deepEqual([route.readInt32LE(5), route.readInt32LE(9), route.readInt32LE(13)], [108, 108, 0]);
        assert.deepEqual([route.readInt32LE(17), route.readInt32LE(21), route.readInt32LE(25)],
            [info.readInt32LE(13), info.readInt32LE(17), info.readInt32LE(21)]);
        assert(route.readInt32LE(17) > 8, 'resume the remaining route rather than its original beginning');
        assert.equal(first.packets.length, 1, 'a personal visibility refresh must not rebroadcast the route');
        assert.equal(npc.automation.moveInterpolation, movement, 'visibility must not restart the server route or timers');
        mock.timers.tick(movement.duration + 1);
        late.packets.length = 0;
        late.dataSendToMe(Response.npcInfo(npc));
        assert.deepEqual(late.packets.map(p => p[0]), [0x16], 'completed routes must not be replayed');
        assert.deepEqual(coordsOf(npc), [108, 108, 0]);
    });

    check('both real-player and bot broadcasts append motion after each recipient NpcInfo', () => {
        const visible = World.fetchVisibleRealPlayers;
        try {
            for (const sender of [Session, BotSession]) {
                const npc = npcAt(); const late = wireObserver(); const world = worldFor([npc], [late]);
                Wander.start(npc, world, [late], moveRandom);
                mock.timers.tick(500);
                World.fetchVisibleRealPlayers = () => [late];
                sender.prototype.dataSendToOthers.call({ accountId: 'bot_source', packData: sender.prototype.packData },
                    Response.npcInfo(npc), npc);
                assert.deepEqual(late.packets.map(p => p[0]), [0x16, 0x01], sender.name);
                assert.equal(late.packets[1].readInt32LE(17), late.packets[0].readInt32LE(13));
                stop(npc);
            }
        } finally { World.fetchVisibleRealPlayers = visible; }
    });

    check('cancelled, dead, removed and idle NPCs do not replay a stale walk after NpcInfo', () => {
        for (const scenario of ['cancelled', 'dead', 'removed', 'idle']) {
            const npc = npcAt(); const late = wireObserver(); const world = worldFor([npc], [late]);
            if (scenario !== 'idle') Wander.start(npc, world, [late], moveRandom);
            mock.timers.tick(500);
            if (scenario === 'cancelled') stop(npc);
            if (scenario === 'dead') npc.state.setDead(true);
            if (scenario === 'removed') world.removeNpcFromGrid(npc);
            late.dataSendToMe(Response.npcInfo(npc));
            assert.deepEqual(late.packets.map(p => p[0]), [0x16], scenario);
            stop(npc);
        }
    });

    check('combat cancels a walk immediately and no old arrival can teleport the mob', () => {
        const npc = npcAt(); const player = observer(); const world = worldFor([npc], [player]);
        Wander.start(npc, world, [player], moveRandom);
        mock.timers.tick(400);
        npc.enterCombatState(player, player.actor);
        assert.equal(npc.state.fetchCombats(), true);
        const stoppedAt = coordsOf(npc);
        assert.equal(npc.automation.moveInterpolation, null);
        assert.equal(npc.automation.timer.action.timer, undefined);
        assert(player.packets.some(p => p[0] === 0x47), 'StopMove must interrupt the client route');
        clearTimeout(npc.timer.combatStart); npc.timer.combatStart = undefined;
        mock.timers.tick(5000);
        assert.deepEqual(coordsOf(npc), stoppedAt);
        stop(npc);
    });

    check('control effects block starts and cancel an active route through the ordinary effect lifecycle', () => {
        const npc = npcAt(); const player = observer(); const world = worldFor([npc], [player]);
        Effects.apply(npc, { key: 'root', id: 102, durationMs: 60000, type: 'debuff' });
        assert.equal(Wander.start(npc, world, [player], moveRandom), false);
        Effects.remove(npc, 'root');
        assert.equal(Wander.start(npc, world, [player], moveRandom), true);
        mock.timers.tick(300);
        Effects.apply(npc, { key: 'root', id: 102, durationMs: 60000, type: 'debuff' });
        Restrictions.interruptOnApply(player, npc, { type: 'debuff' });
        assert.equal(npc.automation.moveInterpolation, null);
        const stoppedAt = coordsOf(npc);
        mock.timers.tick(5000);
        assert.deepEqual(coordsOf(npc), stoppedAt);
    });

    check('despawn/death cleanup stops all movement callbacks', () => {
        const npc = npcAt(); const world = worldFor([npc]);
        Wander.start(npc, world, world.user.sessions, moveRandom);
        mock.timers.tick(200); stop(npc);
        const stoppedAt = coordsOf(npc);
        assert.equal(npc.automation.timer.action.timer, undefined);
        mock.timers.tick(5000);
        assert.deepEqual(coordsOf(npc), stoppedAt);
    });

    check('spatial index follows a walk across a sector boundary during interpolation', () => {
        const npc = npcAt({ locX: 5990 }); const world = worldFor([npc], [observer(5990)]);
        assert.equal(Wander.start(npc, world, world.user.sessions, moveRandom), true);
        mock.timers.tick(500);
        assert(npc.fetchLocX() >= 6000);
        assert.equal(world.npc.grid['0_0'], undefined);
        assert(world.npc.grid['1_0'].includes(npc));
        stop(npc);
    });

    check('fixed coordinates stay anchored to spawn; distant returns use bounded steps', () => {
        const npc = npcAt();
        npc.model.locX = 100;
        assert.deepEqual(Wander.destination(npc, () => 0), { locX: -192, locY: -192, locZ: 0 });
        npc.model.locX = 10000;
        const to = Wander.destination(npc, moveRandom);
        assert(to.locX < 10000);
        assert(Math.hypot(to.locX - 10000, to.locY - 8) <= 401);
    });

    check('late movement cannot reinsert a removed NPC or populate a replacement world', () => {
        for (const replaceWorld of [false, true]) {
            const npc = npcAt({ locX: 5990 }); const world = worldFor([npc], [observer(5990)]);
            Wander.start(npc, world, world.user.sessions, moveRandom);
            if (replaceWorld) world.npc = { spawns: [], grid: {}, gridKeys: new WeakMap() };
            else world.removeNpcFromGrid(npc);
            mock.timers.tick(1000);
            assert.deepEqual(Object.keys(world.npc.grid), []);
            stop(npc);
        }
    });

    check('territory sampling stays within polygon, bounds each step, and cannot loop forever', () => {
        const npc = npcAt(); npc.spawnDefinition = { spawn: { coords: [] }, bounds: [
            { locX: 0, locY: 0 }, { locX: 1000, locY: 0 }, { locX: 1000, locY: 1000 }, { locX: 0, locY: 1000 }] };
        const to = Wander.destination(npc, () => 0.9);
        assert(to.locX >= 0 && to.locY >= 0 && to.locX < 1000 && to.locY < 1000);
        assert(Math.hypot(to.locX - 8, to.locY - 8) <= 201);
        // Degenerate polygon has no interior, and must stop after eight tries.
        npc.spawnDefinition.bounds = [{ locX: 0, locY: 0 }, { locX: 0, locY: 0 }, { locX: 0, locY: 0 }];
        let calls = 0;
        assert.equal(Wander.destination(npc, () => { calls++; return 0.5; }), null);
        assert.equal(calls, 16);
        npc.model.locX = 50; npc.model.locY = 50;
        npc.spawnDefinition.bounds = [[0, 0], [100, 0], [100, 200], [200, 200],
            [200, 0], [300, 0], [300, 300], [0, 300]].map(([locX, locY]) => ({ locX, locY }));
        assert.equal(Wander.destination(npc, rolls([250 / 300, 50 / 300])), null,
            'a route between two interior points must not cross outside a concave territory');
    });

    check('missing geodata and real NSWE walls/layers prevent cosmetic movement', () => {
        const npc = npcAt(); const player = observer(); const world = worldFor([npc], [player]);
        Geo.hasGeo = () => false;
        assert.equal(Wander.start(npc, world, [player], moveRandom), false);
        assert.equal(player.packets.length, 0);
        Geo.hasGeo = () => true;
        Geo.hasLineOfSight = originalGeo.hasLineOfSight;
        Geo.getCellData = (x, _y, z) => ({ z, nswe: x < 16 ? 14 : 13 });
        assert.equal(Wander.start(npc, world, [player], moveRandom), false, 'wall');
        Geo.getCellData = (_x, _y, z) => ({ z: z < 32 ? 0 : 3000, nswe: 15 });
        Geo.getHeight = () => 64;
        npc.spawnOrigin = { locX: -92, locY: -92, locZ: 0 };
        assert.equal(Wander.start(npc, world, [player], moveRandom), false, 'no XY move');
        npc.spawnOrigin = { locX: -76, locY: -92, locZ: 0 };
        Geo.getHeight = () => 3000;
        assert.equal(Wander.start(npc, world, [player], moveRandom), false, 'different floor');
        Geo.getHeight = () => 0;
        assert.equal(Wander.start(npc, world, [player], moveRandom), true, 'same floor');
        stop(npc);
    });

    check('overlapping observers receive one route each and unknown/out-of-range clients receive none', () => {
        Geo.hasLineOfSight = () => true;
        const npc = npcAt();
        const players = [observer(), observer(), observer(7000), observer(8, { knownNpcIds: new Set() })];
        const world = worldFor([npc], players);
        assert.equal(Wander.start(npc, world, players, moveRandom), true);
        assert.deepEqual(players.map(p => p.packets.length), [1, 1, 0, 0]);
        stop(npc);
    });

    check('concurrent cosmetic movement is bounded and cancellation frees slots on the shared tick', () => {
        const npcs = Array.from({ length: Wander.MAX_ACTIVE_WALKS + 1 }, () => npcAt({ walk: 1 }));
        const world = worldFor(npcs);
        let rays = 0;
        Geo.hasLineOfSight = () => { rays++; return true; };
        for (let i = 0; i < Wander.MAX_ACTIVE_WALKS; i++) {
            assert.equal(Wander.start(npcs[i], world, world.user.sessions, moveRandom), true);
        }
        assert.equal(Wander.start(npcs.at(-1), world, world.user.sessions, moveRandom), false);
        assert.equal(rays, Wander.MAX_ACTIVE_WALKS, 'no geo work when all movement slots are occupied');
        world.user.sessions = [];
        npcs.forEach(stop);
        Wander.tick(world); // Cleanup must work without observers as well.
        const player = observer(); world.user.sessions = [player];
        assert.equal(Wander.start(npcs.at(-1), world, [player], moveRandom), true);
        stop(npcs.at(-1));
    });

    check('shared ticker runs aggro before wandering without adding another timer', () => {
        const npc = npcAt({ hostile: true }); const player = observer(); const world = worldFor([npc], [player]);
        Geo.hasLineOfSight = () => true;
        let callback, timerCount = 0;
        const token = { unref() {} };
        Aggro.startAggroTicker(world, { setTicker(fn, delay) { callback = fn; timerCount++; assert.equal(delay, 1000); return token; } });
        Aggro.startAggroTicker(world, { setTicker() { throw Error('duplicate ticker'); } });
        callback();
        assert.equal(timerCount, 1);
        assert.equal(npc.state.fetchCombats(), true);
        assert.notEqual(npc.state.fetchTowards(), 'wander');
        stop(npc); delete world.npcAggroTicker;
    });
    check('a chase with no attack either way for 2 minutes ends: a hit refreshes it, hate alone does not', () => {
        const npc = npcAt({ hostile: true }); const player = observer(1000); const world = worldFor([npc], [player]);
        Geo.hasLineOfSight = () => true;
        // The player runs at the mob's speed: it never comes into reach.
        player.actor.fetchLocX = () => npc.fetchLocX() + 1000;
        Object.assign(player.actor, { fetchLevel: () => 40, fetchRadius: () => 8, fetchHead: () => 0, effects: {} });
        npc.enterCombatState(player, player.actor);
        mock.timers.tick(1100); // The start timer opens the chase loop.
        mock.timers.tick(99000);
        npc.addDamageHate(player, player.actor, 1, 1);
        mock.timers.tick(60000);
        const ultimateDefense = new SkillModel({ selfId: 110, name: 'Ultimate Defense', level: 1, passive: false, spell: true,
            distance: 0, target: 'self', hp: 0, mp: 0, power: 0, hitTime: 0, reuse: 0, buff: 30000 });
        const cast = C4SkillEffects.execute(player, player.actor, player.actor, ultimateDefense,
            { magicSkill: false, rng: () => 0, attack: { clearLoadedShot() {} } });
        assert(cast.aggroPointsApplied > 0, 'the self-buff reached the mob as hate');
        mock.timers.tick(59000);
        assert.equal(npc.state.fetchCombats(), true, 'being attacked refreshes the 2 minutes');
        mock.timers.tick(2000);
        assert.equal(npc.state.fetchCombats(), false, 'no attack for 2 minutes: the chase ends');
        assert.equal(npc.fetchMostHated(), null, 'its hate is dropped');
        npc.model.locX = 2000;
        world.user.sessions = [observer(2000)];
        assert.equal(Wander.tick(world, { random: () => 0.99 }), 1, 'no random-walk roll for a mob away from home');
        assert.equal(npc.state.fetchTowards(), 'wander');
        const to = Wander.destination(npc, () => 0.99);
        assert(to.locX < 2000 && to.locX >= 2000 - 401, 'it walks toward its spawn in bounded steps');
        stop(npc);
    });
    check('a mob swinging at a target that never fights back stays in the fight past 2 minutes', () => {
        const npc = npcAt({ hostile: true }); const player = observer(40); worldFor([npc], [player]);
        Geo.hasLineOfSight = () => true;
        player.actor.fetchRadius = () => 8;
        const calcHitChance = Formulas.calcHitChance;
        Formulas.calcHitChance = () => false;
        try {
            npc.enterCombatState(player, player.actor);
            for (let i = 0; i < 1300; i++) mock.timers.tick(100);
            assert.equal(npc.state.fetchCombats(), true);
        } finally { Formulas.calcHitChance = calcHitChance; stop(npc); }
    });
    check('a mob casting at a target out of its reach stays in the chase past 2 minutes', () => {
        const npc = npcAt({ hostile: true }); const player = observer(1000); worldFor([npc], [player]);
        Geo.hasLineOfSight = () => true;
        player.actor.fetchLocX = () => npc.fetchLocX() + 1000;
        npc.canUseCombatSkillOn = () => true;
        npc.attack.remoteHit = () => {};
        npc.enterCombatState(player, player.actor);
        mock.timers.tick(1100);
        mock.timers.tick(99000);
        npc.castSkill(player, player.actor, {});
        mock.timers.tick(119000);
        assert.equal(npc.state.fetchCombats(), true);
        mock.timers.tick(2000);
        assert.equal(npc.state.fetchCombats(), false);
        stop(npc);
    });
    check('a rooted mob keeps its chase past 2 minutes and drops it when it can move', () => {
        const npc = npcAt({ hostile: true }); const player = observer(1000); worldFor([npc], [player]);
        Geo.hasLineOfSight = () => true;
        player.actor.fetchLocX = () => npc.fetchLocX() + 1000;
        npc.enterCombatState(player, player.actor);
        mock.timers.tick(1100);
        Effects.apply(npc, { key: 'root', id: 102, type: 'debuff', durationMs: 300000 });
        mock.timers.tick(130000);
        assert.equal(npc.state.fetchCombats(), true);
        Effects.remove(npc, 'root');
        mock.timers.tick(200);
        assert.equal(npc.state.fetchCombats(), false);
        stop(npc);
    });
    check('a territory mob outside walks in on every tick, one inside keeps the roll', () => {
        const bounds = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]].map(([locX, locY]) => ({ locX, locY }));
        const inside = npcAt({ locX: 500, locY: 500 }), outside = npcAt({ locX: 2000, locY: 500 });
        for (const npc of [inside, outside]) npc.spawnDefinition = { spawn: {}, bounds };
        const world = worldFor([inside, outside], [observer(1500)]);
        Geo.hasLineOfSight = () => true;
        assert.equal(Wander.tick(world, { random: () => 0.99 }), 1);
        assert.equal(outside.state.fetchTowards(), 'wander');
        assert.notEqual(inside.state.fetchTowards(), 'wander');
        stop(inside); stop(outside);
    });
    console.log(`NPC wander: ${assertions} scenario groups passed`);
} finally {
    for (const npc of created) stop(npc);
    Object.assign(Geo, originalGeo);
    World.npc = originals.npc; World.user = originals.user;
    mock.timers.reset();
}

function coordsOf(npc) { return [npc.fetchLocX(), npc.fetchLocY(), npc.fetchLocZ()]; }
