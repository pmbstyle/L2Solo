const assert = require('node:assert/strict');
require('../src/Global');

const World = invoke('GameServer/World/World');
const Manager = invoke('GameServer/Bot/BotManager');
const Raid = invoke('GameServer/Bot/AI/PlayerPartyRaid');
const Safety = invoke('GameServer/Bot/AI/BotRaidSafety');
const Revival = invoke('GameServer/Bot/AI/PartyRevivalService');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Effects = invoke('GameServer/Effects/EffectStore');
const Visibility = invoke('GameServer/Bot/AI/BotHuntingVisibility');
const ClassTactics = invoke('GameServer/Bot/AI/PartyClassTactics');
const Skill = invoke('GameServer/Model/Skill');
const Revive = invoke('GameServer/Actor/Generics/Revive');
const Support = invoke('GameServer/Bot/AI/BotSupportPlanner');
const Pulling = invoke('GameServer/Bot/AI/PartyPulling');

const restores = [];
function patch(object, key, value) {
    const old = object[key];
    restores.push(() => { object[key] = old; });
    object[key] = value;
}
function actor(id, classId = 1) {
    const a = { hp: 1000, mp: 1000, x: 0, y: 0, z: 0, dead: false, level: 40, destId: null, skills: [],
        fetchId: () => id, fetchSelfId: () => id, fetchName: () => `member_${id}`,
        fetchClassId: () => classId, fetchLevel: () => a.level, fetchIsOnline: () => a.online !== false,
        fetchLocX: () => a.x, fetchLocY: () => a.y, fetchLocZ: () => a.z,
        fetchHp: () => a.hp, fetchMaxHp: () => 1000, fetchMp: () => a.mp, fetchMaxMp: () => 1000,
        fetchPDef: () => 100, fetchClanId: () => 0, fetchHead: () => 0,
        fetchDestId: () => a.destId, fetchAttackable: () => !!a.npc,
        fetchIsRaidBoss: () => !!a.boss, isDead: () => a.dead, canUseSkill: () => true,
        select({ id: target }) { a.destId = target; }, unselect() { a.destId = null; },
        clearDestId() { a.destId = null; },
        setHp(hp) { a.hp = hp; }, refreshVitalsRegeneration() {},
        moveTo(data) { a.moves.push(data); }, moves: [],
        backpack: { fetchTotalWeaponKind: () => 'Weapon.Sword', fetchEquippedArmors: () => [], fetchItems: () => [] },
        skillset: { fetchSkill: id => a.skills.find(s => s.fetchSelfId() === id), fetchSkills: () => a.skills,
            get skills() { return a.skills; } },
        automation: { fetchDestId: () => a.actionTarget, replenishVitals() {}, stopReplenish() {},
            abortAll() { a.moving = false; a.hitting = false; }, scheduleAction(_s, _a, target, _range, callback) {
                a.actionTarget = target.fetchId(); a.scheduled = callback;
            } },
        attack: { abortCast() { a.casting = false; }, clearTimers() {}, resetQueuedEvent() {},
            remoteHit() { a.casting = true; } },
        state: { fetchDead: () => a.dead, setDead(v) { a.dead = v; },
            fetchHits: () => !!a.hitting, setHits(v) { a.hitting = v; },
            fetchCasts: () => !!a.casting, setCasts(v) { a.casting = v; },
            fetchTowards: () => !!a.moving, fetchSeated: () => !!a.seated, setSeated(v) { a.seated = v; },
            fetchCombats: () => !!a.combats }
    };
    return a;
}
function session(a, owner = null) {
    const s = { actor: a, accountId: owner ? `bot_${a.fetchId()}` : 'player_raid',
        plan: 'following', dataSendToOthers() {}, dataSendToMeAndOthers() {}, dataSendToMe() {} };
    a.session = s;
    if (owner) Object.assign(s, { partyCompanion: true, followPlayerSession: owner });
    return s;
}
const realSupport = Tactics.support;
const realRevival = Revival.tick;
function fixture(playerClass = 12) {
    const owner = session(actor(1, playerClass));
    const tank = session(actor(2, 5), owner);
    const damage = session(actor(3, 1), owner);
    const healer = session(actor(4, 15), owner);
    const boss = actor(900); boss.boss = true; boss.npc = true; boss.x = 100;
    const add = actor(901); add.npc = true; add.minionBossObjectId = 900; add.x = 120;
    const second = actor(902); second.npc = true; second.minionBossObjectId = 900; second.x = 140;
    const field = actor(899); field.npc = true; field.x = 80;
    owner.actor.destId = boss.fetchId();
    const sessions = [owner, tank, damage, healer];
    World.user = { sessions }; Manager.sessions = sessions.slice(1);
    World.npc = { spawns: [boss, add, second, field] };
    World.fetchNpcsInRadius = () => World.npc.spawns;
    const attacks = [], casts = [];
    const generics = { skillExec(s, _a, data) { casts.push({ s, ...data }); } };
    const ai = { executeCombat(s, a, target, _g, options) {
        attacks.push({ s, target, options }); a.hitting = true;
    } };
    Tactics.support = () => false;
    Revival.tick = () => ({ handled: false });
    const tick = (s, now = Date.now()) => Raid.tick(s, s.actor, generics, ai, now);
    return { owner, tank, damage, healer, boss, add, second, field, sessions, attacks, casts, generics, ai, tick };
}
try {
    patch(World, 'user', {}); patch(World, 'npc', {}); patch(World, 'fetchNpcsInRadius', () => []);
    patch(Manager, 'sessions', []);
    patch(Tactics, 'support', () => false); patch(Revival, 'tick', () => ({ handled: false }));
    patch(Visibility, 'canSee', () => true);
    patch(Threats, 'context', () => ({ threats: [] }));

    for (const [classId, skillId] of [[21, 264], [34, 271]]) {
        const f = fixture(24);
        const musician = session(actor(5, classId), f.owner);
        const music = new Skill({ selfId: skillId, level: 1, passive: false, mp: 60, distance: 1000 });
        musician.actor.skills = [music];
        musician.actor.hitting = true;
        f.sessions.push(musician);
        Manager.sessions.push(musician);
        f.boss.destId = f.tank.actor.fetchId();
        let missing = true;
        const queued = [];
        patch(Support, 'nextPartyAction', (recipients, providers, options) => {
            assert.equal(options.musicOnly, true);
            assert.equal(options.allowAttackInterrupt, true);
            assert(recipients.some(member => member.actor === f.owner.actor), 'Party music must include the player');
            assert(!providers.includes(f.tank.actor) && !providers.includes(f.healer.actor),
                'Music renewal must not interrupt the main tank or healer');
            return missing && providers.includes(musician.actor)
                ? { provider: musician.actor, target: musician.actor, skill: music } : null;
        });
        patch(Support, 'queueSupportCast', (provider, action) => queued.push({ provider, action }));
        try {
            f.tick(f.damage);
            assert.equal(f.attacks.at(-1).s, f.damage, 'A pending song or dance must not pause other DDs');
            f.tick(musician);
            assert.equal(f.casts.at(-1).selfId, skillId, 'An attacking singer or dancer must renew expired music');
            assert.equal(musician.actor.hitting, false, 'Stop the native weapon cycle before casting music');
            assert.equal(queued.at(-1).provider, musician, 'Music must use the native support reservation');
            assert.equal(musician.lastDecision.action, 'raid_rebuff');
            musician.actor.casting = true;
            const casts = f.casts.length;
            f.tick(musician);
            assert.equal(f.casts.length, casts, 'An active music cast must not restart each AI tick');
            musician.actor.casting = false;
            missing = false;
            f.tick(musician);
            assert.equal(f.attacks.at(-1).s, musician, 'After renewing music the fighter must resume combat');
        } finally { restores.pop()(); restores.pop()(); }
    }

    for (const playerClass of [0, 1, 9, 12, 15, 21, 52]) {
        const f = fixture(playerClass);
        f.tank.actor.skills = [new Skill({ selfId: 28, level: 1, passive: false, mp: 10, distance: 600 })];
        f.tick(f.damage);
        assert.equal(f.attacks.length, 0, 'a damage bot must wait for actual tank aggro for every player class');
        assert.equal(f.owner.partyRaidEngagement.mainTankId, f.tank.actor.fetchId());
        assert.equal(f.owner.partyPullState.type, 'raid');
        assert.deepEqual(f.owner.partyPullState.origin, { locX: 0, locY: 0, locZ: 0 });
        f.tick(f.tank);
        assert.equal(f.casts[0].selfId, 28, 'only the main tank opens with aggression');
        f.tick(f.damage);
        assert.equal(f.attacks.length, 0, 'issuing the taunt does not prove it landed');
        f.boss.destId = f.tank.actor.fetchId();
        f.tick(f.damage);
        assert.equal(f.attacks.at(-1).target, f.add);
        f.tick(f.damage);
        assert.equal(f.attacks.length, 1, 'a native attack cycle must not restart on every tick');
        f.boss.destId = f.damage.actor.fetchId();
        f.tick(f.damage);
        assert.equal(f.damage.actor.hitting, false, 'the bot that overaggroed must stop adding damage');
        f.owner.backgroundRaidActionClaims.clear();
        f.tick(f.tank);
        assert.equal(f.casts.at(-1).id, f.boss.fetchId(), 'main tank retakes boss rather than chasing the add');
    }

    {
        const f = fixture();
        f.boss.destId = f.tank.actor.fetchId();
        f.healer.actor.skills = [new Skill({ selfId: 1177, level: 1, passive: false, mp: 10, distance: 600 })];
        f.tick(f.healer);
        assert.equal(f.healer.lastDecision.action, 'raid_healer_ready');
        assert.equal(f.attacks.length + f.casts.length, 0, 'full mana must not cause a healer to attack with Wind Strike');
        f.healer.actor.skills.push(new Skill({ selfId: 1069, level: 1, passive: false, mp: 10, distance: 600 }));
        f.add.x = 1000; f.second.x = 1100;
        f.tick(f.healer);
        assert.equal(f.casts.length, 0, 'a healer must not chase distant adds to cast Sleep');
        assert.equal(f.healer.lastDecision.action, 'raid_healer_ready');
        f.healer.actor.skills.pop(); f.add.x = 120; f.second.x = 140;
        f.healer.actor.hitting = true;
        f.healer.currentTargetId = f.add.fetchId(); f.healer.actor.destId = f.add.fetchId();
        f.healer.actor.seated = true; f.healer.actor.x = 1100;
        f.tick(f.healer);
        assert.equal(f.healer.actor.hitting, false, 'a stale healer weapon cycle must be canceled');
        assert.equal(f.healer.actor.seated, false, 'a healer stands before returning to the tank');
        assert.equal(f.healer.lastDecision.action, 'raid_heal_approach');
        assert.equal(f.healer.actor.moves.at(-1).to.locX, f.tank.actor.x);
        f.healer.actor.moving = true;
        const routes = f.healer.actor.moves.length;
        f.tick(f.healer);
        assert.equal(f.healer.actor.moving, true, 'support movement must not be canceled by the shared combat tick');
        assert.equal(f.healer.actor.moves.length, routes);
        f.healer.actor.x = 0; f.healer.actor.moving = false; f.healer.actor.mp = 500;
        f.add.destId = f.healer.actor.fetchId();
        f.tick(f.healer);
        assert.equal(f.healer.actor.seated, false, 'an attacked healer must not sit');
        assert.equal(f.attacks.length, 0, 'an unsafe recovery position must not fall through to damage');
        f.add.destId = null;
        f.tick(f.healer);
        assert.equal(f.healer.actor.seated, true);
        f.healer.actor.mp = 1000;
        f.tick(f.healer);
        assert.equal(f.healer.actor.seated, false);
        assert.equal(f.healer.lastDecision.action, 'raid_healer_ready');
        assert.equal(f.attacks.length, 0);
    }
    {
        const f = fixture(5);
        f.tick(f.tank);
        assert.equal(f.attacks.length + f.casts.length, 0, 'bots do not open for a human tank');
        f.boss.destId = f.owner.actor.fetchId();
        f.tick(f.tank);
        assert.equal(f.owner.partyRaidEngagement.mainTankId, f.owner.actor.fetchId());
        assert.equal(f.attacks[0].target, f.add, 'the bot tank handles adds when the player holds the boss');
    }
    {
        const f = fixture();
        f.owner.partyCompanionSettings = { pullMode: 'leader' };
        f.boss.destId = f.tank.actor.fetchId();
        f.tick(f.damage);
        const raidPull = f.owner.partyPullState;
        const ordinaryPull = Pulling.current(f.owner, f.owner.partyCompanionSettings);
        assert.equal(f.owner.partyPullState, raidPull,
            'ordinary pull inspection must preserve the active raid state');
        assert.equal(ordinaryPull.target, null, 'a raid boss must never enter the ordinary pull path');
        assert.equal(ordinaryPull.enabled, false, 'raid combat owns the pull while the encounter is active');
        f.tick(f.healer);
        assert.equal(f.owner.partyPullState, raidPull, 'companion ticks must reuse the same raid pull');
    }
    {
        const f = fixture(21);
        const aggression = new Skill({ selfId: 28, level: 1, passive: false, mp: 10, distance: 600 });
        f.owner.actor.skills = [aggression];
        const spare = session(actor(5, 5), f.owner);
        spare.actor.skills = [aggression]; spare.actor.x = 200;
        f.sessions.push(spare); Manager.sessions.push(spare);
        f.boss.destId = f.tank.actor.fetchId();
        f.add.destId = f.healer.actor.fetchId();
        f.tick(spare);
        assert.equal(f.casts[0].id, f.add.fetchId(), 'a human with Aggression cannot reserve a rescue action away from bots');
        assert.equal(f.casts[0].s, spare);
    }
    {
        const f = fixture();
        f.owner.actor.destId = f.field.fetchId();
        assert.equal(f.tick(f.tank), false, 'ordinary hunting beside a boss cannot become a raid');
        f.owner.actor.destId = f.boss.fetchId();
        f.owner.partyCompanionSettings = { pullMode: 'off' };
        assert.equal(f.tick(f.tank), false, 'pull off prevents an automatic raid opener');
        f.owner.partyCompanionSettings.pullMode = 'bot';
        f.owner.partyPullState = { targetId: f.field.fetchId(), phase: 'approach' };
        assert.equal(f.tick(f.tank), false, 'an ongoing ordinary pull must keep its target');
        f.owner.partyPullState = {};
        f.boss.x = 1500;
        assert.equal(f.tick(f.tank), false, 'selected distant bosses cannot be pulled from the hunting scan radius');
        f.boss.x = 100; f.boss.z = 800;
        assert.equal(f.tick(f.tank), false, 'a boss on a different floor cannot start a pull');
        f.boss.z = 0; Visibility.canSee = () => false;
        assert.equal(f.tick(f.tank), false, 'a blocked line of sight cannot start a raid');
        Visibility.canSee = () => true;
        f.tick(f.damage);
        const origin = f.owner.partyRaidEngagement.pullOrigin;
        f.owner.actor.x = 500;
        assert.equal(f.owner.partyRaidEngagement.pullOrigin, origin, 'the raid origin stays fixed when the player moves');
    }
    {
        const f = fixture();
        f.boss.destId = f.tank.actor.fetchId();
        f.owner.actor.destId = f.field.fetchId();
        // Establish the explicit engagement before the human selects a heal/field target.
        f.owner.actor.destId = f.boss.fetchId(); f.tick(f.damage);
        f.owner.actor.destId = null; f.damage.actor.hitting = false;
        f.tick(f.tank);
        assert.equal(f.attacks.at(-1).target, f.boss, 'the tank assignment survives player retargeting');
        f.tank.actor.hitting = false; f.tank.actor.hp = 400; f.boss.x = 30;
        f.tank.actor.skills = [new Skill({ selfId: 110, level: 1, passive: false, mp: 10 })];
        f.tick(f.tank);
        assert.equal(f.casts.at(-1).selfId, 110, 'a companion main tank uses native UD under boss pressure');
    }
    {
        const f = fixture();
        f.damage.actor.x = 1100;
        f.tick(f.tank);
        assert.equal(f.attacks.length + f.casts.length, 0, 'the raid opener waits for distant companions');
        f.tick(f.damage);
        assert.equal(f.damage.actor.moves.at(-1).to.locX, 0, 'the distant companion moves to the frozen pull origin');
        f.damage.actor.x = 0;
        f.tank.actor.hp = 400;
        f.healer.actor.x = 650;
        f.healer.actor.skills = [new Skill({ selfId: 1011, level: 1, passive: false, distance: 600, mp: 10, power: 100 })];
        Tactics.support = realSupport;
        f.tick(f.healer);
        assert.equal(f.healer.actor.moves.at(-1).to.locX, f.tank.actor.x,
            'a healer approaches the low-HP opener when its learned heal is out of range');
    }
    {
        const f = fixture();
        f.tank.actor.moveTo = () => { f.tank.lastPathfinding = { routeUsable: false }; };
        f.tick(f.tank);
        assert.equal(f.attacks.length + f.casts.length, 0, 'an unreachable boss must never get an opening attack');
        assert.equal(f.tank.lastDecision.action, 'raid_unreachable');
        assert.equal(f.owner.partyRaidEngagement, undefined);
        assert.equal(f.tick(f.tank), false, 'an unreachable selected boss must not be retried every tick');
    }
    {
        const f = fixture();
        f.tick(f.tank);
        f.tank.actor.hitting = false; f.tank.actor.moving = true;
        f.tank.actor.actionTarget = f.boss.fetchId();
        assert.equal(Safety.syncPlayerPartyRaid(f.owner).phase, 'opening', 'a bot approach alone does not establish raid combat');
        f.owner.partyCompanionSettings = { pullMode: 'off' };
        assert.equal(Safety.syncPlayerPartyRaid(f.owner), null);
        assert.equal(f.tank.actor.moving, false, 'Pull Off cancels a pending boss approach before the hit lands');
    }
    {
        const f = fixture();
        f.tick(f.damage);
        f.boss.destId = f.tank.actor.fetchId();
        f.owner.actor.destId = f.healer.actor.fetchId();
        assert.equal(Safety.syncPlayerPartyRaid(f.owner).phase, 'combat',
            'the first confirmed aggro survives a simultaneous player retarget to a party member');
    }
    {
        const f = fixture();
        f.boss.destId = f.tank.actor.fetchId();
        Effects.apply(f.add, { key: 'sleep', id: 1069, category: 'sleep', type: 'debuff', durationMs: 30000 });
        f.tick(f.damage);
        assert.equal(f.attacks.at(-1).target, f.second, 'damage skips the sleeping add');
        f.damage.actor.hitting = false;
        Effects.apply(f.second, { key: 'sleep', id: 1069, category: 'sleep', type: 'debuff', durationMs: 30000 });
        f.tick(f.damage);
        assert.equal(f.attacks.at(-1).target, f.boss, 'multiple sleeping minions stay asleep');
        f.second.dead = true; f.damage.actor.hitting = false;
        f.tick(f.damage);
        assert.equal(f.attacks.at(-1).target, f.add, 'the last living sleeping minion is deliberately finished');
        assert.equal(Safety.hasControlledRaidMinion(f.boss), false, 'the final sleeping minion no longer prohibits finishing area damage');
        f.healer.actor.skills = [new Skill({ selfId: 1069, level: 1, passive: false, mp: 10, distance: 600 })];
        Effects.remove(f.add, 'sleep');
        assert.equal(ClassTactics.supportCrowdControl(f.healer.actor, [f.add], {
            raid: true, primaryTargetId: f.add.fetchId()
        }), null, 'the final damage target must not be put back to sleep');
    }
    {
        const f = fixture();
        f.boss.destId = f.tank.actor.fetchId(); f.tick(f.damage);
        f.damage.actor.level = 49; f.damage.actor.hitting = false;
        f.tick(f.damage);
        assert.equal(f.damage.lastDecision.action, 'raid_level_ineligible', 'overlevel bots must not attack or support this raid');
        f.damage.actor.level = 40;
        f.tank.actor.dead = true; f.tank.actor.hp = 0;
        const escaped = [];
        const original = Safety.retreat;
        Safety.retreat = (s, a) => { escaped.push(a.fetchId()); s.plan = 'fleeing'; a.hitting = false; };
        try {
            f.tick(f.damage); f.tick(f.healer);
            assert.equal(f.owner.partyRaidEngagement.phase, 'retreat');
            assert.deepEqual(escaped, [f.damage.actor.fetchId(), f.healer.actor.fetchId()], 'all surviving bots leave when the main tank dies');
            for (const s of [f.owner, f.damage, f.healer]) s.actor.x = 4000;
            f.boss.destId = null;
            f.tick(f.damage);
            assert.equal(f.owner.partyRaidEngagement, undefined);
            assert.equal(f.tick(f.damage), false, 'the same selected boss cannot restart the failed pull');
            assert.equal(f.boss.hp, 1000, 'player-led retreat does not reset shared boss HP');
        } finally { Safety.retreat = original; }
    }
    {
        const f = fixture();
        f.boss.destId = f.tank.actor.fetchId(); f.tick(f.damage);
        f.tank.actor.dead = true;
        const spare = session(actor(5, 5), f.owner);
        f.sessions.push(spare); Manager.sessions.push(spare);
        f.boss.destId = spare.actor.fetchId();
        f.tick(f.healer);
        assert.equal(f.owner.partyRaidEngagement.phase, 'combat', 'a secondary tank already holding the boss can preserve the encounter');
        assert.equal(f.owner.partyRaidEngagement.mainTankId, spare.actor.fetchId());
    }
    {
        const f = fixture();
        f.boss.destId = f.tank.actor.fetchId(); f.tick(f.damage);
        Tactics.support = realSupport; Revival.tick = realRevival;
        f.damage.actor.dead = true; f.damage.actor.hp = 0;
        f.owner.actor.dead = true; f.owner.actor.hp = 0;
        const resurrect = new Skill({ selfId: 1016, level: 1, passive: false, mp: 10, distance: 600 });
        f.healer.actor.skills = [resurrect];
        assert.equal(Revival.combatResurrectionAllowed(f.owner), true, 'human death does not abort a raid held by a living bot tank');
        const result = Revival.tick(f.healer, f.owner, f.generics);
        assert.equal(result.target, f.owner.actor, 'restore the human first while the tank keeps the encounter');
        Revive(f.owner, f.owner.actor, { delayMs: 0, helper: f.healer.actor });
        f.owner.actor.hp = 1000; // Healing the revived human takes priority over another resurrection.
        const next = Revival.tick(f.healer, f.owner, f.generics);
        assert.equal(next.target, f.damage.actor, 'multiple dead members can be rescued in the same raid');
        f.healer.actor.casting = true; f.boss.destId = f.healer.actor.fetchId();
        Revival.tick(f.healer, f.owner, f.generics);
        assert.equal(f.owner.partyRevivalAttempt, null, 'direct attacks interrupt an unsafe resurrection attempt');
        f.boss.destId = f.tank.actor.fetchId(); f.healer.actor.casting = false;
        f.tank.actor.hp = 300;
        assert.equal(Revival.tick(f.healer, f.owner, f.generics).handled, false, 'a healer cannot sacrifice critical tank care for resurrection');
    }
    {
        const f = fixture();
        Revival.tick = realRevival;
        f.damage.actor.dead = true; f.damage.actor.hp = 0;
        f.healer.actor.skills = [new Skill({ selfId: 1016, level: 1, passive: false, mp: 10, distance: 600 })];
        f.tick(f.healer);
        assert.equal(f.owner.partyRaidEngagement.phase, 'opening');
        assert.equal(f.owner.partyRevivalAttempt?.targetId, f.damage.actor.fetchId(),
            'a selected boss must not prevent preparation resurrection before anyone has pulled');
    }
    {
        const f = fixture();
        Tactics.support = realSupport;
        f.boss.destId = f.tank.actor.fetchId();
        f.tank.actor.hp = 400; f.healer.actor.x = 650; f.healer.actor.hitting = true;
        f.healer.actor.skills = [new Skill({ selfId: 1011, level: 1, passive: false, mp: 10, distance: 600 })];
        f.healer.currentTargetId = f.add.fetchId(); f.healer.actor.destId = f.add.fetchId();
        f.tick(f.healer);
        assert.equal(f.healer.lastDecision.action, 'raid_heal_approach',
            'an out-of-range tank heal preempts the healer weapon cycle');
        assert.equal(f.healer.actor.hitting, false);
        assert.equal(f.healer.actor.moves.at(-1).to.locX, f.tank.actor.x);
        f.healer.actor.moving = true;
        const routes = f.healer.actor.moves.length;
        f.tick(f.healer);
        assert.equal(f.healer.actor.moves.length, routes, 'an active heal approach must not restart every AI tick');
    }
    {
        const f = fixture();
        Revival.tick = realRevival;
        f.boss.destId = f.tank.actor.fetchId(); f.tick(f.damage);
        f.damage.actor.dead = true;
        f.healer.actor.skills = [new Skill({ selfId: 1016, level: 1, passive: false, mp: 10, distance: 600 })];
        Revival.tick(f.healer, f.owner, f.generics);
        f.healer.actor.casting = true;
        const original = Threats.context;
        Threats.context = s => ({ threats: s === f.healer ? [{}] : [] });
        try {
            Revival.tick(f.healer, f.owner, f.generics);
            assert.equal(f.owner.partyRevivalAttempt, null, 'a new PvP threat cancels the pending resurrection');
            assert.equal(f.healer.actor.casting, false);
        } finally { Threats.context = original; }
    }
    {
        const f = fixture();
        f.boss.destId = f.tank.actor.fetchId(); f.tick(f.damage);
        f.damage.actor.combats = true;
        f.tank.actor.dead = true;
        const planner = invoke('GameServer/Bot/AI/BotRetreatPlanner');
        const original = planner.retreat;
        planner.retreat = () => true;
        try {
            f.tick(f.damage);
            assert.equal(f.damage.actor.fetchDestId(), null, 'retreat clears a selected minion, not just the boss');
            for (const s of [f.owner, f.damage, f.healer]) s.actor.x = 4000;
            f.boss.destId = null;
            f.tick(f.damage);
            assert.equal(f.owner.partyRaidEngagement, undefined, 'a stale combat flag cannot trap an escaped party');
        } finally { planner.retreat = original; }
    }
    {
        const f = fixture();
        const control = invoke('GameServer/Npc/SummonControl');
        const originalStop = control.stop, originalFollow = control.startFollowOwner;
        const stopped = [];
        control.stop = (_s, pet) => { stopped.push(pet.fetchId()); pet.controlMode = 'idle'; delete pet.attackTargetId; };
        control.startFollowOwner = (_s, _a, pet) => { pet.controlMode = 'follow'; };
        const pet = (owner, id) => ({ fetchId: () => id, fetchOwnerId: () => owner.actor.fetchId(),
            controlMode: 'attack', attackTargetId: f.add.fetchId(), isDead: () => false,
            automation: { scheduleAction() {} } });
        try {
            f.damage.actor.summon = pet(f.damage, 903);
            f.owner.actor.summon = pet(f.owner, 904);
            f.tick(f.damage);
            assert.equal(f.damage.actor.summon.controlMode, 'follow', 'a waiting DD stops its independent servitor attack');
            assert.equal(f.owner.actor.summon.controlMode, 'attack', 'the human keeps control of his own servitor');
            f.boss.destId = f.tank.actor.fetchId();
            f.damage.actor.summon.controlMode = 'attack'; f.damage.actor.summon.attackTargetId = f.add.fetchId();
            f.damage.actor.casting = true;
            Effects.apply(f.add, { key: 'sleep', id: 1069, category: 'sleep', type: 'debuff', durationMs: 30000 });
            f.tick(f.damage);
            assert.equal(f.damage.actor.summon.controlMode, 'follow', 'sleep protection applies even while the owner is casting');
            f.second.dead = true;
            f.damage.actor.summon.controlMode = 'attack'; f.damage.actor.summon.attackTargetId = f.add.fetchId();
            f.tick(f.damage);
            assert.equal(f.damage.actor.summon.controlMode, 'attack', 'a servitor may finish the last sleeping minion');
            f.tank.actor.dead = true;
            const planner = invoke('GameServer/Bot/AI/BotRetreatPlanner');
            const original = planner.retreat; planner.retreat = () => true;
            try { f.tick(f.damage); } finally { planner.retreat = original; }
            assert.equal(f.damage.actor.summon.controlMode, 'follow', 'the servitor retreats with its owner');
            assert.equal(f.damage.actor.casting, false);
            assert.equal(stopped.length, 3);
            f.damage.actor.summon.controlMode = 'attack';
            f.damage.actor.summon.attackTargetId = f.add.fetchId();
            assert.equal(Safety.endPlayerPartyRaid(f.owner), true);
            assert.equal(f.damage.actor.summon.controlMode, 'follow', 'ending a raid cancels independent summon attacks');
            assert.equal(f.owner.actor.summon.controlMode, 'attack', 'the leader retains his summon order until native travel handles it');
            assert.equal(stopped.length, 4);
        } finally { control.stop = originalStop; control.startFollowOwner = originalFollow; }
    }
    {
        const f = fixture();
        f.owner.actor.destId = f.field.fetchId();
        f.owner.partyPullState = { targetId: f.field.fetchId(), phase: 'approach' };
        f.damage.actor.hitting = true;
        assert.equal(Safety.endPlayerPartyRaid(f.owner), false, 'ordinary hunting does not receive raid cleanup');
        assert.equal(f.owner.partyPullState.targetId, f.field.fetchId());
        assert.equal(f.damage.actor.hitting, true);
    }
    {
        const f = fixture();
        const Teleport = invoke('GameServer/Actor/Generics/TeleportTo');
        const Generics = invoke('GameServer/Actor/Generics');
        const AI = invoke('GameServer/Bot/BotAI');
        const pending = [], wakeups = [];
        const originalTimeout = global.setTimeout;
        patch(Generics, 'teleportTo', Teleport);
        patch(Generics, 'updatePosition', (_s, a, point) => { a.x = point.locX; a.y = point.locY; a.z = point.locZ; });
        patch(Generics, 'revive', (_s, a) => { a.dead = false; a.hp = 1000; a.mp = 1000; });
        patch(AI, 'wakeup', s => wakeups.push(s));
        f.boss.destId = f.tank.actor.fetchId(); f.tick(f.damage);
        f.healer.actor.casting = true;
        f.healer.currentTargetId = f.damage.actor.fetchId();
        f.owner.partyRevivalAttempt = { providerId: f.healer.actor.fetchId(), targetId: f.damage.actor.fetchId() };
        f.tank.plan = 'fleeing'; f.tank.raidSafetyResumePlan = 'following';
        f.owner.playerRaidChatter = { bossId: f.boss.fetchId() };
        f.damage.actor.dead = true; f.damage.actor.hp = 0;
        for (const s of f.sessions.slice(1)) s.aiActive = true;
        global.setTimeout = fn => { pending.push(fn); return pending.length; };
        try {
            assert.equal(Teleport(f.owner, f.owner.actor, { locX: 20000, locY: 20000, locZ: 0 }), true);
            assert.equal(f.owner.partyRaidEngagement, undefined, 'raid ends before the teleport arrival callback');
            assert.equal(f.owner.partyRevivalAttempt, undefined, 'old resurrection intent must be discarded');
            assert.equal(f.owner.playerRaidChatter, undefined);
            assert.deepEqual(f.owner.partyPullState, {});
            assert.equal(f.healer.actor.casting, false, 'friendly resurrection casts stop too');
            assert.equal(f.damage.actor.hitting, false, 'a fallen member loses its stale attack loop');
            assert.equal(f.tank.plan, 'following');
            assert.equal(f.tank.raidSafetyResumePlan, undefined);
            assert.equal(f.tank.aiScheduleGeneration, 1, 'queued raid AI ticks are invalidated immediately');
            // NPC aggro can still point at the old party until native NPC AI
            // disengages. It must not recreate a raid while teleporting.
            assert.equal(f.boss.destId, f.tank.actor.fetchId(), 'ending our raid does not reset shared boss state');
            f.owner.actor.destId = f.boss.fetchId();
            assert.equal(Safety.syncPlayerPartyRaid(f.owner), null);
            AI.tick(f.healer); // Native entry point must ignore even an urgent wakeup.
            f.owner.actor.destId = null;
            assert.equal(f.owner.actor.x, 0, 'native location changes only on arrival');
            pending.shift()();
            assert.equal(f.owner.pendingActorTeleport, undefined);
            assert.equal(f.owner.actor.x, 20000);
            assert.equal(pending.length, 3, 'every companion uses the native delayed teleport');
            assert.equal(f.damage.actor.dead, false, 'native leader travel still recovers dead companions');
            assert(f.healer.pendingActorTeleport);
            AI.tick(f.healer); // Leader arrived, companion has not: still no old-zone action.
            while (pending.length) pending.shift()();
            assert.equal(wakeups.length, 3);
            assert.equal(f.healer.pendingActorTeleport, undefined);
            assert.equal(f.healer.actor.x, 20000);
            assert.equal(f.tick(f.healer), false, 'city arrival cannot retain the old raid');
            f.boss.destId = null;
            f.owner.actor.x = 0; f.owner.actor.y = 0; f.owner.actor.destId = f.boss.fetchId();
            assert(Safety.syncPlayerPartyRaid(f.owner), 'a new deliberate pull remains possible after travel');
            const raid = f.owner.partyRaidEngagement;
            assert(Teleport(f.tank, f.tank.actor, { locX: 100, locY: 0, locZ: 0 }));
            assert.equal(f.owner.partyRaidEngagement, raid, 'a bot catch-up teleport must not end the human raid');
            pending.shift()();
            assert.equal(f.tank.pendingActorTeleport, undefined);
            assert.equal(pending.length, 0, 'bot travel must not recursively teleport the party');
            // Repeated native requests: the first arrival cannot unlock AI
            // before the latest request finishes.
            Teleport(f.tank, f.tank.actor, { locX: 200, locY: 0, locZ: 0 });
            Teleport(f.tank, f.tank.actor, { locX: 300, locY: 0, locZ: 0 });
            const latest = f.tank.pendingActorTeleport;
            pending.shift()();
            assert.equal(f.tank.pendingActorTeleport, latest);
            pending.shift()();
            assert.equal(f.tank.pendingActorTeleport, undefined);
            assert.equal(f.tank.actor.x, 300);
        } finally { global.setTimeout = originalTimeout; }
    }
    console.log('Player party raid opening, shared tactics, healer stance, sleep, rescue, retreat and teleport checks passed');
} finally {
    for (const restore of restores.reverse()) restore();
}
