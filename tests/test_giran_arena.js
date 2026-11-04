const assert = require('assert');

require('../src/Global');

const Arena = invoke('GameServer/World/GiranArena');
const ServerResponse = invoke('GameServer/Network/Response');
const SystemMessage = invoke('GameServer/Network/Response/SystemMessage');
const ArenaDuelService = invoke('GameServer/World/ArenaDuelService');
const die = invoke('GameServer/Actor/Generics/Die');
const DataCache = invoke('GameServer/DataCache');
const Actor = invoke('GameServer/Actor/Actor');
const BotSession = invoke('GameServer/Bot/BotSession');
const BotManager = invoke('GameServer/Bot/BotManager');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Database = invoke('Database');
const ArenaCombatRules = invoke('GameServer/World/ArenaCombatRules');
const ArenaBotAI = invoke('GameServer/World/ArenaBotAI');
const BotAI = invoke('GameServer/Bot/BotAI');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const World = invoke('GameServer/World/World');
const ReceivePacket = invoke('Packet/Receive');
const npcs = require('../data/Npcs/npcs.json');
const spawns = require('../data/Npcs/Spawns/spawns.json');

assert.ok(Arena.isInside(72496, 142272, -3800), 'arena lower corner should be playable');
assert.ok(Arena.isInside(73472, 143248, -3600), 'arena upper corner should be playable');
assert.ok(!Arena.isInside(73473, 143248, -3600), 'outside X must stop a fight');
assert.ok(!Arena.isInside(73472, 143248, -3599), 'outside Z must stop a fight');
assert.deepStrictEqual(Arena.RESTART, { locX: 73890, locY: 142656, locZ: -3778 });

const manager = npcs.find((npc) => Number(npc.selfId) === 8225);
assert.strictEqual(manager?.template?.name, 'Arena Manager');
assert.ok(spawns.some((group) => group.spawns.some((spawn) => Number(spawn.selfId) === 8225)));

const packet = SystemMessage(283);
const decoded = new ReceivePacket(packet).readD().readD();
assert.strictEqual(decoded.data[0], 283, 'entered combat zone id must use the C4 SystemMessage id');
assert.strictEqual(decoded.data[1], 0, 'arena notice has no substitution arguments');

const originalExecutePvPCombat = BotAI.executePvPCombat;
let arenaCombatDispatches = 0;
const arenaBusy = { towards: false, hits: false, casts: false };
const arenaAiDuel = {
    state: 'FIGHTING',
    playerSession: {},
    botSession: {},
    player: { state: { fetchDead: () => false } },
    bot: {
        state: {
            fetchDead: () => false,
            fetchTowards: () => arenaBusy.towards,
            fetchHits: () => arenaBusy.hits,
            fetchCasts: () => arenaBusy.casts
        }
    }
};
try {
    BotAI.executePvPCombat = () => { arenaCombatDispatches += 1; };
    ArenaBotAI.tick(arenaAiDuel);
    assert.strictEqual(arenaCombatDispatches, 1, 'an idle arena bot should start one combat action');
    for (const state of ['towards', 'hits', 'casts']) {
        arenaBusy[state] = true;
        ArenaBotAI.tick(arenaAiDuel);
        arenaBusy[state] = false;
    }
    assert.strictEqual(arenaCombatDispatches, 1,
        'arena polling must not overlap movement, native attack-speed loops, or skill casts');
} finally {
    BotAI.executePvPCombat = originalExecutePvPCombat;
}

// ReceivedHit passes the attacker's session into Die. Verify the arena hook
// receives the victim's authoritative session instead.
const originalOnPlayerDeath = ArenaDuelService.onPlayerDeath;
let deathSession = null;
ArenaDuelService.onPlayerDeath = (session) => {
    deathSession = session;
    return true;
};
DataCache.init();
const classInfo = DataCache.classTemplates.find((entry) => Number(entry.classId) === 0);
const victimSession = {
    accountId: 'arena_victim',
    dataSendToMe() {},
    dataSendToMeAndOthers() {},
    dataSendToOthers() {}
};
const attackerSession = { accountId: 'bot_arena_attacker', dataSendToMeAndOthers() {} };
const victim = new Actor(victimSession, {
    id: 2100000101,
    name: 'ArenaVictim',
    username: 'arena_victim',
    level: 20,
    exp: 0,
    sp: 0,
    hp: 100,
    mp: 100,
    sex: 0,
    classId: 0,
    locX: 72900,
    locY: 142700,
    locZ: -3778,
    head: 0,
    face: 0,
    hair: 0,
    hairColor: 0,
    title: '',
    karma: 0,
    pk: 0,
    pvp: 0,
    evalScore: 0,
    recRemain: 0,
    isGM: 0,
    isActive: 1,
    ...utils.crushOb(classInfo),
    items: [],
    paperdoll: utils.tupleAlloc(16, {})
});
victimSession.actor = victim;
try {
    die(attackerSession, victim);
} finally {
    ArenaDuelService.onPlayerDeath = originalOnPlayerDeath;
}
assert.strictEqual(deathSession, victimSession, 'arena death hook must use the victim session');

