const assert = require('assert');
require('../src/Global');
const World = invoke('GameServer/World/World');
const Defense = invoke('GameServer/Bot/AI/BotPvpDefense');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Risk = invoke('GameServer/Bot/AI/BotPvpRisk');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const BotAI = invoke('GameServer/Bot/BotAI');
const ReceivedHit = invoke('GameServer/Actor/Generics/ReceivedHit');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const Response = invoke('GameServer/Network/Response');
const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
const GearValue = invoke('GameServer/Item/EquipmentValue');
const Observer = invoke('WorldObserver/WorldObserverServer');
const Rules = invoke('GameServer/Skills/C4SkillRules');

const originalPeace = utils.isInPeaceZone;
utils.isInPeaceZone = (x) => x === 99999;
const originalPromote = BotAI.promoteForPlayerInteraction;
const wakes = [];
BotAI.promoteForPlayerInteraction = session => { wakes.push(session); return true; };
const originalSpeak = Response.speak;
Response.speak = (actor, data) => ({ id: actor.fetchId(), ...data });
const originalAnnounce = GlobalChat.announceAttack;
const globals = [];
GlobalChat.announceAttack = (session, attacker) => { globals.push(attacker.fetchId()); return true; };

function actor(id, options = {}) {
    const value = { id, hp: 100, mp: 100, cp: 0, level: 40, gear: 100000, x: 0, y: 0,
        flag: 0, dead: false, online: true, seated: false, hits: false, casts: false, moving: false,
        skills: [], effects: {}, ...options };
    return Object.assign(value, {
        fetchId() { return this.id; }, fetchName() { return `fighter_${this.id}`; },
        fetchLocX() { return this.x; }, fetchLocY() { return this.y; }, fetchLocZ: () => 0,
        fetchHp() { return this.hp; }, setHp(n) { this.hp = n; }, fetchMaxHp: () => 100,
        fetchMp() { return this.mp; }, fetchMaxMp: () => 100,
        fetchCp() { return this.cp; }, setCp(n) { this.cp = n; }, fetchMaxCp: () => 100,
        fetchLevel() { return this.level; }, fetchClassId() { return this.classId || 0; },
        fetchKarma() { return this.karma || 0; }, fetchPvpFlag() { return this.flag; }, fetchDestId() { return this.target; },
        fetchIsOnline() { return this.online; }, isDead() { return this.dead; }, canUseSkill: () => true,
        select(data) { this.target = data.id; }, unselect() { this.target = undefined; }, statusUpdateVitals() {},
        state: { fetchDead: () => value.dead, fetchSeated: () => value.seated, setSeated: n => { value.seated = n; },
            fetchHits: () => value.hits, setHits: n => { value.hits = n; }, fetchCasts: () => value.casts,
            setCasts: n => { value.casts = n; }, fetchTowards: () => value.moving,
            fetchCombats: () => true },
        automation: { abortAll() { value.moving = false; }, replenishVitals() {} },
        skillset: { fetchSkills: () => value.skills, get skills() { return value.skills; }, fetchSkill: id => value.skills.find(skill => skill.fetchSelfId() === id) },
        backpack: { fetchItems: () => [{ fetchSelfId: () => 999999, fetchPrice: () => value.gear, fetchEquipped: () => true }],
            fetchEquippedArmors: () => [] }
    });
}

function session(actor, options = {}) {
    const session = { actor, accountId: `bot_${actor.id}`, aiActive: true, plan: 'hunting', packets: [],
        persona: { traits: { caution: 0.3, assertiveness: 0.8, empathy: 0.4, resilience: 0.8 } }, ...options,
        dataSendToOthers(packet) { this.packets.push(packet); } };
    actor.session = session;
    return session;
}

let now = Date.now();
let nextId = 2100000;
function setup(options = {}, mode = 'hunting') {
    const bot = actor(nextId++, options);
    const own = session(bot, { plan: mode });
    const enemy = actor(nextId++, { flag: 1 });
    const attacker = session(enemy, { accountId: 'player', aiActive: false });
    World.user = { sessions: [own, attacker] };
    World.npc = { spawns: [] };
    World.fetchNpcsInRadius = () => [];
    return { bot, own, enemy, attacker };
}

