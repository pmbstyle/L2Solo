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
        fetchKarma: () => 0, fetchPvpFlag() { return this.flag; }, fetchDestId() { return this.target; },
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

const Memory = invoke('GameServer/Bot/AI/BotEnemyMemory');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Index = invoke('GameServer/Bot/AI/BotPvpIndex');
const Revenge = invoke('GameServer/Bot/AI/BotRevenge');
const Chat = invoke('GameServer/Bot/AI/BotPvpChat');
const Ambient = invoke('GameServer/Bot/AI/BotChatterBudget');
const Attack = invoke('GameServer/Actor/Attack');
const Retreat = invoke('GameServer/Bot/AI/BotRetreatPlanner');
Life.rememberEnemies = () => Promise.resolve(true);
Potions.tryUseInCombat = () => false;
{
    const { bot, own } = setup();
    [actor(nextId++), actor(nextId++), actor(nextId++)].forEach(enemy => {
        Memory.record(bot, enemy, true, now); Memory.record(bot, enemy, true, now + 1);
    });
    const newcomer = actor(nextId++);
    for (let i = 0; i < 10; i++) Memory.record(bot, newcomer, true, now + 10 + i);
    assert.strictEqual(Memory.entries(own).length, 3);
    assert.strictEqual(Memory.entries(own).find(e => e.id === newcomer.id).kills, 10,
        'a full history must admit and accumulate a new killer without inventing kills');
}
{
    const { bot, own, enemy } = setup();
    enemy.level = 10;
    Threats.record(bot, enemy, now); tick(own);
    for (let i = 0; i < 4; i++) { now += 4000; Threats.record(enemy, bot, now); }
    assert(tick(own), 'outgoing hostile actions keep a fight with a flagged opponent active');
    assert(own.pvpDefense);
    now += Threats.MEMORY_MS + 1;
    assert(!tick(own), 'an abandoned encounter still expires');
    assert(!own.pvpDefense);
}
{
    const { bot, own, enemy } = setup({ level: 80 });
    const extra = actor(nextId++, { level: 45, flag: 1 });
    World.user.sessions.push(session(extra, { accountId: 'player', aiActive: false }));
    Threats.record(bot, enemy, now); Threats.record(bot, extra, now); tick(own);
    extra.hp = 20;
    extra.effects.sleep = { key: 'sleep', type: 'debuff', expiresAt: Date.now() + 10000 };
    tick(own);
    assert.strictEqual(own.currentTargetId, enemy.id, 'a weaker sleeping off-target must not steal party focus');
    assert(new Attack().blockedPvpDefense(own, bot, extra), 'a swing already in flight must not break sleep');
    extra.effects = {};
    own.pvpControlClaims = new Map([[`${extra.id}:sleep`, now + 1000]]);
    assert.strictEqual(Threats.focus(own, Threats.context(own, now), now), enemy, 'pending sleep also protects its target');
    now += 1001;
    assert.strictEqual(Threats.focus(own, Threats.context(own, now), now), extra, 'a failed or expired reservation must not protect forever');
}
{
    const bot = actor(1, { x: 0 }), nearest = actor(2, { x: 100 }), second = actor(3, { x: -500 });
    const plan = Retreat.plan(bot, nearest, { distance: 900, threats: [nearest, second],
        world: { fetchNpcsInRadius: () => [] }, geodata: { hasLineOfSight: () => true, getHeight: () => 0 } });
    assert.strictEqual(plan.hazardCount, 1, 'other PvP attackers participate in route safety');
    assert(Math.abs(plan.to.locY) > 100, 'do not flee straight through the second attacker');
}
{
    const { bot, own, enemy, attacker } = setup();
    const solo = Risk.defenseDecision(own, [enemy]);
    const ally = session(actor(nextId++, { level: 80 }));
    own.coldLifeState = ally.coldLifeState = { party: { partyId: 'friendly' } };
    World.user.sessions.push(ally);
    const grouped = Risk.defenseDecision(own, [enemy]);
    assert(grouped.score > solo.score, 'nearby allies count toward expected success');
    const guard = session(actor(nextId++, { level: 80 }));
    attacker.coldLifeState = guard.coldLifeState = { party: { partyId: 'hostile' } };
    World.user.sessions.push(guard);
    assert(Risk.defenseDecision(own, [enemy]).score < grouped.score, 'a weak target is not evaluated separately from its party');
    bot.fetchCollectivePAtk = () => 200;
    const plain = Risk.combatStrength(bot).power;
    bot.fetchCollectivePAtk = () => 400;
    assert(Risk.combatStrength(bot).power > plain, 'buffed collective combat stats affect strength');
    const unassisted = Risk.combatStrength(bot).power;
    bot.summon = actor(nextId++, { level: 40 });
    assert(Risk.combatStrength(bot).power > unassisted, 'an active summon contributes strength');
    const unstocked = Risk.combatStrength(bot).power;
    const gear = bot.backpack.fetchItems();
    bot.backpack.fetchItems = () => [...gear, { selfId: 1540, amount: 3 }];
    assert(Risk.combatStrength(bot).supplyFactor > 1);
    assert(Risk.combatStrength(bot).power > unstocked, 'available healing supplies affect the estimate');
    assert(Risk.combatStrength(bot).power <= unstocked * 1.25, 'supplies remain a bounded modifier');
}
{
    Chat.reset(); Ambient.reset();
    const { bot, own, enemy } = setup(); enemy.level = 10;
    Ambient.record(own, 'conversation', now);
    assert(Chat.canSend(own, 'revenge', now), 'ordinary conversation does not consume the conflict budget');
    Chat.record(session(actor(nextId++)), 'revenge', now);
    assert(!Revenge.request(own, enemy, 'revenge', ['A warning before combat.'], true, now, () => 0));
    assert(own.pendingPvpProvocation && !own.pvpRevenge, 'a busy conflict budget queues the warning and holds the attack');
    const packetCount = own.packets.length;
    now += Chat.AREA_MS + 1;
    assert(Revenge.tryStart(own, now, () => { throw new Error('do not reroll a queued decision'); }));
    assert.strictEqual(own.packets.length, packetCount + 1);
    assert(own.pvpRevenge && !own.pendingPvpProvocation);
    Defense.clear(own);
    Chat.reset();
}
{
    const { own } = setup();
    let populationReads = 0;
    for (let i = 0; i < 10000; i++) {
        const a = actor(nextId++);
        World.user.sessions.push({ get actor() { populationReads++; return a; } });
    }
    const clock = Date.now;
    try {
        Date.now = () => now;
        Index.invalidate(); Threats.members(own);
        populationReads = 0;
        for (let i = 0; i < 500; i++) { Threats.members(own); Index.actor(own.actor.id); }
        assert.strictEqual(populationReads, 0, '500 lookups must not rescan 10,000 unrelated actors');
        now += Index.REFRESH_MS + 1; Threats.members(own);
        assert(populationReads > 0, 'membership snapshots refresh on a bounded interval');
    } finally { Date.now = clock; }
}
{
    // Incoming aggression takes priority even before a queued warning can be sent.
    for (const wait of [0, Chat.AREA_MS + 1]) {
        Chat.reset();
        const { bot, own, enemy } = setup(); enemy.level = 10;
        const strong = actor(nextId++, { level: 80, gear: 10000000, flag: 1 });
        World.user.sessions.push(session(strong, { accountId: 'player2' }));
        Chat.record(session(actor(nextId++)), 'revenge', now);
        Revenge.request(own, enemy, 'revenge', ['Pending revenge warning.'], true, now, () => 0);
        assert(own.pendingPvpProvocation);
        now += wait;
        Threats.record(bot, strong, now);
        assert.strictEqual(Risk.defenseDecision(own, [strong, enemy]).action, 'flee');
        const retreat = Retreat.retreat;
        try {
            Retreat.retreat = () => true;
            tick(own);
        } finally { Retreat.retreat = retreat; }
        assert.strictEqual(own.pvpDefense.action, 'flee', 'queued revenge must not override self-defense');
        assert(!own.pvpRevenge && !own.pendingPvpProvocation);
        assert.deepStrictEqual(own.lastPvpDecision.targets, [strong.id]);
        assert(!own.packets.some(packet => packet.text === 'Pending revenge warning.'));
    }
    Chat.reset();
}
{
    const { bot, own, enemy } = setup({ level: 10 }); enemy.level = 80;
    const summon = actor(nextId++, { level: 10, x: 400, controlMode: 'attack', attackTargetId: 12345, hits: true, moving: true });
    summon.fetchOwnerId = () => bot.id;
    summon.fetchKind = () => 'Summon';
    summon.fetchHead = () => 0;
    summon.state.inMotion = () => summon.moving;
    const pendingHits = [() => { throw new Error('old summon attack must be cancelled'); }];
    summon.attack = { clearTimers() { pendingHits.length = 0; } };
    const moves = [];
    summon.automation.scheduleAction = (_s, _actor, target) => { moves.push(target); };
    bot.summon = summon;
    const retreat = Retreat.retreat;
    try {
        Retreat.retreat = () => true;
        Threats.record(bot, enemy, now); tick(own);
        assert.strictEqual(own.pvpDefense.action, 'flee');
        assert.strictEqual(summon.controlMode, 'follow');
        assert.strictEqual(summon.attackTargetId, undefined);
        assert.strictEqual(pendingHits.length, 0);
        assert(!summon.hits && !summon.moving);
        assert.deepStrictEqual(moves, [bot], 'recall must start movement, not only set the follow mode');
        tick(own);
        assert.strictEqual(moves.length, 1, 'later flee ticks must not restart the follow route');
    } finally {
        Retreat.retreat = retreat;
        clearInterval(summon.timer?.followOwner);
    }
}
{
    // Both an in-flight reservation and a new cast after the leader dies must remain visible.
    for (const effect of ['sleep', 'fear']) {
        for (const dieBeforeCast of [false, true]) {
            const { bot, own, enemy } = setup();
            const leader = session(actor(nextId++), { accountId: 'human' });
            own.partyCompanion = true; own.followPlayerSession = leader;
            const ally = session(actor(nextId++), { partyCompanion: true, followPlayerSession: leader });
            World.user.sessions.push(leader, ally);
            Index.invalidate();
            bot.skills = [{ fetchSelfId: () => 1069, fetchSkillType: () => Rules.EFFECT,
                fetchTargetKind: () => 'enemy', fetchSemantic: () => ({ effect, effectType: 'debuff', sourceTarget: 'one' }),
                fetchDistance: () => 900, fetchConsumedMp: () => 10 }];
            Threats.record(bot, enemy, now);
            leader.actor.dead = dieBeforeCast;
            const context = Threats.context(own, now);
            assert(Tactics.control(own, bot, context, enemy, generics, now, true));
            leader.actor.dead = true;
            assert(!Threats.members(own).includes(leader), 'a dead coordinator must not count as combat strength');
            assert(Threats.protectedTarget(ally, enemy, now));
            assert.strictEqual(Threats.focus(ally, Threats.context(ally, now), now), null);
            ally.pvpDefense = { action: 'fight' };
            assert(new Attack().blockedPvpDefense(ally, ally.actor, enemy), 'queued damage must respect the reservation');
            assert(!Threats.protectedTarget(ally, enemy, now + 8001), 'protection still expires');
            ally.followPlayerSession = session(actor(nextId++), { accountId: 'other_leader' });
            assert(!Threats.protectedTarget(ally, enemy, now), 'leaving the party drops its reservations immediately');
        }
    }
}
console.log('Bot PvP audit regression checks passed');
