const assert = require('assert');
require('../src/Global');
const Competition = invoke('GameServer/Bot/AI/BotMobCompetition');
const InteractionMemory = invoke('GameServer/Social/InteractionMemoryRuntime');
const MemoryPolicy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const originalEnqueue = InteractionMemory.events.enqueue;
const memories = [];
InteractionMemory.events.enqueue = event => { memories.push(event); return true; };
const Revenge = invoke('GameServer/Bot/AI/BotRevenge');
const Defense = invoke('GameServer/Bot/AI/BotPvpDefense');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const World = invoke('GameServer/World/World');
const Budget = invoke('GameServer/Bot/AI/BotPvpChat');
const Response = invoke('GameServer/Network/Response');
const BotAI = invoke('GameServer/Bot/BotAI');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
const Attack = invoke('GameServer/Actor/Attack');
const Formulas = invoke('GameServer/Formulas');
let now = Date.now(), serial = 2200000;
function character(bot = true, level = 40) {
    const a = { id: serial++, x: 0, hp: 100, mp: 100, level, gear: 100000, flag: 0, dead: false, clan: 0, effects: {},
        fetchId() { return this.id; }, fetchName() { return `actor_${this.id}`; }, fetchLevel() { return this.level; },
        fetchClassId: () => 0, fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchHp() { return this.hp; }, fetchMaxHp: () => 100, fetchMp() { return this.mp; }, fetchMaxMp: () => 100,
        fetchPvpFlag() { return this.flag; }, fetchKarma: () => 0, fetchClanId() { return this.clan; },
        fetchIsOnline: () => true, isDead() { return this.dead; }, unselect() {}, select() {},
        state: { fetchDead: () => a.dead, fetchSeated: () => false, fetchCasts: () => false, fetchHits: () => false,
            fetchTowards: () => false, setHits() {}, setCasts() {} },
        automation: { abortAll() {} },
        skillset: { fetchSkills: () => [] },
        backpack: { fetchItems: () => [{ fetchEquipped: () => true, fetchSelfId: () => 999999, fetchPrice: () => a.gear }] }
    };
    a.session = { actor: a, aiActive: bot, accountId: bot ? `bot_${a.id}` : 'player', plan: 'hunting',
        persona: { traits: { caution: 0.3, assertiveness: 0.8, empathy: 0.4, resilience: 0.8 } },
        dataSendToOthers(packet) { events.push(['chat', a.id, packet]); } };
    if (bot) InteractionMemory.accept(MemoryPolicy.empty(a.id));
    return a;
}
const events = [];
function setup(contenderBot = false) {
    const bot = character(), rival = character(contenderBot, 10);
    const mob = { id: serial++, fetchId() { return this.id; }, fetchKind: () => 'Monster',
        fetchHp: () => 100, state: { fetchDead: () => false }, fetchLocX: () => 20, fetchLocY: () => 0, fetchLocZ: () => 0 };
    bot.session.currentTargetId = mob.id;
    World.user.sessions.push(bot.session, rival.session);
    return { bot, rival, mob };
}
const original = { peace: utils.isInPeaceZone, world: World.user, canSend: Budget.canSend, record: Budget.record,
    speak: Response.speak, promote: BotAI.promoteForPlayerInteraction, support: Tactics.support,
    control: Tactics.control, potions: Potions.tryUseInCombat, hitChance: Formulas.calcHitChance,
    skillStarted: Response.skillStarted, duration: Response.skillDurationBar };
