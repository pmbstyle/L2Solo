const assert = require('assert');
require('../src/Global');
const Memory = invoke('GameServer/Bot/AI/BotEnemyMemory');
const SocialMemory = invoke('GameServer/Social/InteractionMemoryRuntime');
const SocialPolicy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Revenge = invoke('GameServer/Bot/AI/BotRevenge');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Defense = invoke('GameServer/Bot/AI/BotPvpDefense');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const World = invoke('GameServer/World/World');
const Budget = invoke('GameServer/Bot/AI/BotPvpChat');
const Response = invoke('GameServer/Network/Response');
const BotAI = invoke('GameServer/Bot/BotAI');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Potions = invoke('GameServer/Bot/AI/HealingPotionStock');
const Attack = invoke('GameServer/Actor/Attack');
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
    if (bot) SocialMemory.accept(SocialPolicy.empty(a.id));
    return a;
}
const events = [], writes = [];
const original = { peace: utils.isInPeaceZone, world: World.user, remember: Life.rememberEnemies,
    canSend: Budget.canSend, record: Budget.record, speak: Response.speak, promote: BotAI.promoteForPlayerInteraction,
    support: Tactics.support, control: Tactics.control, potions: Potions.tryUseInCombat };
try {
    utils.isInPeaceZone = x => x === 99999;
    Life.rememberEnemies = session => { writes.push(session.actor.id); return Promise.resolve(true); };
    Budget.canSend = () => true; Budget.record = () => {};
    Response.speak = (_actor, data) => data.text;
    BotAI.promoteForPlayerInteraction = session => events.push(['wake', session.actor.id]);
    Tactics.support = Tactics.control = Potions.tryUseInCombat = () => false;
    const bot = character(), foe = character(false, 10), helper = character(), outsider = character();
    helper.session.persona.traits = { assertiveness: 1, empathy: 0, commitment: 1, sociability: 1, caution: 0 };
    World.user = { sessions: [bot.session, foe.session, helper.session, outsider.session] };
    for (let i = 0; i < 500; i++) Memory.record(bot, foe, false, now + i);
    assert.strictEqual(Memory.entries(bot.session)[0].attacks, 1, 'a burst of damage counts as one incident');
    assert.strictEqual(writes.length, 1, 'damage bursts must not cause one write per hit');
    assert.strictEqual(Revenge.tryStart(bot.session, now, () => 0), false, 'attacks alone never authorize revenge');
    Memory.record(bot, foe, true, now);
    assert.strictEqual(Revenge.tryStart(bot.session, now, () => 0), false, 'one kill is not repeated killing');
    Memory.record(bot, foe, true, now + 1);
    const lesser = Array.from({ length: 4 }, () => character());
    lesser.forEach((enemy, i) => Memory.record(bot, enemy, false, now + i + 2));
    assert.strictEqual(Memory.entries(bot.session).length, 3);
    assert.strictEqual(Memory.entries(bot.session)[0].id, foe.id, 'deaths outrank simple attacks');
    const restored = character();
    restored.session.coldLifeState = { stats: { pvpEnemies: JSON.parse(JSON.stringify(Memory.snapshot(bot.session))) } };
    assert.strictEqual(Memory.entries(restored.session)[0].kills, 2, 'memory reload preserves repeated kills');
    Defense.clear(bot.session, { dead: true });
    assert.strictEqual(Memory.entries(bot.session)[0].kills, 2, 'death cleanup must preserve enemies');

    // Legacy counters are diagnostic history only. Decisions require a hydrated,
    // currently hostile shared relationship (including foes outside the old top three).
    let shared = SocialPolicy.empty(bot.id);
    for (const [i, type] of ['attacked', 'killed', 'killed'].entries()) shared = SocialPolicy.apply(shared,
        { key: `revenge-fixture:${i}`, sourceId: bot.id, targetId: foe.id, type, at: now }, now).snapshot;
    SocialMemory.accept(shared);
    bot.session.pvpEnemyMemory = [];

    bot.session.coldLifeState = helper.session.coldLifeState = { party: { partyId: 'revenge_party' } };
    const ai = { executePvPCombat(session, actor, target) { events.push(['attack', actor.id, target.id]); } };
    assert(Defense.tick(bot.session, bot, {}, ai, { now, rng: () => 0 }));
    assert.deepStrictEqual(events.filter(e => ['chat', 'attack'].includes(e[0])).map(e => e[0]), ['chat', 'attack'],
        'a revenge line must precede the first attack');
    assert(Revenge.allows(bot.session, foe, now), 'revenge may start against this remembered white enemy');
    assert(!Revenge.allows(bot.session, outsider, now), 'revenge never grants permission against unrelated white players');
    assert(!helper.session.pvpRevenge, 'the party must not commit before the first hostile action');
    Threats.record(foe, bot, now);
    assert(helper.session.pvpRevenge, 'a bot opening PvP must recruit its nearby party');
    Defense.tick(helper.session, helper, {}, ai, { now, rng: () => 0 });
    assert(events.some(e => e[0] === 'attack' && e[1] === helper.id && e[2] === foe.id));
    assert.strictEqual(new Attack().blockedPvpDefense(bot.session, bot, foe), false,
        'native damage must accept only the explicitly authorized revenge target');
    helper.session.coldLifeState = { party: { partyId: 'another_party' } };
    assert(!Revenge.allows(helper.session, foe, now), 'leaving the party revokes its borrowed attack permission');
    assert(!Revenge.allows(bot.session, foe, now + Revenge.ENCOUNTER_MS + 1), 'abandoned objectives expire');
    foe.x = 99999;
    assert(!Revenge.allows(bot.session, foe, now), 'peace zones stop revenge');
    foe.x = 0; foe.dead = true;
    assert(!Revenge.allows(bot.session, foe, now), 'a dead target ends revenge');
    foe.dead = false;
    foe.clan = bot.clan = 5;
    assert(!Revenge.allows(bot.session, foe, now), 'new clan allies must not remain revenge targets');
    foe.clan = bot.clan = 0;

    const opener = character(), ally = character(), neutral = character(false);
    ally.session.persona.traits = { assertiveness: 1, empathy: 0, commitment: 1, sociability: 1, caution: 0 };
    opener.session.coldLifeState = ally.session.coldLifeState = { party: { partyId: 'opening_party' } };
    World.user.sessions.push(opener.session, ally.session, neutral.session);
    Revenge.onAttack(opener, neutral, now, () => 0.2);
    Threats.record(neutral, opener, now);
    assert.strictEqual(ally.session.pvpRevenge?.reason, 'party_attack',
        'party assistance must also handle a first attack without revenge history');
    Defense.tick(ally.session, ally, {}, ai, { now, rng: () => 0 });
    assert(events.some(e => e[0] === 'attack' && e[1] === ally.id && e[2] === neutral.id));

    Defense.clear(bot.session);
    bot.session.nextRevengeAt = bot.session.nextRevengeScanAt = 0;
    bot.fakeDeath = true;
    assert(!Revenge.tryStart(bot.session, now, () => 0), 'incapacitated bots must not announce or initiate revenge');
    bot.fakeDeath = false;
    bot.level = 1; foe.level = 80;
    assert(!Revenge.tryStart(bot.session, now, () => 0), 'revenge must use the same level and gear risk evaluation');
    bot.level = 80; foe.level = 1; bot.session.nextRevengeScanAt = 0;
    bot.session.persona.traits = { caution: 0.9, assertiveness: 0.1, empathy: 0.9 };
    assert(!Revenge.tryStart(bot.session, now, () => 0), 'a PvP-averse personality must refuse revenge');
    bot.session.persona.traits = { caution: 0.3, assertiveness: 0.8, empathy: 0.4 };
    bot.session.nextRevengeScanAt = 0;
    Budget.canSend = () => false;
    assert(!Revenge.tryStart(bot.session, now, () => 0), 'revenge waits when its required announcement cannot be sent');
    assert(!bot.session.pvpRevenge);
    assert(bot.session.pendingPvpProvocation, 'an accepted intent waits for its announcement');
    shared = { ...shared, revision: shared.revision + 1, relations: shared.relations.map(row => ({ ...row,
        affinity: 20, trust: 20, hostility: 0, fear: 0 })) };
    SocialMemory.accept(shared);
    Budget.canSend = () => true;
    assert(!Revenge.flushPending(bot.session, now), 'reconciliation before the first strike cancels a queued provocation');
    assert(!bot.session.pendingPvpProvocation && !bot.session.pvpRevenge);

    const botKiller = character();
    Memory.record(restored, botKiller, true, now);
    Memory.record(restored, botKiller, true, now + 1);
    assert(Memory.entries(restored.session).some(e => e.id === botKiller.id && e.kills === 2), 'bot killers are remembered too');
    assert(!Memory.record(restored, { fetchKind: () => 'Monster', fetchId: () => 1 }, true, now), 'ordinary mobs do not occupy player enemy slots');

    // Exercise the real fatal damage hook, including attribution through a
    // summoned creature. Its owner remains the remembered character.
    const doomed = character(), killer = character(false);
    doomed.setHp = hp => { doomed.hp = hp; };
    doomed.statusUpdateVitals = () => {};
    const summon = { fetchKind: () => 'Summon', fetchOwnerId: () => killer.id, fetchId: () => 1000001 };
    World.user.sessions.push(doomed.session, killer.session);
    const generics = invoke(path.actor), flag = invoke('GameServer/Actor/PvpFlag');
    const die = generics.die, mark = flag.mark;
    const Database = invoke('Database');
    const savePvp = Database.updateCharacterPvpPkKarma;
    const packets = [Response.userInfo, Response.charInfo, Response.relationChanged];
    killer.pvp = 0;
    killer.fetchPvp = () => killer.pvp; killer.setPvp = n => { killer.pvp = n; };
    killer.fetchPk = () => 0;
    doomed.setPvpFlag = n => { doomed.flag = n; };
    killer.session.dataSendToMe = doomed.session.dataSendToMe = () => {};
    Response.userInfo = Response.charInfo = Response.relationChanged = () => Buffer.alloc(0);
    Database.updateCharacterPvpPkKarma = () => Promise.resolve();
    try {
        generics.die = (_s, actor) => { actor.dead = true; };
        flag.mark = () => {};
        const receivedHit = invoke('GameServer/Actor/Generics/ReceivedHit');
        for (let death = 0; death < 2; death++) {
            doomed.hp = 100; doomed.dead = false; doomed.flag = 1;
            receivedHit(killer.session, doomed, 100, { source: summon });
            assert(doomed.dead);
        }
        assert.strictEqual(Memory.entries(doomed.session)[0].kills, 2, 'fatal native damage must record each death once');
        assert.strictEqual(Memory.entries(doomed.session)[0].id, killer.id);
        assert.strictEqual(killer.pvp, 2, 'native summon kills must credit the owner');
    } finally {
        generics.die = die; flag.mark = mark; Database.updateCharacterPvpPkKarma = savePvp;
        [Response.userInfo, Response.charInfo, Response.relationChanged] = packets;
    }
} finally {
    utils.isInPeaceZone = original.peace; World.user = original.world; Life.rememberEnemies = original.remember;
    Budget.canSend = original.canSend; Budget.record = original.record; Response.speak = original.speak;
    BotAI.promoteForPlayerInteraction = original.promote; Tactics.support = original.support;
    Tactics.control = original.control; Potions.tryUseInCombat = original.potions;
}
console.log('Bot enemy memory and revenge checks passed');
