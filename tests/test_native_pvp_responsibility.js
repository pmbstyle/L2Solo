const assert = require('assert');
require('../src/Global');
const Facts = invoke('GameServer/Social/PvpResponsibility');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Help = invoke('GameServer/Social/CombatHelpMemory');
const Clan = require('../src/GameServer/Clan/ClanSocialPolicy');
const Enemy = invoke('GameServer/Bot/AI/BotEnemyMemory');
const Index = invoke('GameServer/Bot/AI/BotPvpIndex');
const ReceivedHit = invoke('GameServer/Actor/Generics/ReceivedHit');
const events = [], writes = [], restores = [];
function patch(object, key, value) {
    const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value;
}
let serial = 100, now = Date.now();
function actor(human = false, clanId = 10) {
    const id = ++serial;
    const a = { hp: 100, effects: {}, flag: 0, x: 0,
        fetchId: () => id, fetchName: () => `Fighter${id}`, fetchClanId: () => clanId,
        fetchHp() { return this.hp; }, setHp(hp) { this.hp = hp; }, fetchMaxHp: () => 100,
        fetchCp: () => 0, fetchMaxCp: () => 0,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchPvpFlag() { return this.flag; }, fetchKarma: () => 0,
        fetchIsOnline: () => true, statusUpdateVitals() {}, automation: { replenishVitals() {} },
        state: { fetchDead: () => false, fetchSeated: () => false, fetchCombats: () => true } };
    a.session = { actor: a, accountId: human ? 'human' : `bot_fact_${id}` };
    return a;
}
const lastEvent = (victim, attacker, type = 'attacked') => events.findLast(e => e.sourceId === victim.fetchId()
    && e.targetId === attacker.fetchId() && e.type === type);
