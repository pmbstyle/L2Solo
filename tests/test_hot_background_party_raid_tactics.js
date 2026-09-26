const assert = require('node:assert/strict');

require('../src/Global');

const Hot = invoke('GameServer/Bot/AI/HotBackgroundParty');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const World = invoke('GameServer/World/World');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const RaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const PvpTactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const ClassTactics = invoke('GameServer/Bot/AI/PartyClassTactics');
const SkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const Support = invoke('GameServer/Bot/AI/BotSupportPlanner');
const Effects = invoke('GameServer/Effects/EffectStore');

const restores = [];
function patch(object, key, value) {
    const previous = object[key];
    restores.push(() => { object[key] = previous; });
    object[key] = value;
}

function skill(id, effect = '') {
    return {
        fetchSelfId: () => id,
        fetchDistance: () => 600,
        fetchSemantic: () => ({ effect })
    };
}

function actor(id, role, kind = null) {
    const value = {
        role,
        casting: false,
        selected: null,
        fetchId: () => id,
        fetchSelfId: () => id,
        fetchKind: () => kind,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        fetchMp: () => 100,
        fetchMaxMp: () => 100,
        fetchIsOnline: () => true,
        fetchDestId() { return this.destId; },
        isDead: () => false,
        select({ id: selectedId }) { this.selected = selectedId; },
        unselect() { this.selected = null; },
        state: {
            fetchCasts: () => value.casting,
            setCasts: (casting) => { value.casting = casting; },
            fetchHits: () => !!value.hitting,
            fetchTowards: () => false,
            fetchSeated: () => !!value.seated,
            setSeated(next) { value.seated = next; },
            fetchDead: () => false
        },
        automation: { abortAll() {}, replenishVitals() {} },
        attack: {
            abortCast(_session, member) {
                member.casting = false;
                member.castAborted = true;
                return true;
            },
            clearTimers() {},
            resetQueuedEvent() {}
        },
        skillset: { skills: [], fetchSkill: () => null }
    };
    return value;
}

