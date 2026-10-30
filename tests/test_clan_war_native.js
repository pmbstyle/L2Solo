const assert = require('assert');
require('../src/Global');
const War = invoke('GameServer/Clan/ClanWarRuntime');
const ReceivedHit = invoke('GameServer/Actor/Generics/ReceivedHit');
const Response = invoke('GameServer/Network/Response');
const changes = [], kills = [];
function patch(object, key, value) { const old = object[key]; changes.push(() => { object[key] = old; }); object[key] = value; }
function actor(id, clanId) {
    const a = { hp: 20, karma: 0, pk: 0, pvp: 0, effects: {},
        fetchId: () => id, fetchName: () => `NativeWar${id}`, fetchClanId: () => clanId,
        fetchHp() { return this.hp; }, setHp(v) { this.hp = v; }, fetchMaxHp: () => 100,
        fetchLevel: () => 40, fetchCp: () => 0, fetchMaxCp: () => 0,
        fetchLocX: () => 50000, fetchLocY: () => 15000, fetchLocZ: () => -5000,
        fetchPvpFlag: () => 0, fetchIsOnline: () => true,
        fetchKarma() { return this.karma; }, setKarma(v) { this.karma = v; },
        fetchPk() { return this.pk; }, setPk(v) { this.pk = v; },
        fetchPvp() { return this.pvp; }, setPvp(v) { this.pvp = v; }, setPvpFlag() {},
        statusUpdateVitals() {}, automation: { replenishVitals() {} },
        state: { fetchDead: () => false, fetchSeated: () => false, fetchCombats: () => true } };
    a.session = { actor: a, accountId: `human_war_${id}`, dataSendToMe() {}, dataSendToOthers() {} };
    return a;
}
try {
    for (const key of ['userInfo', 'charInfo', 'relationChanged']) patch(Response, key, () => Buffer.from([0]));
    patch(invoke('Database'), 'updateCharacterPvpPkKarma', () => Promise.resolve());
    patch(invoke('GameServer/Actor/Generics'), 'die', () => {});
    patch(invoke('GameServer/Bot/AI/BotEnemyMemory'), 'record', () => {});
    patch(invoke('GameServer/Bot/AI/BotPvpThreats'), 'record', () => false);
    patch(invoke('GameServer/Social/CombatHelpMemory'), 'recordDefeat', () => {});
    const journal = invoke('PvpJournal'), hotKill = journal.hotKill;
    patch(journal, 'hotKill', row => { kills.push(row); hotKill(row); });
    War.view.replace([{ fromClanId: 10, toClanId: 20, active: 1, revision: 1 }]);
    let killer = actor(1, 10), victim = actor(2, 20);
    ReceivedHit(killer.session, victim, 30);
    assert.equal(killer.pk, 1, 'one-sided declaration does not permit killing a white victim');
    assert(killer.karma > 0); assert(kills[0].pk);
    War.view.accept({ fromClanId: 20, toClanId: 10, active: 1, revision: 2 });
    killer = actor(3, 10); victim = actor(4, 20);
    ReceivedHit(killer.session, victim, 30);
    assert.equal(killer.pk, 0); assert.equal(killer.karma, 0); assert.equal(killer.pvp, 1);
    assert.equal(kills[1].pk, false, 'live PvP journal agrees with the actual kill classification');
    assert.deepEqual(journal.snapshot().map(r => r.warFacts[0]).map(r => [r.fromClanId, r.toClanId, r.victimId, r.killed]),
        [[10, 20, 2, 1], [10, 20, 4, 1]], 'both unilateral PK and mutual PvP report actual clan casualties');
    ReceivedHit(killer.session, victim, 30);
    assert.equal(kills.length, 2, 'a late hit on an already dead character cannot report another casualty');
    killer = actor(5, 10); victim = actor(6, 30);
    ReceivedHit(killer.session, victim, 30);
    assert.equal(killer.pk, 1, 'a third clan remains neutral during someone else’s war');
    War.view.accept({ fromClanId: 20, toClanId: 10, active: 0, revision: 3 });
    killer = actor(7, 10); victim = actor(8, 20);
    ReceivedHit(killer.session, victim, 30);
    assert.equal(killer.pk, 1, 'war withdrawal takes effect at the native impact');
    const beforeExcluded = kills.length, npc = actor(99, 0);
    npc.fetchKind = () => 'Monster';
    ReceivedHit(npc.session, actor(100, 20), 30);
    assert.equal(kills.length, beforeExcluded, 'ordinary PvE deaths never enter clan casualty accounting');
    const arena = invoke('GameServer/World/ArenaCombatRules'), suppress = arena.suppressConsequences;
    try {
        arena.suppressConsequences = () => true;
        ReceivedHit(killer.session, actor(101, 20), 30);
        assert.equal(kills.length, beforeExcluded, 'arena deaths do not become clan casualties');
    } finally { arena.suppressConsequences = suppress; }
    {
        const Service = invoke('GameServer/World/ArenaDuelService'), original = Service.duelForActor, previous = War.view.all();
        const human = actor(501, 10), clone = actor(502, 20), stamp = Date.now() - 1000;
        const duel = { state: 'FIGHTING', player: human, bot: clone };
        try {
            War.view.accept({ fromClanId: 20, toClanId: 10, active: 1, revision: 4 });
            War.recordCombat(human, clone, stamp);
            clone.session.arenaEphemeral = true; human.session.arenaDuelId = 'war-clock-test';
            Service.duelForActor = a => [human, clone].includes(a) ? duel : null;
            assert(arena.canInteract(human, clone) && arena.suppressConsequences(human, clone));
            ReceivedHit(human.session, clone, 30);
            assert.equal(War.combatAt(10, 20), stamp, 'an actual arena hit cannot extend the world war clock');
            War.recordCombat(human, clone, stamp + 500);
            assert.equal(War.combatAt(10, 20), stamp, 'the war runtime also rejects direct arena contacts');
            assert.equal(kills.length, beforeExcluded);
        } finally { Service.duelForActor = original; War.view.replace(previous); }
    }
    const Start = invoke('GameServer/Bot/AI/BotClanWar'), Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
    const Risk = invoke('GameServer/Bot/AI/BotPvpRisk'), World = invoke('GameServer/World/World');
    const attacker = actor(9, 10), enemy = actor(10, 20), tagged = actor(11, 10), neutral = actor(12, 30), human = actor(13, 10);
    for (const a of [attacker, tagged, neutral]) { a.session.accountId = `bot_war_${a.fetchId()}`; a.session.plan = 'hunting'; }
    let scans = 0, riskAllies;
    patch(invoke('GameServer/Effects/EffectRestrictions'), 'canUseBasicAction', () => true);
    patch(World, 'fetchVisibleUsers', () => { scans++; return [enemy.session]; });
    patch(Threats, 'members', () => [attacker.session, tagged.session, neutral.session, human.session]);
    patch(Risk, 'defenseDecision', (_session, _targets, options) => {
        riskAllies = [tagged.session, neutral.session, human.session].filter(options.allyAllowed); return { action: 'fight' };
    });
    assert(!Start.tryStart(attacker.session), 'an incoming-only opponent is not a military target');
    assert.equal(scans, 0, 'bots outside mutual wars do not scan nearby users for war targets');
    War.view.accept({ fromClanId: 20, toClanId: 10, active: 1, revision: 4 });
    assert(Start.tryStart(attacker.session));
    assert.equal(attacker.session.pvpRevenge.reason, 'clan_war');
    assert.equal(tagged.session.pvpRevenge.reason, 'clan_war');
    assert.deepEqual(riskAllies, [tagged.session], 'the tactical decision counts only eligible war participants');
    assert(!neutral.session.pvpRevenge && !human.session.pvpRevenge, 'war cannot commandeer neutral companions or human party members');
    console.log('Clan war native impact: one-sided PK, white mutual-war PvP, neutral third clans, withdrawal and journal parity passed');
} finally { changes.reverse().forEach(f => f()); War.view.replace([]); }