try {
    utils.isInPeaceZone = x => x === 99999;
    World.user = { sessions: [] };
    Budget.canSend = () => true; Budget.record = () => {};
    Response.speak = (_actor, data) => data;
    BotAI.promoteForPlayerInteraction = session => events.push(['wake', session.actor.id]);
    Tactics.support = Tactics.control = Potions.tryUseInCombat = () => false;
    const f = setup();
    Competition.record(f.bot, f.mob, now);
    assert(Competition.record(f.rival, f.mob, now + 1, () => 0));
    assert.strictEqual(f.bot.session.pvpRevenge.reason, 'mob_competition');
    assert.strictEqual(events[0][0], 'chat');
    assert.strictEqual(events[0][2].kind, 0, 'warning addresses the rival in local chat');
    const ai = { executePvPCombat(_s, actor, target) { events.push(['attack', actor.id, target.id]); } };
    Defense.tick(f.bot.session, f.bot, {}, ai, { now: now + 2, rng: () => 0 });
    assert(events.some(e => e[0] === 'attack' && e[2] === f.rival.id), 'the normal PvP combat loop executes the decision');
    assert(!new Attack().blockedPvpDefense(f.bot.session, f.bot, f.rival));
    assert(!Revenge.allows(f.bot.session, character(false)), 'competition authorizes only the actual rival');
    const helper = character();
    f.bot.session.coldLifeState = helper.session.coldLifeState = { party: { partyId: 'competition_party' } };
    World.user.sessions.push(helper.session);
    assert(!helper.session.pvpRevenge);
    Threats.record(f.rival, f.bot, now + 3);
    assert.strictEqual(helper.session.pvpRevenge, f.bot.session.pvpRevenge, 'party joins after the first hostile action');

    const second = setup(true);
    Competition.record(second.rival, second.mob, now);
    assert(!Competition.record(second.bot, second.mob, now + 1, () => 0), 'a bot joining another attacker cannot claim first attack');
    assert(!second.bot.session.pvpRevenge);
    const botRival = setup(true);
    botRival.bot.session.plan = 'following';
    Competition.record(botRival.bot, botRival.mob, now);
    assert(Competition.record(botRival.rival, botRival.mob, now + 1, () => 0), 'companions also react to competing bots');

    const calm = setup();
    Competition.record(calm.bot, calm.mob, now);
    const before = events.length;
    assert(!Competition.record(calm.rival, calm.mob, now + 1, () => 0.99));
    for (let i = 2; i < 502; i++) assert(!Competition.record(calm.rival, calm.mob, now + i, () => 0));
    assert.strictEqual(memories.filter(event => event.sourceId === calm.bot.id).length, 1, '500 swings produce one social episode even without a PvP attack');
    assert.strictEqual(events.length, before + 1, '500 more swings cannot reroll refusal or repeat the warning');
    const nextMob = { ...calm.mob, id: serial++ };
    calm.bot.session.currentTargetId = nextMob.id;
    Competition.record(calm.bot, nextMob, now + 502);
    assert(!Competition.record(calm.rival, nextMob, now + 503, () => 0), 'cooldown also applies across mobs');

    const aggressive = character(), gentle = character();
    aggressive.session.persona.traits = { assertiveness: 0.9, empathy: 0.1, caution: 0.1 };
    gentle.session.persona.traits = { assertiveness: 0.1, empathy: 0.9, caution: 0.9 };
    assert(Competition.attackChance(aggressive.session, gentle) > Competition.attackChance(gentle.session, aggressive) * 10);
    // Same accepted claim and same roll; only previously committed memory differs.
    for (const variant of ['neutral', 'grievance', 'friendly', 'unloaded']) {
        const x = setup();
        if (variant === 'unloaded') InteractionMemory.forget(x.bot.id);
        if (['grievance', 'friendly'].includes(variant)) {
            const remembered = MemoryPolicy.apply(MemoryPolicy.empty(x.bot.id), {
                key: `prior-${variant}`, sourceId: x.bot.id, targetId: x.rival.id,
                type: variant === 'grievance' ? 'mob_contested' : 'resources_received', at: now - 600001
            }, now).snapshot;
            InteractionMemory.accept(remembered);
        }
        const chance = Competition.attackChance(x.bot.session, x.rival, now);
        Competition.record(x.bot, x.mob, now);
        const started = Competition.record(x.rival, x.mob, now + 1, () => 0.01);
        assert.strictEqual(started, variant === 'grievance', `${variant}: prior memory must affect the real provocation path`);
        assert.strictEqual(!!x.bot.session.pvpRevenge, variant === 'grievance');
        if (variant === 'grievance') {
            assert(chance > 0.01);
            assert(events.some(e => e[0] === 'chat' && e[1] === x.bot.id), 'a memory-based escalation still warns first');
        } else assert(chance < 0.01);
        assert.strictEqual(memories.filter(e => e.sourceId === x.bot.id).length, 1, 'physical competition still records exactly one episode');
        for (let i = 2; i <= 100; i++) Competition.record(x.rival, x.mob, now + i, () => 0);
        assert.strictEqual(memories.filter(e => e.sourceId === x.bot.id).length, 1);
    }
    for (const mode of ['party', 'clan', 'peace', 'left_mob', 'dead', 'raid', 'budget', 'disabled']) {
        const x = setup();
        if (mode === 'party') x.bot.session.coldLifeState = x.rival.session.coldLifeState = { party: { partyId: 'friends' } };
        if (mode === 'clan') x.bot.clan = x.rival.clan = 5;
        if (mode === 'peace') x.rival.x = 99999;
        if (mode === 'left_mob') x.bot.session.currentTargetId = 1;
        if (mode === 'dead') x.mob.state.fetchDead = () => true;
        if (mode === 'raid') x.mob.fetchIsRaidBoss = () => true;
        if (mode === 'budget') Budget.canSend = () => false;
        if (mode === 'disabled') x.bot.fakeDeath = true;
        Competition.record(x.bot, x.mob, now);
        const count = events.length;
        assert(!Competition.record(x.rival, x.mob, now + 1, () => 0), mode);
        if (['party', 'left_mob', 'dead', 'raid'].includes(mode)) {
            assert(!memories.some(event => event.sourceId === x.bot.id), `${mode}: no false social conflict`);
        }
        if (mode === 'clan') assert(memories.some(event => event.sourceId === x.bot.id), 'personal memories remain independent of clan PvP protection');
        assert(!events.slice(count).some(e => ['chat', 'attack'].includes(e[0])), `${mode}: no inappropriate warning or attack`);
        Budget.canSend = () => true;
    }
    for (const mode of ['outmatched', 'pvp_averse']) {
        const x = setup();
        if (mode === 'outmatched') { x.bot.level = 1; x.rival.level = 80; }
        else x.bot.session.persona.traits = { assertiveness: 0.1, caution: 0.9, empathy: 0.9 };
        Competition.record(x.bot, x.mob, now);
        assert(!Competition.record(x.rival, x.mob, now + 1, () => 0), mode);
        assert(!x.bot.session.pvpRevenge, 'a warning does not override the normal risk evaluation');
    }
    for (const reset of [mob => Competition.reset(mob), () => { now += Competition.CLAIM_MS + 1; }]) {
        const x = setup();
        Competition.record(x.bot, x.mob, now);
        reset(x.mob);
        assert(!Competition.record(x.rival, x.mob, now + 1, () => 0), 'reset or abandoned claims cannot trigger a dispute');
    }
    const summonCase = setup();
    Competition.record(summonCase.bot, summonCase.mob, now);
    const summon = { fetchKind: () => 'Summon', fetchOwnerId: () => summonCase.rival.id };
    assert(Competition.record(summon, summonCase.mob, now + 1, () => 0));
    assert.strictEqual(summonCase.bot.session.pvpRevenge.target, summonCase.rival, 'summon attacks are attributed to their owner');

    // The real melee entry point claims before damage, even when the swing misses.
    const native = setup();
    native.bot.fetchCollectiveAtkSpd = () => 333;
    native.bot.backpack.fetchTotalWeaponKind = () => 'Weapon.Sword';
    native.bot.session.dataSendToMeAndOthers = () => {};
    const attack = new Attack();
    attack.queueTimer = () => {};
    attack.prepareMeleeHit = () => ({ damage: 0, flags: 0 });
    attack.resolveMeleeTargets = () => [native.mob];
    Formulas.calcHitChance = () => false;
    attack.meleeHit(native.bot.session, native.mob);
    assert(Competition.record(native.rival, native.mob, Date.now(), () => 0), 'first swing claims the mob before its impact callback');

    const caster = setup();
    const cast = new Attack();
    cast.queueTimer = () => {};
    cast.skillMpCost = () => 1;
    cast.skillUseConditionFailure = () => null;
    cast.isMagicSkill = () => true;
    cast.chargeShotForSkill = () => {};
    cast.calculatedSkillHitTime = () => 1000;
    caster.bot.session.dataSendToMe = caster.bot.session.dataSendToMeAndOthers = () => {};
    Response.skillStarted = Response.skillDurationBar = () => Buffer.alloc(0);
    const skill = { fetchTargetKind: () => 'enemy', setCalculatedHitTime() {}, fetchCalculatedHitTime: () => 1000 };
    cast.remoteHit(caster.bot.session, caster.mob, skill);
    assert(Competition.record(caster.rival, caster.mob, Date.now(), () => 0), 'accepted hostile cast claims before damage');
} finally {
    InteractionMemory.events.enqueue = originalEnqueue;
    utils.isInPeaceZone = original.peace; World.user = original.world;
    Budget.canSend = original.canSend; Budget.record = original.record; Response.speak = original.speak;
    BotAI.promoteForPlayerInteraction = original.promote; Tactics.support = original.support;
    Tactics.control = original.control; Potions.tryUseInCombat = original.potions;
    Formulas.calcHitChance = original.hitChance;
    Response.skillStarted = original.skillStarted; Response.skillDurationBar = original.duration;
}
console.log('Bot mob competition checks passed');