const attacks = [];
const casts = [];
const ai = { executePvPCombat(_s, _b, target) { attacks.push(target.fetchId()); } };
const generics = { skillExec(_s, _b, data) { casts.push(data); } };
function tick(own, rng = () => 0.99) {
    return Defense.tick(own, own.actor, generics, ai, { now, rng });
}

// The same price sum powers both the Observer and the decision model.
assert.strictEqual(GearValue.equipmentValue([{ selfId: 999999, price: 123 }]), Observer.equipmentValue([{ selfId: 999999, price: 123 }]));
{
    const { own, bot, enemy } = setup();
    assert.strictEqual(Risk.defenseDecision(own, [enemy]).action, 'fight');
    enemy.gear = 100000000;
    assert.strictEqual(Risk.defenseDecision(own, [enemy]).action, 'flee');
    enemy.gear = bot.gear; enemy.level = 60;
    assert.strictEqual(Risk.defenseDecision(own, [enemy]).action, 'flee');
    enemy.level = bot.level; bot.hp = 20;
    assert.strictEqual(Risk.defenseDecision(own, [enemy]).action, 'flee');
    bot.hp = 100; bot.classId = 10; bot.mp = 5;
    assert.strictEqual(Risk.defenseDecision(own, [enemy]).action, 'flee');
    bot.mp = 100;
    own.persona.traits = { caution: 0.9, assertiveness: 0.1, empathy: 0.9, resilience: 0.5 };
    assert.strictEqual(Risk.defenseDecision(own, [enemy]).reasons[0], 'avoids_pvp');
}

// Real damage through CP wakes defenders. All idle/travel plans use the same
// interception; no inherited sitting, movement or NPC attack may consume it.
for (const plan of ['hunting', 'resting', 'shopping', 'getting_buffed', 'following']) {
    const { own, bot, enemy, attacker } = setup({ cp: 100, seated: true, moving: true, hits: true }, plan);
    // Avoid a packet-only stand action in this small damage fixture.
    bot.seated = false;
    ReceivedHit(attacker, bot, 5);
    bot.seated = true;
    assert.strictEqual(bot.cp, 95);
    assert.strictEqual(bot.hp, 100);
    assert(own.pvpAggressors.has(enemy.id));
    assert(tick(own));
    assert.strictEqual(own.pvpDefense.action, 'fight');
    assert.strictEqual(own.plan, plan, 'transient PvP must not change the persisted activity');
    assert.strictEqual(bot.seated, false);
    assert.strictEqual(own.currentTargetId, enemy.id);
    assert.strictEqual(attacks.at(-1), enemy.id);
    bot.hp = 20; // the original fight decision must survive worsening odds
    tick(own);
    assert.strictEqual(own.pvpDefense.action, 'fight');
    bot.hp = 10;
    tick(own); // high roll: fight to the end
    tick(own, () => 0); // must not roll again every AI tick
    assert.strictEqual(own.pvpDefense.action, 'fight');
    enemy.dead = true;
    assert.strictEqual(tick(own), false);
    assert.strictEqual(own.plan, plan);
    assert.strictEqual(own.currentTargetId, undefined);
}

// White players can attack a red bot without flagging; only recorded
// aggressors are eligible, and the permission ends when karma is washed.
for (const hp of [100, 20]) {
    const { own, bot, enemy } = setup({ karma: 190, hp });
    enemy.flag = 0;
    bot.moveTo = () => ({ usable: true });
    own.pendingPvpProvocation = { target: enemy, expiresAt: now + 10000 };
    assert.strictEqual(invoke('GameServer/Bot/AI/BotRevenge').tryStart(own, now, () => 0), false,
        'karma washing takes priority over starting revenge');
    assert.strictEqual(own.pendingPvpProvocation, undefined);
    assert.strictEqual(Threats.canDefendWhileChaotic(own, enemy, now), false);
    Threats.record(bot, enemy, now);
    assert.strictEqual(tick(own), true);
    assert.strictEqual(own.pvpDefense.action, hp === 100 ? 'fight' : 'flee');
    const attack = new (invoke('GameServer/Actor/Attack'))();
    assert.strictEqual(attack.blockedPvpDefense(own, bot, enemy), false);
    assert.strictEqual(Threats.canDefendWhileChaotic(own, enemy, now + Threats.MEMORY_MS + 1), false);
    bot.karma = 0;
    assert.strictEqual(attack.blockedPvpDefense(own, bot, enemy), true);
    assert.strictEqual(tick(own), false);
    assert.strictEqual(own.plan, 'hunting');
}