const bypassSession = { dataSendToMe() {} };
assert.strictEqual(
    ArenaDuelService.handleBypass(bypassSession, ['arena', 'menu']),
    false,
    'arena bypass must require the active Arena Manager NPC'
);

function actorModel(id, name, loc, items = []) {
    return {
        id,
        name,
        username: name.toLowerCase(),
        level: 20,
        exp: 0,
        sp: 0,
        hp: 100,
        mp: 100,
        cp: 100,
        sex: 0,
        classId: 0,
        locX: loc.locX,
        locY: loc.locY,
        locZ: loc.locZ,
        head: 0,
        face: 0,
        hair: 0,
        hairColor: 0,
        title: '',
        karma: 0,
        pk: 0,
        pvp: 0,
        evalScore: 0,
        recRemain: 0,
        isGM: 0,
        isActive: 1,
        isOnline: true,
        ...utils.crushOb(classInfo),
        items,
        paperdoll: utils.tupleAlloc(16, {})
    };
}

function playerSession(id, name, loc) {
    const session = {
        accountId: name.toLowerCase(),
        socket: { write() {} },
        fetchAccountId() { return this.accountId; },
        dataSendToMe() {},
        dataSendToOthers() {},
        dataSendToMeAndOthers() {}
    };
    session.actor = new Actor(session, actorModel(id, name, loc));
    session.activeNpcTalk = { selfId: 8225, objectId: 9908225 };
    return session;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function arenaLifecycleChecks() {
    const originalBotSessions = BotManager.sessions;
    const originalEveryState = LifeState.everyState;
    const originalExecute = Database.execute;
    const originalFetchItems = Database.fetchItems;
    const originalFetchSkills = Database.fetchSkills;
    const originalWorldUser = World.user;
    const originalNpcHtml = ServerResponse.npcHtml;
    let renderedHtml = '';
    const sourceSession = new BotSession('bot_arena_source');
    sourceSession.setActor(actorModel(9901001, 'HotArenaSource', Arena.NPC));
    sourceSession.actor.setPrivateStoreType(3);
    sourceSession.actor.setPrivateStore({
        storeType: 3,
        title: 'WTB Recipe: Test Sword',
        items: [{ selfId: 9999, count: 1, price: 1 }]
    });
    sourceSession.actor.model.manufactureShop = {
        type: 'dwarven',
        title: 'Test recipes',
        entries: [{ recipeId: 1, price: 1 }]
    };
    sourceSession.actor.state.setSeated(true);
    const player = playerSession(9901002, 'ArenaPlayer', Arena.NPC);

    try {
        World.user = { sessions: [], revision: 0 };
        ServerResponse.npcHtml = (_objectId, html) => {
            renderedHtml = html;
            return Buffer.alloc(0);
        };
        World.insertUser(player);
        BotManager.sessions = [sourceSession];
        LifeState.everyState = () => [];
        ArenaDuelService.render(player);
        assert(renderedHtml.includes('<edit var="arena_name"'),
            'the arena manager should expose nickname search');
        assert.strictEqual(ArenaDuelService.handleBypass(player, ['arena', 'search', 'hotarena']), undefined);
        assert(renderedHtml.includes('HotArenaSource'), 'partial nickname search should find a summonable bot');
        assert(renderedHtml.includes(`arena select ${sourceSession.actor.fetchId()}`),
            'nickname results should select the matching source bot by id');
        ArenaDuelService.handleBypass(player, ['arena', 'search', 'missing']);
        assert(renderedHtml.includes('No opponents match this filter.'),
            'nickname search should show an empty result instead of the default catalog');
        assert.strictEqual(await ArenaDuelService.select(player, sourceSession.actor.fetchId()), true);
        assert.strictEqual(ArenaDuelService.active.state, 'PREPARED');
        assert.strictEqual(ArenaDuelService.active.bot.fetchPrivateStoreType(), 0,
            'an arena clone must not inherit the source hot bot private-store type');
        assert.strictEqual(ArenaDuelService.active.bot.fetchPrivateStore(), null,
            'an arena clone must not expose the source hot bot store inventory');
        assert.strictEqual(ArenaDuelService.active.bot.model.manufactureShop, null,
            'an arena clone must not expose the source hot bot manufacture recipes');
        assert.strictEqual(ArenaDuelService.active.bot.state.fetchSeated(), false,
            'an arena clone of a merchant must spawn standing and combat-ready');
        assert.strictEqual(player.arenaDuelId, undefined, 'arena isolation starts only after entering');
        await wait(350);
        assert.strictEqual(ArenaDuelService.active?.state, 'PREPARED',
            'selecting at the outside manager must survive the monitor tick');

        assert.strictEqual(ArenaDuelService.handleBypass(player, ['arena', 'buff', 'full']), true);
        assert.strictEqual(EffectStore.list(player.actor).length, 0,
            'choosing a profile outside must not leak arena buffs into the world');

        player.actor.setLocXYZH({ locX: 73350, locY: 142760, locZ: -3778, head: 0 });
        await wait(350);
        assert.strictEqual(ArenaDuelService.active?.state, 'READY');
        assert.strictEqual(ArenaDuelService.active?.enteredArena, true);
        assert.strictEqual(player.arenaDuelId, ArenaDuelService.active?.id);
        assert(EffectStore.list(player.actor).length > 0, 'the selected buff profile applies on entry');

        assert.strictEqual(ArenaDuelService.begin(player), true);
        player.actor.setHp(Math.max(1, player.actor.fetchMaxHp() - 50));
        const hpBeforeRejectedHeal = player.actor.fetchHp();
        assert.strictEqual(ArenaDuelService.handleBypass(player, ['arena', 'heal']), false,
            'a stale manager bypass must be rejected inside the arena');
        assert.strictEqual(player.actor.fetchHp(), hpBeforeRejectedHeal);

        const botSummon = { fetchOwnerId: () => ArenaDuelService.active.bot.fetchId() };
        const playerSummon = { fetchOwnerId: () => player.actor.fetchId() };
        assert.strictEqual(ArenaCombatRules.canInteract(botSummon, player.actor), true,
            'an arena servitor must inherit the bot participant side');
        assert.strictEqual(ArenaCombatRules.canInteract(ArenaDuelService.active.bot, playerSummon), true,
            'a player servitor must inherit the player participant side');

        player.actor.state.setHits(true);
        player.actor.state.setCasts(true);
        ArenaDuelService.active.bot.state.setDead(true);
        await wait(350);
        assert.strictEqual(ArenaDuelService.active?.state, 'READY',
            'the finishing blow must reset the duel for another explicit .go');
        assert.strictEqual(player.actor.state.fetchHits(), false,
            'finishing-blow cleanup must release the player attack lock');
        assert.strictEqual(player.actor.state.fetchCasts(), false,
            'finishing-blow cleanup must release the player cast lock');
        assert.strictEqual(player.actor.state.isBlocked(), false,
            'the winner must be able to move immediately after the round');

        let deleteBroadcasts = 0;
        ArenaDuelService.active.botSession.dataSendToOthers = (packet) => {
            if (packet?.[0] === 0x12) deleteBroadcasts += 1;
        };
        // E291: a Silent Move flag left by an arena effect must not outlive the
        // duel reset that removes the effect.
        EffectStore.apply(player.actor, {
            key: 'silent_move', id: 221, type: 'buff', toggle: true, stats: { silentMoving: true }, durationMs: 0
        });
        player.actor.silentMoving = true;
        ArenaDuelService.release(player, 'test_release');
        assert.strictEqual(player.actor.silentMoving, false, 'duel release should clear the silent moving flag with the effect');
        assert.strictEqual(deleteBroadcasts, 1, 'clone deletion must be broadcast to every nearby real player');
        assert.strictEqual(EffectStore.list(player.actor).length, 0, 'arena-only buffs disappear on release');

        // E295: a drain toggle active before the duel is restored after it and
        // must keep draining MP (the restore re-applies the effect, not the ticker).
        // The release above returned the player outside the arena, so a new
        // duel has to enter from the manager again.
        player.actor.setLocXYZH({ ...Arena.NPC, head: 0 });
        EffectStore.apply(player.actor, {
            key: 'silent_move', id: 221, level: 1, name: 'Silent Move', type: 'buff', toggle: true,
            stats: { silentMoving: true }, durationMs: 0,
            manaDot: { toggle: true, damage: 7, intervalMs: 40 }
        });
        player.actor.silentMoving = true;
        assert.strictEqual(await ArenaDuelService.select(player, sourceSession.actor.fetchId()), true);
        player.actor.setLocXYZH({ locX: 73350, locY: 142760, locZ: -3778, head: 0 });
        await wait(350);
        assert.strictEqual(ArenaDuelService.active?.enteredArena, true, 'second duel should be entered');
        assert.strictEqual(EffectStore.list(player.actor).some((effect) => effect.key === 'silent_move'), false,
            'the toggle is cleared for the duel');
        ArenaDuelService.release(player, 'test_release_toggle');
        const restoredToggle = EffectStore.list(player.actor).find((effect) => effect.key === 'silent_move');
        assert(restoredToggle, 'the toggle is restored after the duel');
        assert.strictEqual(player.actor.silentMoving, true, 'restored Silent Move sets the flag again');
        assert(player.actor.effectTimers?.silent_move,
            'restored drain toggle must restart its MP drain ticker');
        player.actor.setMp(player.actor.fetchMaxMp());
        const mpAfterRestore = player.actor.fetchMp();
        await wait(150);
        assert(player.actor.fetchMp() < mpAfterRestore, 'restored drain toggle must cost MP over time');
        EffectStore.remove(player.actor, 'silent_move');
        invoke('GameServer/Effects/EffectTicker').clearAll(player.actor);
        player.actor.silentMoving = false;

        // E295: periodic non-toggle effects (hot, manaHot, dot, manaDot) active
        // before a duel are restored with their tickers, as the login restore does.
        player.actor.setLocXYZH({ ...Arena.NPC, head: 0 });
        const periodic = [
            { key: 'test_hot', id: 9001, name: 'Test HoT', hot: { heal: 5, intervalMs: 40, count: 500 } },
            { key: 'test_mana_hot', id: 9002, name: 'Test MP HoT', manaHot: { heal: 5, intervalMs: 40, count: 500 } },
            { key: 'test_dot', id: 9003, name: 'Test DoT', type: 'debuff', dot: { damage: 3, intervalMs: 40, count: 500 } },
            { key: 'test_mana_dot', id: 9004, name: 'Test MP DoT', type: 'debuff', manaDot: { damage: 1, intervalMs: 40, count: 500 } }
        ];
        periodic.forEach((effect) => EffectStore.apply(player.actor, { level: 1, type: 'buff', durationMs: 60000, ...effect }));
        assert.strictEqual(await ArenaDuelService.select(player, sourceSession.actor.fetchId()), true);
        player.actor.setLocXYZH({ locX: 73350, locY: 142760, locZ: -3778, head: 0 });
        await wait(350);
        assert.strictEqual(ArenaDuelService.active?.enteredArena, true, 'third duel should be entered');
        ArenaDuelService.release(player, 'test_release_periodic');
        periodic.forEach((effect) => {
            assert(EffectStore.list(player.actor).some((entry) => entry.key === effect.key),
                `${effect.key} is restored after the duel`);
            assert(player.actor.effectTimers?.[effect.key],
                `restored ${effect.key} must restart its periodic ticker`);
            assert.strictEqual(Object.keys(player.actor.effectExpiryTimers || {}).includes(effect.key), true,
                `restored ${effect.key} keeps its expiry timer`);
        });
        const ticker = invoke('GameServer/Effects/EffectTicker');
        ['test_dot', 'test_mana_dot'].forEach((key) => ticker.clear?.(player.actor, key));
        player.actor.setHp(Math.max(1, player.actor.fetchMaxHp() - 100));
        player.actor.setMp(Math.max(1, player.actor.fetchMaxMp() - 100));
        const hpBeforeHot = player.actor.fetchHp();
        const mpBeforeHot = player.actor.fetchMp();
        await wait(150);
        assert(player.actor.fetchHp() > hpBeforeHot, 'restored heal-over-time must heal');
        assert(player.actor.fetchMp() > mpBeforeHot, 'restored mana-heal-over-time must restore MP');
        periodic.forEach((effect) => EffectStore.remove(player.actor, effect.key));
        ticker.clearAll(player.actor);

        // A restored dot on a summon must stay inert: the self-damage path only
        // runs Die for ids >= 2000000, so a ticking summon would sit at 0 HP alive.
        {
            const SummonControl = invoke('GameServer/Npc/SummonControl');
            const FullBuff = invoke('GameServer/World/Generics/NpcBypasses/AdminFullBuff');
            const originalActiveSummon = SummonControl.activeSummon;
            const originalRefreshSummon = FullBuff.refreshSummon;
            let summonHp = 500;
            const summon = {
                fetchId: () => 1000777,
                fetchKind: () => 'Summon',
                fetchHp: () => summonHp,
                setHp: (value) => { summonHp = value; },
                fetchMaxHp: () => 500,
                state: { fetchDead: () => false }
            };
            try {
                player.actor.setLocXYZH({ ...Arena.NPC, head: 0 });
                assert.strictEqual(await ArenaDuelService.select(player, sourceSession.actor.fetchId()), true);
                player.actor.setLocXYZH({ locX: 73350, locY: 142760, locZ: -3778, head: 0 });
                await wait(350);
                assert.strictEqual(ArenaDuelService.active?.enteredArena, true, 'fourth duel should be entered');
                SummonControl.activeSummon = () => summon;
                FullBuff.refreshSummon = () => {};
                ArenaDuelService.active.playerSummonBefore = summon;
                ArenaDuelService.active.playerSummonEffectsBefore = [{
                    key: 'summon_poison', id: 9005, level: 1, name: 'Summon Poison', type: 'debuff',
                    expiresAt: Date.now() + 60000, dot: { damage: 3, intervalMs: 40, count: 500 }
                }];
                ArenaDuelService.release(player, 'test_release_summon');
                assert(EffectStore.list(summon).some((effect) => effect.key === 'summon_poison'),
                    'the summon effect is restored');
                assert.strictEqual(summon.effectTimers?.summon_poison, undefined,
                    'a restored dot must not tick on a summon');
                await wait(150);
                assert.strictEqual(summonHp, 500, 'a summon with a restored dot keeps its HP');
            } finally {
                SummonControl.activeSummon = originalActiveSummon;
                FullBuff.refreshSummon = originalRefreshSummon;
                invoke('GameServer/Effects/EffectTicker').clearAll(summon);
            }
        }

        BotManager.sessions = [];
        const coldCharacterId = 9902001;
        const weaponDefinition = DataCache.items.find((entry) => (
            String(utils.crushOb(entry).kind || '').startsWith('Weapon.')
        ));
        assert(weaponDefinition, 'the datapack must provide a weapon fixture');
        LifeState.everyState = () => [{
            characterId: coldCharacterId,
            name: 'ColdArenaSource',
            characterName: 'ColdArenaSource',
            level: 20,
            classId: 0,
            stats: { classId: 0 }
        }];
        Database.execute = async () => [actorModel(coldCharacterId, 'ColdArenaSource', Arena.NPC)];
        Database.fetchItems = async () => [{
            id: 700001,
            selfId: weaponDefinition.selfId,
            name: weaponDefinition.template?.name || 'Arena weapon',
            amount: 1,
            enchant: 0,
            equipped: 1,
            slot: 7,
            characterId: coldCharacterId
        }];
        Database.fetchSkills = async () => [];
        player.actor.setLocXYZH({ ...Arena.NPC, head: 0 });
        assert.strictEqual(await ArenaDuelService.select(player, coldCharacterId, { renderResult: false, validate: () => false }), false);
        assert.strictEqual(ArenaDuelService.active, null, 'expired native NPC authorization must not spawn a loaded clone');
        assert.strictEqual(await ArenaDuelService.select(player, coldCharacterId), true);
        assert(ArenaDuelService.active.bot.backpack.fetchItems().some((item) => (
            Number(item.fetchSelfId()) === Number(weaponDefinition.selfId)
        )), 'cold inventory rows must be hydrated before equipment filtering');
    } finally {
        ArenaDuelService.release(player, 'test_cleanup');
        BotManager.sessions = originalBotSessions;
        LifeState.everyState = originalEveryState;
        Database.execute = originalExecute;
        Database.fetchItems = originalFetchItems;
        Database.fetchSkills = originalFetchSkills;
        ServerResponse.npcHtml = originalNpcHtml;
        World.user = originalWorldUser;
    }
}

arenaLifecycleChecks().then(() => {
    console.log('Giran arena checks passed');
}).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
