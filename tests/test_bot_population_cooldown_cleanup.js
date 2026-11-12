const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const BotManager = invoke('GameServer/Bot/BotManager');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const BotAI = invoke('GameServer/Bot/BotAI');
const Cooldown = invoke('GameServer/Bot/Population/Cooldown');
const ColdSimulationCoordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Actor = invoke('GameServer/Actor/Actor');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const FailureLog = require('../src/FailureLog');
const Data = invoke('GameServer/DataCache');

const originalUsers = World.user;
const originalSessions = BotManager.sessions;
const originalUpsertState = LifeState.upsertState;
const originalMarkHot = LifeState.markHot;
const originalStop = BotAI.stop;
const originalAcceptColdState = ColdSimulationCoordinator.acceptColdState;

async function run() {
    const chaotic = { actor: { fetchKarma: () => 45, state: { fetchDead: () => false } }, plan: 'hunting' };
    assert.strictEqual(Cooldown.canCooldown(chaotic, { ignoreVisibility: true }).ok, true);
    assert.strictEqual(Cooldown.canCooldown({ ...chaotic, pvpDefense: {} }, { ignoreVisibility: true }).reason, 'pvp_active');
    assert.strictEqual(Cooldown.canCooldown({ ...chaotic, pkProfile: {} }, { ignoreVisibility: true }).reason, 'pk_active');
    assert.strictEqual(Cooldown.canCooldown({ ...chaotic, plan: 'pk_hunting' }, { ignoreVisibility: true }).reason, 'pk_active');
    const packets = [];
    let destroyed = false;
    const botSession = {
        accountId: 'bot_ghost',
        actor: {
            fetchId: () => 481516,
            destructor() { destroyed = true; }
        }
    };
    const playerSession = {
        accountId: 'player',
        dataSendToMe(packet) { packets.push(packet); }
    };

    World.user = { sessions: [playerSession, botSession] };
    BotManager.sessions = [botSession];
    LifeState.upsertState = (state) => Promise.resolve(state);
    BotAI.stop = () => {};
    ColdSimulationCoordinator.acceptColdState = () => Promise.resolve({ ok: true, reason: 'test_ack' });

    const result = await Cooldown.transitionToColdState(botSession, {
        characterId: 481516,
        name: 'GhostBot'
    }, 'test_cleanup');

    assert.strictEqual(result.ok, true);
    assert.strictEqual(destroyed, true, 'the cooled bot should be destroyed on the server');
    assert.strictEqual(botSession.actor, null, 'the cooled bot should no longer have an active actor');
    assert.strictEqual(BotManager.sessions.includes(botSession), false, 'the cooled bot should leave the hot population');
    assert.strictEqual(packets.length, 1, 'players must receive a cleanup packet even when the bot is no longer visible');
    assert.strictEqual(packets[0][0], 0x12, 'the cleanup packet must be DeleteObject');
    assert.strictEqual(packets[0].readInt32LE(1), 481516, 'DeleteObject must identify the cooled bot');

    let fencedDestroyed = false;
    const fencedSession = {
        accountId: 'bot_fenced',
        actor: {
            fetchId: () => 481517,
            destructor() { fencedDestroyed = true; }
        }
    };
    BotManager.sessions = [fencedSession];
    World.user = { sessions: [playerSession, fencedSession] };
    ColdSimulationCoordinator.acceptColdState = () => Promise.resolve({ ok: false, reason: 'cold_worker_accept_timeout' });
    LifeState.markHot = () => Promise.resolve({ characterId: 481517, phase: 'hot' });
    const rejected = await Cooldown.transitionToColdState(fencedSession, {
        characterId: 481517,
        name: 'FencedBot'
    }, 'test_handoff_timeout');
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.reason, 'cold_worker_accept_timeout');
    assert.strictEqual(fencedDestroyed, false, 'actor must remain authoritative until the worker acknowledges cold handoff');
    assert(fencedSession.actor, 'failed handoff must keep the hot actor alive');
    assert(BotManager.sessions.includes(fencedSession), 'failed handoff must keep the session in the hot population');

    // A cooled bot's body has left the world: a timed buff it carried ends with
    // no packet about it to anyone around and no failure.
    Data.init();
    const sent = [];
    const buffedSession = { accountId: 'bot_buffed', dataSendToMe: (packet) => sent.push(packet),
        dataSendToOthers: (packet) => sent.push(packet), dataSendToMeAndOthers: (packet) => sent.push(packet) };
    buffedSession.actor = new Actor(buffedSession, { id: 481518, name: 'BuffedBot', title: '',
        ...utils.crushOb(Data.classTemplates.find((row) => row.classId === 0)), level: 20, hp: 100, mp: 100,
        locX: 0, locY: 0, locZ: 0, items: [], paperdoll: utils.tupleAlloc(16, {}) });
    const shield = EffectStore.apply(buffedSession.actor, { key: 'shield', id: 1040, level: 1, type: 'buff', durationMs: 40 });
    assert.strictEqual(EffectTicker.scheduleExpiry(buffedSession, buffedSession.actor, shield), true);
    BotManager.sessions = [buffedSession];
    World.user = { sessions: [playerSession, buffedSession] };
    ColdSimulationCoordinator.acceptColdState = () => Promise.resolve({ ok: true, reason: 'test_ack' });
    const failures = JSON.stringify(FailureLog.snapshot());
    assert.strictEqual((await Cooldown.transitionToColdState(buffedSession, { characterId: 481518, name: 'BuffedBot' },
        'test_buff_cleanup')).ok, true);
    sent.length = 0;
    packets.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepStrictEqual(sent, [], 'an expiring buff sends nothing about a cooled bot');
    assert.deepStrictEqual(packets, []);
    assert.strictEqual(JSON.stringify(FailureLog.snapshot()), failures, 'no failure when a cooled bot\'s buff ends');

    // A cooled bot's poison keeps ticking on its monster (C4: an effect outlives
    // its caster's stay in the world), but it is nobody's hit any more: the
    // monster is left alive at 1 HP, nobody is paid for a kill and the server
    // keeps running. A caster still there does not kill with it either: a
    // damage-over-time tick never takes the last HP point (Lisvus EffectDamOverTime).
    const Npc = invoke('GameServer/Npc/Npc');
    const Formulas = invoke('GameServer/Formulas');
    const monsters = [];
    const Generics = invoke(path.actor);
    const Quests = invoke('GameServer/Quest/QuestService');
    const regenTick = Formulas.REGEN_TICK_MS;
    Formulas.REGEN_TICK_MS = 200;
    const previous = [World.removeNpc, Generics.experienceReward, Quests.onKill, Quests.onAttack];
    const thrown = [], paid = [];
    const onUncaught = (error) => thrown.push(error);
    process.on('uncaughtException', onUncaught);
    try {
        World.removeNpc = () => {};
        Generics.experienceReward = (rewarded, actor) => paid.push(actor.fetchName());
        Quests.onKill = Quests.onAttack = async () => {};
        const poisoner = (id, name) => {
            const session = { accountId: `bot_${name}`, dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
            session.actor = new Actor(session, { id, name, title: '', ...utils.crushOb(Data.classTemplates.find((row) => row.classId === 0)),
                level: 20, hp: 100, mp: 100, locX: 0, locY: 0, locZ: 0, items: [], paperdoll: utils.tupleAlloc(16, {}) });
            session.actor.setIsOnline(true);
            return session;
        };
        const poisoned = (id, session) => {
            const monster = new Npc(id, { selfId: 900000, kind: 'Monster', name: 'Poisoned', title: '', level: 20, hostile: true,
                str: 1, dex: 30, con: 1, int: 1, wit: 1, men: 1, pAtk: 10, pAtkRnd: 0, pDef: 100, mAtk: 10, mDef: 100, accur: 4.75,
                atkSpd: 253, castSpd: 333, atkRadius: 40, walk: 60, run: 120, maxHp: 1000, maxMp: 100, revHp: 50, revMp: 0,
                corpseTime: 7, radius: 10, size: 20, weapon: 0, shield: 0, reuseTime: 0, exp: 1000, sp: 100,
                locX: 30, locY: 0, locZ: 0, head: 0 });
            monster.setHp(20);
            if (session) EffectTicker.applyDot(session, session.actor, monster, EffectStore.apply(monster, { key: 'poison', id: 129, level: 1,
                type: 'debuff', dot: { damage: 30, count: 3, intervalMs: 20 }, durationMs: 60 }));
            monsters.push(monster);
            return monster;
        };
        const cooledSession = poisoner(481519, 'CooledPoisoner'), stayingSession = poisoner(481520, 'StayingPoisoner');
        BotManager.sessions = [cooledSession, stayingSession];
        World.user = { sessions: [playerSession, cooledSession, stayingSession], revision: 0 };
        const left = poisoned(990001, cooledSession), fought = poisoned(990002, stayingSession);
        assert.strictEqual((await Cooldown.transitionToColdState(cooledSession, { characterId: 481519, name: 'CooledPoisoner' },
            'test_poison_cleanup')).ok, true);
        await new Promise((resolve) => setTimeout(resolve, 120));
        assert.deepStrictEqual(thrown, [], 'a poison tick of a cooled bot does not take the server down');
        assert.strictEqual(left.state.fetchDead(), false, 'the monster a cooled bot poisoned is not killed by the poison');
        assert.strictEqual(left.fetchHp(), 1, 'its poison still ticks, down to 1 HP');
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.ok(left.fetchHp() > 1, 'the hurt monster regenerates after the departed caster\'s poison, as after any hit');
        assert.strictEqual(fought.state.fetchDead(), false, 'a poisoner still in the world does not kill with its tick');
        assert.deepStrictEqual(paid, [], 'nobody is paid: no tick killed');

        // A monster's poison (its cast relay session, as Npc.castSkill builds it)
        // leaves a bot at 1 HP, alive.
        const victim = poisoner(2481521, 'PoisonedBot');
        victim.actor.setHp(50);
        const spider = { fetchId: () => 990003, fetchKind: () => 'Monster', fetchName: () => 'Poison Spider' };
        const relay = { actor: spider, dataSendToMe() {}, dataSendToMeAndOthers() {} };
        EffectTicker.applyDot(relay, spider, victim.actor, EffectStore.apply(victim.actor, { key: 'poison', id: 129, level: 1,
            type: 'debuff', dot: { damage: 30, count: 3, intervalMs: 20 }, durationMs: 60 }));
        // A cooled bot's poison on a sitting, sleeping player: the tick is nobody's
        // hit but the player's own rules hold: it stands up and wakes (Lisvus PcStatus).
        const pk = poisoner(2481522, 'CooledPk'), sleeper = poisoner(2481523, 'Sleeper');
        sleeper.accountId = 'player_sleeper';
        sleeper.actor.state.setSeated(true);
        EffectStore.apply(sleeper.actor, { key: 'sleep', id: 1069, level: 1, type: 'debuff', category: 'sleep', durationMs: 60000, stats: {} });
        EffectTicker.applyDot(pk, pk.actor, sleeper.actor, EffectStore.apply(sleeper.actor, { key: 'poison', id: 129, level: 1,
            type: 'debuff', dot: { damage: 10, count: 1, intervalMs: 40 }, durationMs: 40 }));
        monsters.push(victim.actor, sleeper.actor);
        BotManager.sessions = [pk];
        World.user.sessions.push(victim, pk, sleeper);
        assert.strictEqual((await Cooldown.transitionToColdState(pk, { characterId: 2481522, name: 'CooledPk' }, 'test_poison_cleanup')).ok, true);
        await new Promise((resolve) => setTimeout(resolve, 120));
        assert.strictEqual(victim.actor.state.fetchDead(), false, 'a monster\'s poison does not kill the bot');
        assert.strictEqual(victim.actor.fetchHp(), 1, 'it stops at 1 HP');
        assert.strictEqual(sleeper.actor.state.fetchSeated(), false, 'a departed caster\'s tick stands the player up');
        assert.ok(!EffectStore.list(sleeper.actor).some((effect) => effect.key === 'sleep'), 'and wakes it');
        assert.deepStrictEqual(thrown, [], 'no tick takes the server down');
    } finally {
        process.removeListener('uncaughtException', onUncaught);
        Formulas.REGEN_TICK_MS = regenTick;
        // A monster a tick left alive fights its poisoner back: end its fight with the test.
        monsters.forEach((monster) => (monster.fetchKind ? monster.destructor({ dataSendToMe() {}, dataSendToMeAndOthers() {} }) : monster.automation.stopReplenish()));
        [World.removeNpc, Generics.experienceReward, Quests.onKill, Quests.onAttack] = previous;
    }
}

run()
    .then(() => console.log('Bot population cooldown cleanup checks passed'))
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => {
        World.user = originalUsers;
        BotManager.sessions = originalSessions;
        LifeState.upsertState = originalUpsertState;
        LifeState.markHot = originalMarkHot;
        BotAI.stop = originalStop;
        ColdSimulationCoordinator.acceptColdState = originalAcceptColdState;
    });
