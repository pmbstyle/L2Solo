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
    assert(!helper.session.pvpRevenge, 'a party formed after the decision cannot inherit permission to attack');

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
    assert(Competition.attackChance(aggressive.session, gentle) > Competition.attackChance(gentle.session, aggressive) * 5);
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
        const started = Competition.record(x.rival, x.mob, now + 1, () => 0.6);
        assert.strictEqual(started, variant === 'grievance', `${variant}: prior memory must affect the real provocation path`);
        assert.strictEqual(!!x.bot.session.pvpRevenge, variant === 'grievance');
        if (variant === 'grievance') {
            assert(chance > 0.6);
            assert(events.some(e => e[0] === 'chat' && e[1] === x.bot.id), 'a memory-based escalation still warns first');
        } else assert(chance < 0.6);
        assert.strictEqual(memories.filter(e => e.sourceId === x.bot.id).length, 1, 'physical competition still records exactly one episode');
        for (let i = 2; i <= 100; i++) Competition.record(x.rival, x.mob, now + i, () => 0);
        assert.strictEqual(memories.filter(e => e.sourceId === x.bot.id).length, 1);
    }
    const stranger = setup(true);
    Competition.record(stranger.bot, stranger.mob, now);
    assert(Competition.record(stranger.rival, stranger.mob, now + 1, () => 0.1),
        'an accepted offense can provoke PvP before a bot has accumulated an old grievance');
    assert(stranger.bot.session.pvpRevenge);
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
    const Participation = invoke('GameServer/Bot/AI/BotConflictParticipation');
    const ParticipationPolicy = require('../src/GameServer/Social/ConflictParticipationPolicy');
    const { seeded } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
    const supportTraits = { assertiveness: 1, empathy: 0, commitment: 1, sociability: 1, caution: 0 };
    const bystanderTraits = { assertiveness: 1, empathy: 0, commitment: 0, sociability: 0, caution: 1 };
    const group = (size, level = 40) => {
        const actors = Array.from({ length: size }, () => character(true, level));
        for (const a of actors) {
            if (size > 1) a.session.coldLifeState = { party: { partyId: `vote-${actors[0].id}`, leaderId: actors[0].id } };
            a.session.persona.traits = { ...supportTraits };
            World.user.sessions.push(a.session);
        }
        return actors;
    };
    for (const sizes of [[1, 1], [3, 1], [1, 3], [3, 3], [9, 9]]) {
        const left = group(sizes[0]), right = group(sizes[1], 10);
        const hot = Participation.prepare(left[0].session, right[0], now, seeded('shared-roster'));
        const sides = [left, right].map(actors => ({ principal: { characterId: actors[0].id },
            party: actors.length > 1 ? { leaderId: actors[0].id } : null,
            members: actors.map(a => ({ characterId: a.id, persona: a.session.persona })) }));
        const cold = ParticipationPolicy.select(sides, InteractionMemory, s => s.persona, seeded('shared-roster'), now);
        assert.deepStrictEqual(hot.participants, [...cold.roles].map(([id, role]) => ({ id, role })), `${sizes}: hot/cold participation parity`);
        assert.strictEqual(hot.deescalated, cold.deescalated);
        const reordered = ParticipationPolicy.select(sides.map(s => ({ ...s, members: s.members.slice().reverse() })),
            InteractionMemory, s => s.persona, seeded('shared-roster'), now);
        assert.deepStrictEqual([...reordered.roles], [...cold.roles], 'roster iteration order cannot change a vote');
    }
    const voters = group(3), votedTarget = group(1, 10)[0];
    voters[2].session.persona.traits = { ...bystanderTraits };
    const beforeVoteMemories = memories.length;
    assert(Revenge.request(voters[0].session, votedTarget, 'mob_competition', ['Back off.'], true, now, () => 0.2));
    const voted = voters[0].session.pvpRevenge;
    assert(!voters[1].session.pvpRevenge && !voters[2].session.pvpRevenge, 'support is only intent before the first attack');
    assert.strictEqual(memories.length, beforeVoteMemories, 'a vote creates no negative memory');
    const risk = invoke('GameServer/Bot/AI/BotPvpRisk').defenseDecision(voters[0].session, [votedTarget], {
        allyAllowed: member => Participation.supports(voted.participation, member) && Participation.available(member, now)
    });
    assert.deepStrictEqual(risk.allyIds, [voters[1].id], 'proactive risk counts only available consenting allies');
    Threats.record(votedTarget, voters[0], now + 1);
    assert.strictEqual(voters[1].session.pvpRevenge, voted, 'only the consenting supporter joins');
    assert(!voters[2].session.pvpRevenge, 'bystander stays out of proactive combat');
    const extra = group(1)[0];
    extra.session.coldLifeState = voters[0].session.coldLifeState;
    for (let i = 2; i < 100; i++) Revenge.onAttack(voters[0], votedTarget, now + i, () => { throw Error('must not reroll'); });
    assert(!extra.session.pvpRevenge, 'joining a fighting party does not inherit an earlier vote');
    assert(!voters[2].session.pvpRevenge);
    voters[1].session.coldLifeState = { party: { partyId: 'left-party' } };
    assert(!Revenge.allows(voters[1].session, votedTarget, now + 100), 'departed supporters lose their borrowed permission');
    votedTarget.flag = 1;
    Threats.record(voters[2], votedTarget, now + 101);
    Defense.tick(voters[2].session, voters[2], {}, ai, { now: now + 102, rng: () => 0.2 });
    assert(events.some(e => e[0] === 'attack' && e[1] === voters[2].id && e[2] === votedTarget.id),
        'a former bystander can defend against an actual attack');

    const calming = group(3), calmTarget = group(1, 10)[0];
    calming.forEach(a => { a.session.coldLifeState.party.leaderId = calming[1].id; });
    calming[1].session.persona.traits = { empathy: 1, assertiveness: 0 };
    assert(!Revenge.request(calming[0].session, calmTarget, 'mob_competition', ['Enough.'], true, now, () => 0.2));
    assert(calming[0].session.lastConflictParticipation.deescalated, 'the leader can settle a hot dispute');
    assert(calming.every(a => !a.session.pvpRevenge));

    const majority = group(3), majorityTarget = group(1, 10)[0];
    majority.slice(1).forEach(a => { a.session.persona.traits = { empathy: 1, assertiveness: 0 }; });
    assert(Participation.prepare(majority[0].session, majorityTarget, now, () => 0.2).deescalated,
        'a strict majority can calm an initiating leader');
    const busy = group(2), busyTarget = group(1, 10)[0];
    assert(Revenge.request(busy[0].session, busyTarget, 'mob_competition', ['Back off.'], true, now, () => 0.2));
    busy[1].fakeDeath = true;
    Threats.record(busyTarget, busy[0], now + 1);
    assert(!busy[1].session.pvpRevenge, 'a supporter disabled before the hit cannot join');

    const unloaded = group(2), unloadedTarget = group(1, 10)[0];
    InteractionMemory.forget(unloaded[1].id);
    assert.strictEqual(Participation.prepare(unloaded[0].session, unloadedTarget, now, () => 0.2)
        .participants.find(p => p.id === unloaded[1].id).role, 'stand_aside', 'unloaded memory is not consent');
    const absent = group(2), absentTarget = group(1, 10)[0];
    absent[1].x = Threats.PARTY_RADIUS + 1;
    assert(!Participation.prepare(absent[0].session, absentTarget, now, () => 0.2).participants.some(p => p.id === absent[1].id));

    const delayed = group(2), delayedTarget = group(1, 10)[0];
    Budget.canSend = () => false;
    assert(!Revenge.request(delayed[0].session, delayedTarget, 'mob_competition', ['Wait.'], true, now, () => 0.2));
    assert(delayed[0].session.pendingPvpProvocation);
    delayed[1].session.coldLifeState = { party: { partyId: 'changed-before-warning' } };
    Budget.canSend = () => true;
    assert(!Revenge.flushPending(delayed[0].session, now + 1));
    assert(!delayed[0].session.pendingPvpProvocation && !delayed[0].session.pvpRevenge,
        'a changed party cancels the pending episode without rerolling');

    for (const stage of ['before_selection', 'before_landing']) {
        for (const change of ['member_left', 'leader_changed', 'opponent_leader_changed']) {
            const changed = group(2), opponents = group(2, 10), target = opponents[0];
            const session = changed[0].session;
            assert(Revenge.request(session, target, 'mob_competition', ['Back off.'], true, now, () => 0.2));
            const objective = session.pvpRevenge;
            if (stage === 'before_landing') {
                Defense.tick(session, changed[0], {}, ai, { now: now + 1, rng: () => 0.2 });
                assert(session.pvpDefense && !objective.startedAt);
            }
            const previousParty = { ...changed[1].session.coldLifeState.party };
            if (change === 'member_left') changed[1].session.coldLifeState.party = { partyId: 'left-before-impact' };
            if (change === 'leader_changed') changed.forEach(a => { a.session.coldLifeState.party.leaderId = changed[1].id; });
            if (change === 'opponent_leader_changed') opponents.forEach(a => { a.session.coldLifeState.party.leaderId = opponents[1].id; });
            const beforeCheck = events.length;
            if (stage === 'before_landing') {
                assert(new Attack().blockedPvpDefense(session, changed[0], target), `${change}: native impact must be blocked`);
            } else {
                assert(!Revenge.allows(session, target, now + 2), `${change}: stale permission must be revoked before selection`);
            }
            assert(objective.participation.blocked, 'revocation is sticky for this episode');
            // Rejoining or restoring leadership cannot revive a revoked vote.
            changed[1].session.coldLifeState.party = previousParty;
            changed[0].session.coldLifeState.party.leaderId = changed[0].id;
            opponents.forEach(a => { a.session.coldLifeState.party.leaderId = opponents[0].id; });
            assert(!Revenge.allows(session, target, now + 3));
            Defense.tick(session, changed[0], {}, ai, { now: now + 3, rng: () => { throw Error('must not reroll'); } });
            assert(!events.slice(beforeCheck).some(e => e[0] === 'attack'), 'no new attack after revocation');
            assert(!target.session.pvpAggressors?.size && !target.session.pvpEnemyMemory?.length,
                'cancelled first strikes create no victim aggression history');
            assert(!changed[1].session.pvpRevenge, 'cancelled first strikes never recruit assistance');
        }
    }

    const companions = group(2), humanLeader = character(false), companionTarget = group(1, 10)[0];
    World.user.sessions.push(humanLeader.session);
    companions.forEach(a => { a.session.partyCompanion = true; a.session.followPlayerSession = humanLeader.session; });
    assert.strictEqual(Participation.prepare(companions[0].session, companionTarget, now, () => 0.2), null);
    assert(Revenge.request(companions[0].session, companionTarget, 'mob_competition', ['Back off.'], true, now, () => 0.2));
    Threats.record(companionTarget, companions[0], now + 1);
    assert.strictEqual(companions[1].session.pvpRevenge, companions[0].session.pvpRevenge,
        'player-led companions preserve their existing combat coordination');
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