// Fleeing uses real retreat planning and remains committed until safe.
{
    const { own, bot, enemy } = setup({ hp: 20 }, 'resting');
    const moves = [];
    bot.moveTo = value => { if (!value.previewOnly) moves.push(value); return { usable: true }; };
    Threats.record(bot, enemy, now);
    tick(own);
    assert.strictEqual(own.pvpDefense.action, 'flee');
    assert.strictEqual(moves.length, 1);
    bot.hp = 100;
    tick(own);
    assert.strictEqual(own.pvpDefense.action, 'flee');
    enemy.x = 2000;
    tick(own);
    assert.strictEqual(own.plan, 'resting');
}
{
    const { own, bot, enemy } = setup();
    bot.moveTo = () => {};
    Threats.record(bot, enemy, now); tick(own);
    bot.hp = 10; tick(own, () => 0);
    assert.strictEqual(own.pvpDefense.action, 'flee');
}

// Only recorded aggressors count. Changing selection must not erase an
// attack, and a weaker second attacker becomes the shared focus immediately.
{
    const { own, bot, enemy } = setup();
    const companion = session(actor(nextId++, { hp: 50, classId: 0 }), {
        partyCompanion: true, followPlayerSession: own, plan: 'resting',
        persona: { traits: { caution: 0.9, assertiveness: 0.1, empathy: 0.9, resilience: 0.5 } }
    });
    const weak = actor(nextId++, { level: 10, flag: 1 });
    const bystander = actor(nextId++, { level: 1, flag: 1 });
    World.user.sessions.push(companion, session(weak, { aiActive: false }), session(bystander, { aiActive: false }));
    const wakeCount = wakes.length;
    Threats.record(bot, enemy, now);
    assert.strictEqual(wakes.length - wakeCount, 2);
    tick(companion); assert.strictEqual(companion.currentTargetId, enemy.id);
    Threats.record(companion.actor, weak, now);
    enemy.target = bystander.id;
    tick(companion); tick(own);
    assert.strictEqual(companion.pvpDefense.action, 'fight', 'party loyalty overrides solo aversion');
    assert.strictEqual(companion.currentTargetId, weak.id);
    assert.strictEqual(own.currentTargetId, weak.id);
    assert(!own.lastPvpDecision.targets.includes(bystander.id));
    assert.strictEqual(Threats.record(bot, companion.actor, now), false);
    weak.dead = true; tick(companion);
    assert.strictEqual(companion.currentTargetId, enemy.id);
    bot.dead = true; Defense.clear(own, { dead: true }); tick(companion);
    assert.strictEqual(companion.currentTargetId, enemy.id, 'survivors retain the killing attacker');
    enemy.flag = 0; now += 2000; tick(companion);
    assert.strictEqual(companion.pvpDefense, undefined, 'stop before PKing a now-white opponent');
}