function hit(attacker, victim) { ReceivedHit(attacker.session, victim, 1); }
try {
    patch(Date, 'now', () => now);
    patch(utils, 'isInPeaceZone', x => x === 99999);
    patch(Memory.events, 'enqueue', e => { events.push(require('../src/GameServer/Social/InteractionMemoryPolicy').event(e)); return true; });
    patch(Life, 'rememberEnemies', s => { writes.push(s); return Promise.resolve(true); });
    patch(Index, 'members', s => s.testParty || [s]);
    patch(invoke('GameServer/Bot/AI/BotRevenge'), 'onAttack', () => {});

    const player = actor(true, 20), bot = actor(), third = actor();
    player.flag = 1;
    hit(player, bot);
    const first = lastEvent(bot, player);
    assert.strictEqual(first.clan.responsibility, 'aggression', 'purple nick is not evidence of self-defense');
    const clan = Clan.apply(Clan.empty(10), first, now);
    assert(clan.relations.some(r => r.kind === 'character' && r.targetId === player.fetchId() && r.hostility > 0));
    const count = writes.length;
    for (let n = 0; n < 500; n++) Threats.record(bot, player, now);
    assert.strictEqual(writes.length, count, '500 accepted repeated attacks add no persistence jobs');
    assert.strictEqual(events.filter(e => e.sourceId === bot.fetchId()).length, 1);
    hit(bot, player);
    assert.strictEqual(Facts.assess(bot, player).responsibility, 'defense', 'human victims also retain the origin');

    // Session-wide defense state cannot excuse an attack on an unrelated bot.
    bot.session.pvpDefense = { action: 'fight' };
    hit(bot, third);
    assert.strictEqual(lastEvent(third, bot).clan.responsibility, 'aggression');
    hit(third, bot);
    const returned = lastEvent(bot, third);
    assert.strictEqual(returned.clan.responsibility, 'defense');
    assert.strictEqual(Clan.apply(Clan.empty(10), returned, now).revision, 0);
    Enemy.record(third, bot, true, now);
    assert.strictEqual(lastEvent(third, bot, 'killed').clan.episode, lastEvent(third, bot).clan.episode,
        'killing blow escalates the same clan incident');

    // Real nearby victim-party membership grants defense against the attacker only.
    const victim = actor(), ally = actor(), distant = actor(), aggressor = actor(false, 20), innocent = actor(false, 20);
    for (const a of [victim, ally, distant]) {
        a.session.coldLifeState = { party: { partyId: 'test-defense' } };
        a.session.testParty = [victim.session, ally.session, distant.session];
    }
    distant.x = 3000;
    hit(aggressor, victim);
    assert(!lastEvent(ally, aggressor), 'witnesses get no fabricated personal offense');
    hit(ally, aggressor);
    assert.strictEqual(lastEvent(aggressor, ally).clan.responsibility, 'defense');
    assert.strictEqual(lastEvent(aggressor, ally).clan.episode, lastEvent(victim, aggressor).clan.episode);
    assert.strictEqual(Facts.assess(distant, aggressor).responsibility, 'unknown');
    hit(ally, innocent);
    assert.strictEqual(lastEvent(innocent, ally).clan.responsibility, 'aggression', 'attackers allies are not guilty by membership');

    // Meaningful healing uses exactly the same first-aggressor evidence.
    const healer = actor(true, 20);
    player.hp = 50;
    Help.recordDamage(player, bot, 5, now);
    assert(Help.record(healer, player, { heal: 20 }, { hp: 30, maxHp: 100, combat: true }, now));
    const aid = lastEvent(bot, healer, 'aided_opponent');
    assert.strictEqual(aid.clan.responsibility, 'aggression');
    assert.strictEqual(aid.clan.episode, first.clan.episode);
    hit(victim, aggressor);
    const defendingHealer = actor(true, 10);
    victim.hp = 50;
    assert(Help.record(defendingHealer, victim, { heal: 20 }, { hp: 30, maxHp: 100, combat: true }, now));
    const defensiveAid = lastEvent(aggressor, defendingHealer, 'aided_opponent');
    assert.strictEqual(defensiveAid.clan.responsibility, 'defense');
    assert.strictEqual(Clan.apply(Clan.empty(20), defensiveAid, now).revision, 0, 'helping the defender has no clan penalty');

    // Known managed sides win, but cannot classify attacks against outsiders.
    const a = actor(), b = actor(), outsider = actor();
    a.session.pvpEncounter = { key: 'managed', reason: 'competition', startedAt: now, seen: [],
        sides: [{ memberIds: [a.fetchId()] }, { memberIds: [b.fetchId()] }] };
    hit(b, a);
    assert.strictEqual(lastEvent(a, b).clan.responsibility, 'provoked');
    hit(a, b);
    assert.strictEqual(lastEvent(b, a).clan.responsibility, 'defense');
    hit(a, outsider);
    assert.strictEqual(lastEvent(outsider, a).clan.responsibility, 'aggression');
    const provoker = actor(), provoked = actor();
    provoker.session.pvpRevenge = { target: provoked, reason: 'mob_competition' };
    hit(provoker, provoked);
    const retained = Facts.snapshot(provoked);
    const restored = { ...provoked, session: { coldLifeState: { stats: { pvpIncidents: JSON.parse(JSON.stringify(retained)) } } } };
    const freshProvoker = { ...provoker, session: {} };
    assert.strictEqual(Facts.assess(freshProvoker, restored).responsibility, 'provoked', 'victim-only snapshot preserves reduced provocation responsibility');

    // Accepted miss/control path and a summon both attribute to the real owner.
    const owner = actor(true), controlled = actor();
    const Attack = invoke('GameServer/Actor/Attack');
    patch(invoke('GameServer/Actor/PvpFlag'), 'mark', () => {});
    assert(Attack.prototype.recordPlayerAggression(owner.session, owner, controlled));
    assert.strictEqual(lastEvent(controlled, owner).clan.responsibility, 'aggression');
    const summonVictim = actor();
    patch(Index, 'actor', id => id === owner.fetchId() ? owner : null);
    const summon = { fetchKind: () => 'Pet', fetchOwnerId: owner.fetchId };
    assert(Threats.record(summonVictim, summon));
    assert.strictEqual(lastEvent(summonVictim, owner).clan.responsibility, 'aggression');
    const excluded = actor(); excluded.session.arenaEphemeral = true;
    assert(!Threats.record(excluded, owner));
    assert.deepStrictEqual(Facts.snapshot(excluded), []);
    const peaceful = actor(); peaceful.x = 99999;
    assert(!Threats.record(peaceful, owner));
    assert.deepStrictEqual(Facts.snapshot(peaceful), []);

    const limited = actor(true);
    for (let n = 0; n < 100; n++) Threats.record(actor(), limited, now);
    assert.strictEqual(Facts.snapshot(limited, now).length, Facts.LIMIT);
    const later = now + Facts.IDLE_MS + 1;
    assert.strictEqual(Facts.assess(bot, player, later).responsibility, 'unknown');
    assert(Threats.record(player, bot, later));
    assert.strictEqual(Facts.assess(bot, player, later).responsibility, 'aggression', 'after inactivity a new first action starts a new conflict');
    console.log('Native PvP responsibility: real damage, misses/control, retaliation, party defense, third parties, aid, summons, managed sides, expiry and bounded writes passed');
} finally { restores.reverse().forEach(restore => restore()); }