try {
    const tank = actor(1, 'tank');
    const offTank = actor(5, 'tank');
    const damage = actor(2, 'dps');
    const controller = actor(3, 'mage');
    const debuffer = actor(4, 'dps');
    const sessions = [tank, offTank, damage, controller, debuffer].map((member) => ({
        actor: member,
        hotBackgroundPartyId: 'raid-party',
        dataSendToOthers() {}
    }));
    const owner = sessions[0];
    const party = {
        partyId: 'raid-party',
        leaderId: tank.fetchId(),
        memberIds: sessions.map((session) => session.actor.fetchId()),
        status: 'hot',
        stats: { objective: { sourceKind: 'raid', raidBossTemplateId: 9000, npcId: 9000 } }
    };
    // Real raid bosses use kind `Boss`, not `Monster`.  Keeping the production
    // kind here prevents the hot party from silently falling back to field
    // farming when it reaches its objective.
    const boss = actor(900, null, 'Boss');
    boss.destId = damage.fetchId();
    const fieldMob = actor(899, null, 'Monster');
    const focusMinion = actor(901, null, 'Monster');
    const controlledMinion = actor(902, null, 'Monster');
    const aggression = skill(28, 'hate');
    const sleep = skill(1069, 'sleep');
    const weakness = skill(1160, 'weakness');
    const plan = {
        boss,
        minions: [focusMinion, controlledMinion],
        focusMinion,
        controlTargets: [controlledMinion]
    };

    patch(Parties, 'find', () => party);
    patch(World, 'user', { sessions });
    patch(World, 'fetchNpcsInRadius', () => [boss]);
    let incoming = boss;
    patch(Awareness, 'npcThreateningActor', () => incoming);
    patch(Restrictions, 'canUseBasicAction', () => true);
    let canCast = true;
    patch(Restrictions, 'canCast', () => canCast);
    patch(RaidSafety, 'isProtectedRaidEntity', (target) => target !== fieldMob);
    patch(RaidSafety, 'canEngageBotClanRaid', (_session, target) => (
        [boss, focusMinion, controlledMinion].includes(target)
    ));
    patch(RaidSafety, 'botClanRaidCombatPlan', () => plan);
    patch(Roles, 'inferRole', (member) => member.role);
    patch(PvpTactics, 'stop', () => {});
    patch(PvpTactics, 'support', () => false);
    patch(ClassTactics, 'usable', member => canCast && !member.unusable);
    patch(Support, 'nextPartyAction', () => null);
    patch(Support, 'hasPendingAction', () => false);
    const tauntUsers = new Set([tank, offTank]);
    patch(SkillCapabilities, 'aggressionSkill', member => tauntUsers.has(member) ? aggression : null);
    patch(Roles, 'isPartyMusicFighter', member => !!member.music);
    patch(Effects, 'impairments', member => member.impairments || {});
    patch(ClassTactics, 'supportCrowdControl', (member, _targets, options) => (
        member === controller && options.canAttempt(controlledMinion, sleep)
            ? { skill: sleep, target: controlledMinion, reason: 'control_party_add' }
            : null
    ));
    patch(ClassTactics, 'raidDebuffAction', (member, _targets, options) => (
        member === debuffer && options.canAttempt(boss, weakness)
            ? { skill: weakness, target: boss, reason: 'weaken_raid_target' }
            : null
    ));

    const casts = [];
    const attacks = [];
    const Generics = { skillExec(session, _member, data) { casts.push([session.actor.fetchId(), data.id, data.selfId]); } };
    const AI = { executeCombat(session, _member, target) { attacks.push([session.actor.fetchId(), target.fetchId()]); } };
    const tick = (session, now) => Hot.tick(session, session.actor, Generics, AI, now);

    incoming = fieldMob;
    tick(sessions[2], 9998);
    assert.deepEqual(attacks.pop(), [damage.fetchId(), fieldMob.fetchId()],
        'an attacking field mob must be cleared locally without falling through to ordinary farming');
    owner.backgroundHuntTarget = null;
    incoming = boss;

    tick(sessions[2], 9999);
    assert.equal(attacks.length, 0, 'damage dealers must not open the raid before a tank owns the boss');
    assert.equal(sessions[2].lastDecision.action, 'raid_wait_tank');

    tick(sessions[1], 9999);
    assert.equal(casts.length, 0, 'an off-tank must not compete with the designated main tank for boss aggro');
    assert.equal(sessions[1].lastDecision.action, 'raid_wait_tank');

    tick(sessions[0], 10000);
    assert.deepEqual(casts.pop(), [tank.fetchId(), boss.fetchId(), aggression.fetchSelfId()],
        'the raid tank must taunt the boss when it is targeting another party member');
    assert.equal(sessions[0].lastDecision.action, 'raid_taunt_boss');

    tick(sessions[0], 10001);
    assert.deepEqual(attacks.pop(), [tank.fetchId(), boss.fetchId()],
        'during the taunt retry window the tank must keep attacking the boss instead of switching to adds');

    boss.destId = tank.fetchId();
    tick(sessions[2], 10002);
    assert.deepEqual(attacks.pop(), [damage.fetchId(), focusMinion.fetchId()],
        'damage dealers must share one raid-minion focus target');
    boss.destId = damage.fetchId();
    tick(sessions[1], 10002.1);
    assert.deepEqual(attacks.pop(), [offTank.fetchId(), focusMinion.fetchId()], 'a later aggro slip does not freeze uninvolved DDs');
    tick(sessions[2], 10002.2);
    assert.equal(sessions[2].lastDecision.action, 'raid_wait_tank', 'the player who overaggroed stops adding pressure');
    boss.destId = tank.fetchId();

    tick(sessions[1], 10002);
    assert.deepEqual(attacks.pop(), [offTank.fetchId(), focusMinion.fetchId()],
        'an off-tank must help on the shared add instead of taunting the boss away from the main tank');

    offTank.hitting = true;
    tick(sessions[1], 10002.5);
    assert.equal(attacks.length, 0,
        'an in-flight native weapon cycle must not be dispatched again by each party AI tick');
    offTank.hitting = false;

    tick(sessions[3], 10003);
    assert.deepEqual(casts.pop(), [controller.fetchId(), controlledMinion.fetchId(), sleep.fetchSelfId()],
        'a controller must disable an off-focus minion without sleeping the focused add');

    tick(sessions[4], 10004);
    assert.deepEqual(casts.pop(), [debuffer.fetchId(), boss.fetchId(), weakness.fetchSelfId()],
        'an available raid debuff should be applied to the boss');
    tick(sessions[4], 10005);
    assert.deepEqual(attacks.pop(), [debuffer.fetchId(), focusMinion.fetchId()],
        'a resisted or pending debuff must not be retried on every AI tick');

    owner.backgroundRaidActionClaims.clear();
    canCast = false;
    debuffer.casting = true;
    tick(sessions[4], 10005.5);
    assert.deepEqual(attacks.pop(), [debuffer.fetchId(), focusMinion.fetchId()],
        'a melee support silenced mid-cast must fall through to its weapon instead of staying cast-locked');
    assert.equal(debuffer.castAborted, true, 'the raid loop must clear a stale cast when silence blocks its completion');
    assert.equal(casts.length, 0);
    canCast = true;

    // Recover adds from vulnerable party members without involving the main
    // tank, restarting the weapon loop, or creating an aggro ping-pong.
    damage.role = 'archer';
    focusMinion.destId = damage.fetchId();
    owner.backgroundRaidActionClaims.clear();
    offTank.hitting = true;
    tick(sessions[1], 20000);
    assert.deepEqual(casts.pop(), [offTank.fetchId(), focusMinion.fetchId(), aggression.fetchSelfId()],
        'a secondary taunter must interrupt its attack to peel an add from the archer');
    assert.equal(sessions[1].lastDecision.action, 'raid_taunt_add');
    tick(sessions[1], 20001);
    assert.equal(casts.length, 0, 'the shared retry window must prevent taunt spam');
    offTank.hitting = false;
    tick(sessions[0], 20002);
    assert.deepEqual(attacks.pop(), [tank.fetchId(), boss.fetchId()],
        'the main tank must keep the boss even while an archer has add aggro');

    // Music fighters qualify by their learned skill, not their buffer role.
    debuffer.role = 'buffer';
    debuffer.music = true;
    tauntUsers.add(debuffer);
    owner.backgroundRaidActionClaims.clear();
    tick(sessions[1], 21000);
    assert.equal(casts.length, 0, 'only the elected rescuer may taunt a given add');
    attacks.length = 0;
    tick(sessions[4], 21001);
    assert.deepEqual(casts.pop(), [debuffer.fetchId(), focusMinion.fetchId(), aggression.fetchSelfId()],
        'a music fighter with Aggression must be eligible to recover an add');
    focusMinion.destId = debuffer.fetchId();
    debuffer.unusable = true;
    tick(sessions[1], 27000);
    assert.equal(casts.length, 0, 'do not steal an add from a secondary holder whose taunt is on reuse');
    attacks.length = 0;

    focusMinion.destId = damage.fetchId();
    controlledMinion.destId = controller.fetchId();
    controller.role = 'healer';
    owner.backgroundRaidActionClaims.clear();
    tick(sessions[1], 28000);
    assert.deepEqual(casts.pop(), [offTank.fetchId(), controlledMinion.fetchId(), aggression.fetchSelfId()],
        'an endangered healer takes priority over the focused add chasing an archer');
    controlledMinion.impairments = { disabled: true };
    owner.backgroundRaidActionClaims.clear();
    tick(sessions[1], 29000);
    assert.deepEqual(casts.pop(), [offTank.fetchId(), focusMinion.fetchId(), aggression.fetchSelfId()],
        'leave sleeping or stunned adds under control');
    focusMinion.impairments = { rooted: true };
    tick(sessions[1], 35000);
    assert.equal(casts.length, 0, 'rooted adds do not need a chasing rescuer');
    attacks.length = 0;

    focusMinion.impairments = {};
    focusMinion.destId = 999;
    tick(sessions[1], 36000);
    assert.equal(casts.length, 0, 'do not taunt an add targeting somebody outside this party');
    attacks.length = 0;
    focusMinion.destId = damage.fetchId();
    offTank.unusable = true;
    tick(sessions[1], 37000);
    assert.equal(casts.length, 0, 'unavailable taunts must not block normal combat');
    assert.deepEqual(attacks.pop(), [offTank.fetchId(), focusMinion.fetchId()]);
    offTank.unusable = false;
    canCast = false;
    tick(sessions[1], 38000);
    assert.equal(casts.length, 0, 'silenced providers must fall back to weapon attacks');
    assert.deepEqual(attacks.pop(), [offTank.fetchId(), focusMinion.fetchId()]);
    canCast = true;
    boss.destId = damage.fetchId();
    tick(sessions[1], 39000);
    assert.deepEqual(casts.pop(), [offTank.fetchId(), focusMinion.fetchId(), aggression.fetchSelfId()],
        'an add rescue must not wait for the main tank to reacquire boss aggro');

    boss.destId = tank.fetchId();
    debuffer.unusable = false;
    debuffer.casting = true;
    owner.backgroundRaidActionClaims.clear();
    tick(sessions[1], 40000);
    assert.deepEqual(casts.pop(), [offTank.fetchId(), focusMinion.fetchId(), aggression.fetchSelfId()],
        'a provider already casting must not reserve the rescue ahead of an available ally');
    debuffer.casting = false;
    debuffer.unusable = true;
    offTank.impairments = { rooted: true };
    const originX = focusMinion.fetchLocX;
    focusMinion.fetchLocX = () => 700;
    owner.backgroundRaidActionClaims.clear();
    tick(sessions[1], 41000);
    assert.equal(casts.length, 0, 'an immobilized provider must not reserve an unreachable add');
    attacks.length = 0;
    focusMinion.fetchLocX = () => 500;
    tick(sessions[1], 42000);
    assert.deepEqual(casts.pop(), [offTank.fetchId(), focusMinion.fetchId(), aggression.fetchSelfId()],
        'an immobilized provider can still taunt an add within skill range');
    focusMinion.fetchLocX = originX;
    offTank.impairments = {};

    // Restore the ordinary roster for lifecycle/preparation cases below.
    boss.destId = tank.fetchId();
    delete focusMinion.destId;
    delete controlledMinion.destId;
    controlledMinion.impairments = {};
    damage.role = 'dps';
    controller.role = 'mage';
    debuffer.role = 'dps';
    debuffer.music = false;
    debuffer.unusable = false;
    tauntUsers.delete(debuffer);
    owner.backgroundRaidActionClaims.clear();

    damage.role = 'healer';
    damage.fetchMp = () => 50;
    tick(sessions[2], 43000);
    assert.equal(damage.seated, true, 'an idle raid healer regenerates seated while the tank keeps fighting');
    assert.equal(sessions[2].lastDecision.action, 'raid_healer_recovery');
    assert.equal(attacks.length, 0, 'the healer does not start a weapon cycle between heals');
    tick(sessions[2], 44000);
    assert.equal(damage.seated, true, 'the next tick does not stand and sit again');
    focusMinion.destId = damage.fetchId();
    tick(sessions[2], 45000);
    assert.equal(damage.seated, false, 'a healer immediately stands when an add attacks');
    attacks.length = 0;
    delete focusMinion.destId;
    damage.role = 'dps';
    damage.fetchMp = () => 100;

    // Defense must run before the active native attack-cycle guard.
    const ud = skill(110, 'ultimate_defense');
    patch(ClassTactics, 'selfAction', (member, options) => member === tank && options.raidBoss
        ? { skill: ud, target: tank } : null);
    tank.hitting = true;
    tick(owner, 46000);
    assert.deepEqual(casts.pop(), [tank.fetchId(), tank.fetchId(), ud.fetchSelfId()]);
    assert.equal(owner.lastDecision.action, 'raid_defense');
    restores.pop()();
    tank.hitting = false;

    sessions[2].hotRaidResurrectionRecovery = true;
    damage.fetchHp = () => 1;
    tick(sessions[2], 47000);
    assert.equal(sessions[2].lastDecision.action, 'raid_resurrection_recovery');
    assert.equal(attacks.length, 0, 'a newly resurrected DD must not run back into damage at 1 HP');
    damage.fetchHp = () => 700;
    let minimalPending = true;
    patch(Support, 'hasPendingAction', (_members, providers, options) => {
        if (!options?.raidRecovery) return false;
        assert(!providers.some(actor => actor.role === 'healer' || actor.role === 'tank'),
            'combat rebuff must not borrow the healer or main tank');
        return minimalPending;
    });
    patch(Support, 'nextPartyAction', (_members, _providers, options) => options.raidRecovery
        ? { provider: debuffer, target: damage, skill: skill(1068, 'might') } : null);
    patch(Support, 'queueSupportCast', () => {});
    tick(sessions[2], 48000);
    assert.equal(sessions[2].hotRaidResurrectionRecovery, false);
    assert.equal(sessions[2].lastDecision.action, 'raid_wait_minimal_rebuff');
    assert.equal(attacks.length, 0, 'the revived DD waits while its minimal buff is still pending');
    tick(sessions[1], 48001);
    assert.deepEqual(attacks.pop(), [offTank.fetchId(), focusMinion.fetchId()], 'healthy DDs keep fighting');
    tick(sessions[4], 48002);
    assert.deepEqual(casts.pop(), [debuffer.fetchId(), damage.fetchId(), 1068]);
    tick(sessions[2], 48003);
    assert.equal(attacks.length, 0, 'dispatching a buff is not proof it landed');
    minimalPending = false;
    tick(sessions[2], 48004);
    assert.deepEqual(attacks.pop(), [damage.fetchId(), focusMinion.fetchId()], 'minimal buffs are enough to rejoin');
    sessions[2].hotRaidNeedsRebuff = true;
    sessions[2].hotRaidRebuffUntil = 48008;
    minimalPending = true;
    tick(sessions[2], 48008);
    assert.equal(sessions[2].hotRaidNeedsRebuff, false);
    assert.deepEqual(attacks.pop(), [damage.fetchId(), focusMinion.fetchId()], 'a busy buffer cannot stall the DD indefinitely');
    restores.pop()(); restores.pop()(); restores.pop()();
    attacks.length = 0;
    damage.fetchHp = () => 100;

    const song = skill(264, 'song_of_earth');
    patch(Support, 'nextPartyAction', (_members, _providers, options) => options.musicOnly
        ? { provider: offTank, target: offTank, skill: song, effect: 'song_of_earth' } : null);
    patch(Support, 'queueSupportCast', () => {});
    offTank.role = 'buffer'; offTank.music = true;
    tick(sessions[1], 49000);
    assert.deepEqual(casts.pop(), [offTank.fetchId(), offTank.fetchId(), song.fetchSelfId()]);
    assert.equal(sessions[1].lastDecision.action, 'raid_rebuff');
    tick(sessions[2], 49001);
    assert.deepEqual(attacks.pop(), [damage.fetchId(), focusMinion.fetchId()], 'music renewal must not pause another DD');
    offTank.role = 'tank'; offTank.music = false;
    restores.pop()(); restores.pop()();

    sessions[2].hotRaidCasualtyAt = 10006;
    tick(sessions[2], 10006);
    assert.equal(sessions[2].lastDecision.action, 'raid_casualty_out',
        'a tolerated damage casualty must stay out after its town respawn instead of dragging the raid formation');
    assert.equal(attacks.length, 0);

    incoming = null;
    owner.backgroundHuntTarget = boss;
    owner.raidPreparationComplete = false;
    owner.raidPreparationReadyAt = 0;
    tick(sessions[0], 11000);
    assert.equal(sessions[0].lastDecision.action, 'raid_wait_preparation',
        'a raid pull must wait through a stable party-wide preparation window');
    assert.equal(owner.backgroundHuntTarget, null,
        'the preparation barrier must clear a prematurely selected raid target');
    assert.equal(attacks.length, 0);
    owner.backgroundHuntTarget = boss;
    tick(sessions[0], 12501);
    assert.equal(owner.raidPreparationComplete, true,
        'the raid may open only after the support plan stays empty for the settle window');

    console.log('Hot bot-clan raid tank, focus, control and debuff tactics passed');
} finally {
    restores.reverse().forEach((restore) => restore());
}