function skill(id, type, target, effect, power = 100) {
    return { fetchSelfId: () => id, fetchSkillType: () => type, fetchTargetKind: () => target,
        fetchSemantic: () => ({ effect, effectType: target === 'enemy' ? 'debuff' : 'buff', sourceTarget: 'one' }),
        fetchDistance: () => 900, fetchConsumedMp: () => 10, fetchPower: () => power };
}
{
    const { own, bot, enemy } = setup();
    const healer = session(actor(nextId++, { classId: 15, skills: [skill(1011, Rules.HEAL, 'friendly', 'heal')] }), {
        partyCompanion: true, followPlayerSession: own
    });
    World.user.sessions.push(healer);
    bot.hp = 25;
    Threats.record(bot, enemy, now); tick(healer);
    assert.deepStrictEqual(casts.at(-1), { id: bot.id, selfId: 1011, ctrl: false });
    bot.hp = 100;
    const extra = actor(nextId++, { level: 60, flag: 1 });
    World.user.sessions.push(session(extra, { aiActive: false }));
    Threats.record(bot, extra, now);
    healer.actor.skills = [skill(1069, Rules.EFFECT, 'enemy', 'sleep')];
    tick(healer);
    assert.deepStrictEqual(casts.at(-1), { id: extra.id, selfId: 1069, ctrl: true });
    const count = casts.length;
    tick(healer);
    assert.strictEqual(casts.length, count, 'do not spam a resisted/pending control every tick');
    healer.actor.skills = [skill(1097, Rules.EFFECT, 'enemy', 'weakness')];
    assert(Tactics.control(healer, healer.actor, { ...Threats.context(healer, now), threats: [{ actor: enemy }] }, enemy, generics, now));
    assert.strictEqual(casts.at(-1).id, enemy.id, 'soft debuffs can weaken the primary target');
}

// PvP consumes successive owned potions, including quick healing under HoT;
// the farming cap, cooldowns, empty inventory, and active HoT remain enforced.
{
    const { own, bot, enemy } = setup({ hp: 20 });
    let amount = 3;
    bot.backpack.fetchItems = () => [{ fetchSelfId: () => 1060, fetchAmount: () => amount, fetchId: () => 888 }];
    bot.backpack.buildItemSkill = () => ({ fetchSelfId: () => 2031 });
    bot.backpack.useItem = () => { amount--; };
    assert(Potions.tryUseInCombat(own, bot, enemy));
    assert.strictEqual(Potions.tryUseInCombat(own, bot, enemy), null);
    assert(Potions.tryUseInCombat(own, bot, enemy, { pvp: true }));
    bot.canUseSkill = () => false;
    assert.strictEqual(Potions.tryUseInCombat(own, bot, enemy, { pvp: true }), null);
    bot.canUseSkill = () => true;
    assert(Potions.tryUseInCombat(own, bot, enemy, { pvp: true }));
    assert.strictEqual(Potions.tryUseInCombat(own, bot, enemy, { pvp: true }), null);
    bot.effects.healing_potion = { key: 'healing_potion', expiresAt: Date.now() + 10000 };
    assert.strictEqual(Potions.selectPotion([{ selfId: 1060, amount: 2 }], 20, 100, bot, { pvp: true, activeHot: true }), null);
    assert.strictEqual(Potions.selectPotion([{ selfId: 1540, amount: 2 }], 20, 100, bot, { pvp: true, activeHot: true }).selfId, 1540);
}

{
    const { own, bot, enemy } = setup();
    invoke('GameServer/Bot/AI/BotChatterBudget').reset();
    Threats.record(bot, enemy, now); tick(own);
    assert.strictEqual(own.packets.at(-1).kind, 0, 'threats must be local, including companions');
    const count = own.packets.length;
    tick(own); assert.strictEqual(own.packets.length, count);
    Defense.clear(own); own.nextPvpChatAt = 0;
    tick(own, () => 0);
    assert(globals.includes(enemy.id));
    enemy.x = 99999;
    assert.strictEqual(Threats.record(bot, enemy, now), false);
    tick(own); assert.strictEqual(own.pvpDefense, undefined);
    enemy.x = 0; enemy.session.arenaDuelId = 'test';
    assert.strictEqual(Threats.record(bot, enemy, now), false);
    delete enemy.session.arenaDuelId;
    Threats.record(bot, enemy, now);
    now += Threats.MEMORY_MS + 1;
    assert.strictEqual(tick(own), false);
}

// Native landing guards distinguish harmful actions from friendly support.
{
    now = Date.now();
    const { own, bot, enemy, attacker } = setup();
    const Attack = invoke('GameServer/Actor/Attack');
    const attack = new Attack();
    const marker = invoke('GameServer/Actor/PvpFlag');
    const mark = marker.mark;
    let flagged = 0;
    marker.mark = (_session, actor) => { actor.flag = 1; flagged++; };
    enemy.flag = 0;
    assert.strictEqual(attack.recordPlayerAggression(attacker, enemy, bot), true);
    assert.strictEqual(flagged, 1, 'a missed hit or resisted control still flags the actual aggressor');
    assert(own.pvpAggressors.has(enemy.id));
    const pet = { fetchKind: () => 'Npc', fetchOwnerId: () => enemy.id, fetchId: () => 100001 };
    ReceivedHit(attacker, bot, 1, { source: pet });
    assert.strictEqual(flagged, 2, 'a summon hit attributes the aggression and PvP flag to its owner');
    tick(own);
    assert.strictEqual(attack.blockedPvpDefense(own, bot, enemy), false);
    enemy.flag = 0;
    assert.strictEqual(attack.blockedPvpDefense(own, bot, enemy), true, 'cancel already queued damage when the enemy goes white');
    assert.strictEqual(attack.blockedPvpDefense(own, bot, enemy, skill(1011, Rules.HEAL, 'friendly', 'heal')), false,
        'a friendly support cast is not subject to hostile target checks');
    enemy.flag = 1; enemy.x = 99999;
    assert.strictEqual(attack.blockedPvpDefense(own, bot, enemy), true);
    enemy.x = 0; attacker.partyCompanion = true; attacker.followPlayerSession = own;
    assert.strictEqual(attack.blockedPvpDefense(own, bot, enemy), true, 'a new party member is no longer an enemy');
    marker.mark = mark;
}

// The real hot dispatcher intercepts rest before the ordinary state handler.
{
    const { own, bot, enemy } = setup({ seated: true }, 'resting');
    Threats.record(bot, enemy);
    const lod = invoke('GameServer/Bot/AI/HotActorLodPolicy');
    const refresh = lod.shouldRefreshStatus;
    const combat = BotAI.executePvPCombat;
    lod.shouldRefreshStatus = () => false;
    BotAI.executePvPCombat = ai.executePvPCombat;
    BotAI.tick(own);
    assert.strictEqual(own.pvpDefense.action, 'fight');
    assert.strictEqual(own.currentTargetId, enemy.id);
    assert.strictEqual(bot.seated, false);
    assert.strictEqual(invoke('GameServer/Bot/Population/Cooldown').canCooldown(own).reason, 'pvp_active');
    lod.shouldRefreshStatus = refresh;
    BotAI.executePvPCombat = combat;
}
{
    const { own, bot, enemy } = setup();
    own.coldLifeState = { party: { partyId: 'background_test', leaderId: bot.id } };
    const ally = session(actor(nextId++), { coldLifeState: { party: { partyId: 'background_test', leaderId: bot.id } } });
    World.user.sessions.push(ally);
    Threats.record(bot, enemy, now);
    tick(ally);
    assert.strictEqual(ally.currentTargetId, enemy.id, 'materialized autonomous party members also defend one another');
    assert.strictEqual(Threats.record(bot, ally.actor, now), false);
}
{
    const { own, enemy, attacker } = setup();
    const config = invoke('GameServer/Bot/Population/PopulationConfig');
    const enabled = config.globalChatEnabled;
    config.globalChatEnabled = true;
    GlobalChat.reset();
    invoke('GameServer/Bot/AI/BotChatterBudget').reset();
    const received = [];
    attacker.socket = { write() {} };
    attacker.dataSendToMe = packet => received.push(packet);
    assert.strictEqual(originalAnnounce(own, enemy, now), true);
    assert.strictEqual(received[0].kind, 1);
    assert(received[0].text.includes(enemy.fetchName()));
    assert.strictEqual(originalAnnounce(own, enemy, now + 1), false, 'global complaints obey the shared traffic budget');
    config.globalChatEnabled = enabled;
    GlobalChat.reset();
}

utils.isInPeaceZone = originalPeace;
BotAI.promoteForPlayerInteraction = originalPromote;
Response.speak = originalSpeak;
GlobalChat.announceAttack = originalAnnounce;
console.log('Bot PvP defense checks passed');
