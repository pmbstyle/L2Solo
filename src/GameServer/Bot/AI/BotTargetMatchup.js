const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const WeaponMask = invoke('GameServer/Skills/WeaponMask');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
const PetHealRule = invoke('GameServer/Bot/AI/PetHealRule');
const PetTankRule = invoke('GameServer/Bot/AI/PetTankRule');
const Pull = invoke('GameServer/Bot/AI/BotPullEstimate');
const HitRules = invoke('GameServer/Combat/HitRules');
const CombatantView = invoke('GameServer/Combat/CombatantView');

const MIN_EFFICIENCY = 0.15;
// The weakness stats a hit's damage reads (HitRules.targetModifier).
const DAMAGE_VULN_STATS = ['bowWpnVuln', 'bluntWpnVuln', 'daggerWpnVuln', ...[...HitRules.ELEMENTAL_DAMAGE_TRAITS].map(e => `${e}Vuln`)];
const DAMAGE_TYPES = new Set([Rules.DAMAGE, Rules.DAMAGE_EFFECT, Rules.DRAIN,
    Rules.DEATH_LINK, Rules.FATAL, Rules.BLOW]);
const number = (value, fallback = 1) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const positive = value => Math.max(1, number(value));
// Resolved on first use (the cold worker loads this module before them);
// invoke() re-resolves the path on every call inside spot scans.
const ColdMobAction = invoke('GameServer/Bot/Population/ColdMobAction');
let DataCacheModule, HuntingTargetPolicy, ColdCombatProfile;
const dataCache = () => DataCacheModule || (DataCacheModule = invoke('GameServer/DataCache'));
const huntingTargetPolicy = () => HuntingTargetPolicy
    || (HuntingTargetPolicy = invoke('GameServer/Bot/AI/BotHuntingTargetPolicy'));
const coldCombatProfile = () => ColdCombatProfile
    || (ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile'));
const coldMobAction = () => ColdMobAction;

function npcTemplate(id) {
    return ItemTemplateIndex.findLastByLength(dataCache().npcs, id, npcTemplate);
}

// A scan owns this snapshot: do not retain live effects, equipment or learned
// skills across decisions. Cold callers already own an immutable profile.
// The numbers the cold fight's profile gives its hits (hit roll, critical,
// spread, shield: ColdCombatProfile.attackerView, defenderView), live.
function actorProfile(actor) {
    const backpack = actor.backpack;
    return {
        classId: actor.fetchClassId?.(), characterId: Roles.botCharacterId(actor), level: actor.fetchLevel?.(),
        role: Roles.combatRoleFor(actor),
        pAtk: actor.fetchCollectivePAtk?.() ?? actor.fetchPAtk?.(),
        mAtk: actor.fetchCollectiveMAtk?.() ?? actor.fetchMAtk?.(),
        atkSpd: actor.fetchCollectiveAtkSpd?.() ?? actor.fetchAtkSpd?.() ?? 300,
        castSpd: actor.fetchCollectiveCastSpd?.() ?? actor.fetchCastSpd?.() ?? 333,
        maxMp: actor.fetchMaxMp?.(), weaponMask: WeaponMask.weaponMaskFor(actor),
        maxHp: actor.fetchMaxHp?.(),
        pDef: actor.fetchCollectivePDef?.() ?? actor.fetchPDef?.(),
        mDef: actor.fetchCollectiveMDef?.() ?? actor.fetchMDef?.(),
        accur: actor.fetchCollectiveAccur?.() ?? actor.fetchAccur?.(),
        evasion: actor.fetchCollectiveEvasion?.() ?? actor.fetchEvasion?.(),
        critical: actor.fetchCollectiveCritical?.() ?? actor.fetchCritical?.(),
        str: actor.fetchStr?.(), dex: actor.fetchDex?.(),
        equipment: { weaponKind: backpack?.fetchTotalWeaponKind?.(), pAtkRnd: backpack?.fetchTotalWeaponPAtkRnd?.(),
            attackReuseDelay: backpack?.fetchEquippedWeapon?.()?.fetchAttackReuseDelay?.(),
            shieldPDef: backpack?.fetchTotalShieldPDef?.(), shieldRate: backpack?.fetchTotalShieldRate?.() },
        skills: (actor.skillset?.skills || actor.skillset?.fetchSkills?.() || []).map(skill => ({
            selfId: skill.fetchSelfId?.(), level: skill.fetchLevel?.(),
            reuseReady: actor.canUseSkill?.(skill) !== false,
            semantic: skill.fetchSemantic?.() || {}, passive: skill.fetchPassive?.(),
            spell: skill.fetchSpell?.(), power: skill.fetchPower?.(), mp: skill.fetchConsumedMp?.(),
            hitTime: skill.fetchHitTime?.(), reuse: skill.fetchReuseTime?.(), distance: skill.fetchDistance?.()
        }))
    };
}

function actorProfiles(actors) {
    return actors.filter(Boolean).flatMap(actor => {
        const profile = actorProfile(actor);
        if (actor.summon && !actor.summon.isDead?.() && !actor.summon.state?.fetchDead?.()) {
            return [profile, { ...actorProfile(actor.summon), role: 'dps', servitor: true,
                hp: Number(actor.summon.fetchHp?.() ?? actor.summon.fetchMaxHp?.()) || undefined,
                ...petHealFields(profile, actor.fetchMp?.()) }];
        }
        return coldProfiles(profile, { vitals: { mp: actor.fetchMp?.() } });
    });
}

// The servitor beside a cold bot's profile at timestamp: its living saved
// summon with the HP it has left, else the one a summoner casts first (MP and
// reuse allow it: BackgroundResolver.startColdSummon), which strikes, and
// lets its owner act again, after the summon's cast (summonCastMs); null
// without either. coldProfiles builds the gate's pair with it, and a solo
// fight's readiness reads it anew before each fight (a pet dead or raised
// since the round's profiles were built).
// A pet's owner heals it (PetHealRule, user 10-30): its best heal and the
// MP that pays for it, the fields sideLifetime reads; none without a heal.
// The owner's heal numbers once per profile object.
const petSustains = new WeakMap();
function petHealFields(profile, ownerMp) {
    let petSustain = petSustains.get(profile);
    if (petSustain === undefined) {
        const Cold = coldCombatProfile();
        petSustains.set(profile, petSustain = PetHealRule.sustainOf(profile.skills, record => Cold.actionDelayMs(profile, record)));
    }
    return petSustain ? { petSustain, ownerMp: number(ownerMp, profile.maxMp) } : {};
}

function servitorProfile(profile, state = {}, timestamp = Date.now()) {
    const summon = state.stats?.coldCombat?.summon;
    const Cold = coldCombatProfile();
    const healed = () => petHealFields(profile, state.vitals?.mp);
    // lazy: worker ColdSummonProfile loads ColdCombatProfile, resolved on first use (coldCombatProfile).
    const Summon = () => invoke('GameServer/Bot/Population/ColdSummonProfile');
    if (summon?.active && number(summon.hp, summon.maxHp) > 0 && summon.expiresAt > timestamp) {
        return { ...Summon().fullSummon(profile, summon), role: 'dps', skills: [], soloDamageReceiver: false, servitor: true, ...healed() };
    }
    if (!Roles.isSummoner(profile)) return null;
    const skill = Cold.summonSkills(profile).find(s => s.reuseReady !== false
        && number(s.mp, 0) <= number(state.vitals?.mp, profile.maxMp)
        && number(state.stats?.coldCombat?.cooldowns?.[s.selfId], 0) <= timestamp);
    return skill ? { ...Summon()(profile, Cold.summonDetails(skill)),
        role: 'dps', skills: [], soloDamageReceiver: false, servitor: true, summonCastMs: Cold.actionDelayMs(profile, skill),
        ...healed() } : null;
}

// options.shot: the shot supply the caller's fight already holds
// (BackgroundResolver: its fighter's), instead of a second read of the stock.
function coldProfiles(profile, state = {}, timestamp = Date.now(), options = {}) {
    const profiles = [{ ...profile, skills: (profile.skills || []).map(skill => ({
        ...skill, semantic: skill.semantic || Rules.resolveCached(skill)
    })) }];
    const servitor = servitorProfile(profile, state, timestamp);
    if (servitor) profiles.push(servitor);
    // The shot the fight loads from the bot's stock (ColdCombatProfile.shotSupply).
    if (state.inventory) profiles[0].shot = 'shot' in options ? options.shot : coldCombatProfile().shotSupply(state, timestamp);
    const role = profile.role || Roles.combatRoleFor(profile);
    if (role === 'mage' || role === 'healer') {
        profiles[0].soloAttackScores = invoke('GameServer/Bot/Population/ColdClassPolicy')
            .soloAttackScores(profiles[0], { summon: profiles.length > 1 });
    }
    return profiles;
}

// What of a bot's solo profile array (stateProfiles) moves with no build
// section: whether the bot is alive (a dead bot has no profiles) and the
// summon beside it (coldProfiles: its live cold summon, or the servitor a
// summoner can cast now). -1 dead, 0 alone, else the summon's npc id (1 for
// a live summon whose profile names none, the hot path's actorProfile).
function profileKey(profiles) {
    if (!profiles.length) return -1;
    return profiles.length > 1 ? Number(profiles[1].npcId) || 1 : 0;
}

// The weakness stats a kit's hits read (HitRules.targetModifier): its weapon's
// and each skill's.
function profileStats(profiles) {
    return [...new Set((profiles || []).flatMap(profile => [HitRules.weaponVulnStat(profile.equipment?.weaponKind, '', true),
        ...(profile.skills || []).map(skill => {
            const trait = (skill.semantic || Rules.resolve(skill)).trait;
            return skill.spell ? HitRules.elementVulnStat(trait) : HitRules.weaponVulnStat(profile.equipment?.weaponKind, trait, true);
        })]).filter(Boolean))];
}

function skillStats(actor) {
    return profileStats([{ equipment: { weaponKind: actor.backpack?.fetchTotalWeaponKind?.() },
        skills: (actor.skillset?.skills || []).map(skill => ({
            spell: skill.fetchSpell?.(), semantic: skill.fetchSemantic?.() || {}
        })) }]);
}

function targetView(target, stats = DAMAGE_VULN_STATS) {
    if (!target || typeof target.fetchHp !== 'function') return target || {};
    // ColdClassPolicy supplies the same projection as native target scans.
    if (target.matchupTarget) return target.matchupTarget;
    // Native effect evaluation loads World/GameTime; cold workers must use
    // their serialized target stats without importing the live world.
    const EffectStats = invoke('GameServer/Effects/EffectStats');
    const vulnerabilities = {};
    for (const stat of stats) {
        vulnerabilities[stat] = EffectStats.multiplier(target, stat, 1);
    }
    const pDef = target.fetchCollectivePDef?.() ?? target.fetchPDef?.();
    const mDef = target.fetchCollectiveMDef?.() ?? target.fetchMDef?.();
    // The cold fight's monster (ColdCombatProfile.npcCombatStats of its
    // template: its skills by selfId, hit roll, critical, reach, run speed,
    // resists), its live HP and buffed numbers over it.
    const template = npcTemplate(target.fetchSelfId?.());
    const cold = template ? coldCombatProfile().npcCombatStats(template) : null;
    return { ...cold, vulnerabilities: { ...cold?.vulnerabilities, ...vulnerabilities }, pDef, mDef,
        undead: (target.fetchUndead?.() ?? cold?.undead) === true,
        race: String(target.fetchRace?.() ?? target.model?.race ?? cold?.race ?? '').toLowerCase(),
        level: target.fetchLevel?.() ?? cold?.level, maxHp: target.fetchMaxHp?.() ?? cold?.maxHp,
        pAtk: target.fetchCollectivePAtk?.() ?? target.fetchPAtk?.() ?? cold?.pAtk,
        mAtk: target.fetchCollectiveMAtk?.() ?? target.fetchMAtk?.() ?? cold?.mAtk,
        atkSpd: target.fetchCollectiveAtkSpd?.() ?? target.fetchAtkSpd?.() ?? cold?.atkSpd,
        castSpd: target.fetchCollectiveCastSpd?.() ?? target.fetchCastSpd?.() ?? cold?.castSpd,
        basePDef: target.fetchPDef?.() ?? pDef, baseMDef: target.fetchMDef?.() ?? mDef };
}

// A hit's modifier on a target view: the fight's terms (HitRules.targetModifier:
// weaknesses, the attacker's race and undead bonuses; bonus(stat) the
// attacker's multiplier) times the target's defence buffs (its base defence
// over the buffed one: channels hit the base). skill: a skill, not a normal
// attack (only a skill reads the dagger weakness).
function modifier(target, semantic = {}, magic = false, kind = '', skill = true, bonus = () => 1) {
    const vuln = HitRules.targetModifier({ magic, skill, trait: semantic.trait, weaponKind: kind, race: target.race, undead: target.undead === true },
        stat => coldCombatProfile().npcVulnerability(target, stat), bonus);
    const base = magic ? target.baseMDef : target.basePDef;
    const defense = magic ? target.mDef : target.pDef;
    return vuln * (number(base, 0) > 0 && number(defense, 0) > 0 ? base / defense : 1);
}

// A cold profile's multiplier of a stat (a race or undead bonus, the blow
// rate), once per profile object (a profile is fixed once built): its
// passives and effects now.
const bonuses = new WeakMap();
function profileBonus(profile) {
    let held = bonuses.get(profile);
    if (!held) bonuses.set(profile, held = new Map());
    return stat => {
        if (!held.has(stat)) held.set(stat, coldCombatProfile().statMultiplier(profile, stat, Date.now()));
        return held.get(stat);
    };
}

// The executor's pick (BotCombatUtility) ranks one actor's attacks on one
// target: its race and undead bonuses multiply all its physical hits alike and
// stay out (a hot actor's effects are not read in the cold worker).
function skillModifier(actor, target, skill, view = targetView(target)) {
    return modifier(view, skill.fetchSemantic?.(), skill.fetchSpell?.() === true,
        actor.backpack?.fetchTotalWeaponKind?.() || '');
}

// The plain damage rates of a kit (HuntCycle's kit ratio, which applies the
// hit roll itself): a profile's auto-attack at the cold fight's attack cycle
// (ColdCombatProfile.normalAttackMs) and a spell of `power` against a
// target's defence, and a target's hits against a profile. The solo gate
// reads the fight's expected hits instead (channels, soloSurvival).
function attackRate(profile, target) {
    const perSecond = 1000 / coldCombatProfile().normalAttackMs(profile.atkSpd ? profile : { ...profile, atkSpd: 300 });
    return 70 * positive(profile.pAtk) / positive(target.basePDef || target.pDef) * perSecond;
}
function spellDamage(profile, target, power) {
    return 91 * Math.sqrt(positive(profile.mAtk)) * power / positive(target.baseMDef || target.mDef);
}
function spellRate(profile, target, power, hitTime = 3000) {
    return spellDamage(profile, target, power) / Math.max(0.5, number(hitTime, 3000) / 1000 * 333 / positive(profile.castSpd || 333));
}
function incomingRate(target, profile) {
    return 70 * target.pAtk / profile.pDef * positive(target.atkSpd || 253) / 500;
}

// A profile's attacks on a target, each as the cold fight strikes it: its
// expected hit (HitRules.expected*: hit roll, critical, shield, the shot it
// loads) over the action's time (ColdCombatProfile.actionDelayMs, a weapon
// cycle, a servitor's swing), against the target's base defence (modifier:
// its weaknesses and defence buffs). An area skill hits every mob of a pull.
// weight: damage per second; hit: of one action on one mob; struck: the mobs
// it hits; survivalWeight: bounded by the skill's reuse; damageBudget: what
// the MP bar pays for; area: an area skill on a pull.
function channelContext(profile, target, shot = profile.shot) {
    const Cold = coldCombatProfile();
    const kind = profile.equipment?.weaponKind || '';
    return { Cold, shot, kind, bow: kind === 'Weapon.Bow', attacker: Cold.attackerView(profile), bonus: profileBonus(profile),
        defender: CombatantView.view({ pDef: positive(target.basePDef || target.pDef), mDef: positive(target.baseMDef || target.mDef),
            dex: target.dex, shieldPDef: target.shieldPDef, shieldRate: target.shieldRate }) };
}

function normalChannel(profile, target, { Cold, shot: supply, kind, bow, attacker, defender, bonus }) {
    const shot = Cold.actionShot(supply, null);
    const hit = HitRules.expectedMelee(attacker, defender, { soulshot: shot?.soulshot === true, bow,
        hitChance: Cold.expectedHitChance(profile.accur, target.evasion) });
    const swingMs = profile.servitor ? Cold.summonAttackMs(profile) : Cold.normalAttackMs(profile);
    return { weight: hit * 1000 / swingMs, hit, modifier: modifier(target, {}, false, kind, false, bonus), magic: false, normal: true };
}

function skillChannel(profile, target, skill, { Cold, shot: supply, kind, bow, attacker, defender, bonus }) {
    const semantic = skill.semantic || Rules.resolve(skill);
    const magic = skill.spell === true;
    // At full HP, as the gate judges (Death Link and Fatal by the caster's HP: HitRules.skillPower).
    const power = Math.max(0, HitRules.skillPower(semantic, number(skill.power ?? semantic.power, 0), 1, 1));
    if (!power) return null;
    // An area skill hits every mob of a pull (F20; BotPullEstimate.pullView).
    const area = Rules.hitsArea(semantic) && number(target.pull, 1) > 1;
    const struck = area ? number(target.pull) : 1;
    const shot = Cold.actionShot(supply, skill);
    const blow = semantic.skillType === Rules.BLOW;
    const hit = magic
        ? HitRules.expectedMagicSkill(attacker, defender, { power, spiritshot: shot?.spiritshot === true,
            blessedSpiritshot: shot?.blessedSpiritshot === true })
            // The level-fail roll a nuke or a drain makes (HitRules.rollsMagicLevel).
            * (HitRules.rollsMagicLevel(semantic, true) ? HitRules.magicLevelChance(semantic, profile.level, target.level) / 100 : 1)
        : HitRules.expectedPhysicalSkill(attacker, defender, { power, blow, bow, soulshot: shot?.soulshot === true,
            skillCritRate: HitRules.physicalSkillCritRate(semantic, profile.str),
            landChance: blow ? HitRules.blowLandChance(semantic, { dex: profile.dex, front: true,
                rateMul: bonus('blowRateMul') }) / 100 : 1 });
    const hitDamage = struck * hit;
    const weight = hitDamage * 1000 / Cold.actionDelayMs(profile, skill, shot?.spiritshot === true);
    return { weight, hit, struck, modifier: modifier(target, semantic, magic, kind, true, bonus), magic, area,
        soloScore: profile.soloAttackScores?.[skill.selfId],
        survivalWeight: Math.min(weight, hitDamage / Math.max(0.25, number(skill.reuse, 0) / 1000)),
        damageBudget: number(skill.mp, 0) > 0
            ? Math.floor(number(profile.maxMp, 0) / skill.mp) * hitDamage : Infinity };
}

function channels(profile, target) {
    const context = channelContext(profile, target);
    const role = profile.role || Roles.combatRoleFor(profile);
    const result = [];
    if (role !== 'mage') result.push(normalChannel(profile, target, context));
    for (const skill of profile.skills || []) {
        const semantic = skill.semantic || Rules.resolve(skill);
        if (skill.passive || !DAMAGE_TYPES.has(semantic.skillType) || semantic.target !== 'enemy'
            || semantic.notUsedInC4 || (role === 'mage' && skill.spell !== true)
            || (semantic.undeadOnly && target.undead !== true)
            || (number(profile.maxMp, 0) > 0 && number(skill.mp, 0) > profile.maxMp)
            || (semantic.requires?.weaponsAllowed && !(semantic.requires.weaponsAllowed & profile.weaponMask))
            || (context.bow && number(semantic.castRange ?? skill.distance, 0) < 400)) continue;
        const channel = skillChannel(profile, target, skill, context);
        if (channel) result.push(channel);
    }
    return result;
}

// The expected damage of a profile's next action on one mob of target: skill,
// or its weapon hit (PetTankRule prices the hit before the cast). shot: the
// supply its fight holds, else the profile's.
function expectedHit(profile, target, skill = null, shot = profile.shot) {
    const context = channelContext(profile, target, shot);
    const channel = skill ? skillChannel(profile, target, skill, context) : normalChannel(profile, target, context);
    return channel ? channel.hit * channel.modifier : 0;
}

// expectedHit for a live actor (hot): skill by its id, a pet or a bot alike.
function actorHit(actor, target, skill = null) {
    const profile = actorProfile(actor);
    const id = skill?.fetchSelfId?.();
    return expectedHit(profile, target, id === undefined ? null : profile.skills.find(record => record.selfId === id) || null);
}

// attacksOf: channels, or a caller's per-target list of them (npcVerdict).
function evaluate(profiles, target, attacksOf = channels) {
    let neutral = 0, effective = 0;
    for (const profile of profiles || []) {
        const attacks = attacksOf(profile, target);
        if (!attacks.length) continue; // Missing legacy skill data is not immunity.
        neutral += Math.max(...attacks.map(a => a.weight));
        effective += Math.max(...attacks.map(a => a.weight * a.modifier));
    }
    const efficiency = neutral > 0 ? effective / neutral : 1;
    return { efficiency, eligible: efficiency > MIN_EFFICIENCY,
        penalty: Math.round(Math.max(0, 1 - efficiency) * 900),
        reason: efficiency <= MIN_EFFICIENCY ? 'target_resistance' : 'target_efficiency' };
}

// Full-health readiness, not an estimate of the current injured fight. Keep
// headroom for misses, interrupted casts and the retreat before zero HP.
// Missing legacy projections remain neutral until real stats are available.
// The fight the bot meets (BackgroundResolver.resolveFight), in expectation:
// the bot lives its HP over the target's mean action damage
// (ColdMobAction.incomingPerSecond: hits, criticals, skills), plus the
// opening it strikes before a melee monster closes in
// (ColdCombatProfile.openingMs; none on a mob already in the fight,
// target.engaged); a servitor still to be raised strikes, and its owner acts,
// only after the summon's cast. Each attacker deals its best attack over that
// time; areaShare: the share of that damage by area skills, which keeps a
// pull's mobs standing together (Pull.repack).
// How long the bot's side outlives a mob view (user 10-29: the pet tanks, as
// in C4): { total, pet }, pet: the time the pet stands. Each servitor's HP over
// the damage it takes, held longer by its owner's heals
// (PetHealRule.healedLifetime: petSustain, ownerMp), then the owner's (the
// longest of its receivers', with the opening: the mob walks to the owner, not
// to a pet at its side; PetTankRule keeps it off the owner till then). One rule
// for the gate, its bound and the hot danger read.
function sideLifetime(view, profiles, Mob, opening = 0) {
    let pets = 0, owner = 0;
    for (const profile of profiles) {
        if (profile.servitor === true) {
            if (profile.maxHp > 0 && profile.pDef > 0) pets += PetHealRule.healedLifetime(Math.min(profile.maxHp, number(profile.hp, profile.maxHp)),
                Mob.incomingPerSecond(view, profile), profile.petSustain || null, profile.ownerMp);
        } else if (profile.soloDamageReceiver !== false) {
            owner = Math.max(owner, profile.maxHp / Mob.incomingPerSecond(view, profile));
        }
    }
    return { total: pets + owner + opening, pet: pets };
}
// The owners, the bot's own side of a fight (sideLifetime).
function ownerReceivers(profiles) {
    return profiles?.filter(profile => profile.soloDamageReceiver !== false && profile.servitor !== true);
}
// A bot's solo profiles at the HP and MP it has left: a pet keeps its own HP.
function atVitals(profiles, hp, mp) {
    return profiles.map(profile => profile.soloDamageReceiver === false || profile.servitor === true ? profile
        : { ...profile, maxHp: Math.min(profile.maxHp, hp), maxMp: Math.min(profile.maxMp, mp) });
}
// The pair PetTankRule binds: one owner of a class that sends a pet ahead and
// its one pet, their indices in profiles; null for anything else (a party's
// tank holds its mob: the owner fights).
function soloPair(profiles) {
    if (!profiles || profiles.length !== 2) return null;
    const pet = profiles.findIndex(profile => profile.servitor === true);
    return pet >= 0 && PetTankRule.binds(profiles[1 - pet]) ? { owner: 1 - pet, pet } : null;
}
// The best damage per second of a list of attacks.
function bestRate(attacks) {
    let best = 0;
    for (const attack of attacks) best = Math.max(best, (attack.survivalWeight ?? attack.weight) * attack.modifier);
    return best;
}

// The solo hunt gate (T132, docs/game-decisions.md): the damage a bot deals
// over the target's HP before its own runs out, needed to fight alone. Cold
// hunt deaths do not fall above 1.0 (gate sweep, 700 kit and mob pairs), so no
// extra margin is bought on top.
const SOLO_GATE_MARGIN = 1.0;

function soloSurvival(profiles, target, minimum = SOLO_GATE_MARGIN, attacksOf = channels) {
    const receivers = ownerReceivers(profiles);
    if (!receivers?.length || !(target.maxHp > 0) || !(target.pAtk > 0)
        || receivers.some(profile => profile.survivalKnown === false || !(profile.maxHp > 0) || !(profile.pDef > 0))) {
        return { eligible: true, survivalRatio: null };
    }
    const Cold = coldCombatProfile(), Mob = coldMobAction();
    const openingSeconds = target.engaged === true ? 0 : Cold.openingMs(receivers[0], target) / 1000;
    const castSeconds = Math.max(0, ...profiles.map(profile => number(profile.summonCastMs, 0))) / 1000;
    const lists = profiles.map(profile => soloChannels(profile, target, attacksOf));
    const pair = soloPair(profiles);
    const plan = view => {
        const side = sideLifetime(view, profiles, Mob, openingSeconds);
        const seconds = Math.max(0, side.total - castSeconds), petSeconds = Math.max(0, side.pet - castSeconds);
        let damage = 0, area = 0, petDealt = 0;
        // The pair's pet first: it strikes while it stands, and its hate caps its owner's damage.
        for (const index of pair ? [pair.pet, pair.owner] : lists.keys()) {
            const onPet = pair?.pet === index, ownerOfPet = pair?.owner === index;
            const time = onPet ? petSeconds : seconds;
            let best = 0, bestArea = false;
            for (const attack of lists[index]) {
                const rate = (attack.survivalWeight ?? attack.weight) * attack.modifier;
                let dealt = Math.min(rate * time, (attack.damageBudget ?? Infinity) * attack.modifier);
                // Once the pet is down nothing holds the owner back.
                if (ownerOfPet) dealt = Math.min(dealt, PetTankRule.ownerCap(petDealt, number(attack.hit, 0) * attack.modifier) * number(attack.struck, 1)
                    + rate * (seconds - petSeconds));
                if (dealt > best) { best = dealt; bestArea = attack.area === true; }
            }
            if (onPet) petDealt = best;
            damage += best;
            if (bestArea) area += best;
        }
        return { damage, areaShare: damage > 0 ? area / damage : 0 };
    };
    let result = plan(target);
    if (result.areaShare > 0 && Number(target.pull) > 1) result = plan(Pull.repack(target, result.areaShare));
    const survivalRatio = result.damage / target.maxHp;
    return { eligible: survivalRatio >= minimum, survivalRatio, areaShare: result.areaShare,
        reason: survivalRatio >= minimum ? 'solo_survival_ready' : 'insufficient_survival_margin' };
}

function soloChannels(profile, target, attacksOf = channels) {
    const attacks = attacksOf(profile, target);
    // T100: a bot that sits for MP and fights with its weapon (an archer,
    // a self-healer: RestPolicy.sitsForMana) spends MP only while its bar is
    // near full (BotCombatUtility's price): its fight is the normal attack.
    if (!Roles.usesCasterWeaponCombat(profile) && RestPolicy.sitsForMana(profile)) {
        const normal = attacks.filter(attack => attack.normal);
        if (normal.length) return normal;
    }
    if (!profile.soloAttackScores) return attacks;
    // The executor chooses by native skill priority, not maximum DPS. Healers
    // may prefer cheap Disrupt Undead over stronger Might of Heaven too.
    let best = null, score = -Infinity;
    for (const attack of attacks) {
        if (!Number.isFinite(attack.soloScore)) continue;
        const current = attack.soloScore + Math.round(180 * Math.log2(
            Math.max(0.01, Math.min(2, attack.modifier))));
        if (current > score) { best = attack; score = current; }
    }
    if (best) return [best];
    // Holy-only healers use their weapon against living targets; a mage
    // without an available spell does not have that ordinary melee rotation.
    return (profile.role || Roles.combatRoleFor(profile)) === 'mage' ? [] : attacks.slice(0, 1);
}

function soloCanHunt(profiles, target, { maxTargetLevel, npcLevel, attacksOf = channels } = {}) {
    const survival = soloSurvival(profiles, target, SOLO_GATE_MARGIN, attacksOf);
    if (maxTargetLevel && Number(npcLevel || 0) > maxTargetLevel) {
        return { ...survival, eligible: false, reason: 'recovery_level' };
    }
    return survival.survivalRatio === null ? { ...evaluate(profiles, target, attacksOf), survivalRatio: null } : survival;
}

// The one judgement of a pull, hot and cold (BotPullEstimate): the mob with
// the size that comes with it, as one fight. A cold fight judges each size of
// its spawn group (entryVerdict), a hot bot the pack before it.
function pullVerdict(profiles, target, size, options = {}) {
    return soloCanHunt(profiles, Pull.pullView(target, wholePull(size)), options);
}
function wholePull(size) {
    return Math.max(1, Math.round(Number(size) || 1));
}

// An optimistic damage bound, not another survival gate. Compile skills once
// against unit defenses and an undead target, then keep at most three numeric
// attack envelopes per profile. Separate maxima for rate/budget and the best
// vulnerability can only increase damage, so an exact-safe mob stays eligible.
function soloSpotUpperBound(profiles) {
    const receivers = ownerReceivers(profiles);
    if (!receivers?.length || receivers.some(p => p.survivalKnown === false
        || !Number.isFinite(p.maxHp) || !(p.maxHp > 0) || !Number.isFinite(p.pDef) || !(p.pDef > 0))) {
        return () => true;
    }
    const neutral = { basePDef: 1, pDef: 1, baseMDef: 1, mDef: 1, undead: true };
    const bounds = profiles.map(profile => {
        const bound = { continuous: 0, physicalRate: 0, physicalBudget: 0, magicRate: 0, magicBudget: 0 };
        for (const attack of channels(profile, neutral)) {
            const rate = attack.survivalWeight ?? attack.weight;
            const budget = attack.damageBudget ?? Infinity;
            if (!attack.magic && budget === Infinity) bound.continuous = Math.max(bound.continuous, rate);
            else {
                const prefix = attack.magic ? 'magic' : 'physical';
                bound[`${prefix}Rate`] = Math.max(bound[`${prefix}Rate`], rate);
                bound[`${prefix}Budget`] = Math.max(bound[`${prefix}Budget`], budget);
            }
        }
        return bound;
    });
    // Search-local, capped at 4096 species (every C4 NPC template; ~130 KiB of
    // pairs at most, dies with the search); never retained on a bot, a shared
    // verdict fingerprint or a saved combat projection. A source route reader
    // asks it for ~700 spots of one build (R3 cost: at 256 a third of its
    // asks recomputed a species).
    const seen = new Map();
    // Every answer is kept, the unhuntable (null) and unknown-stat (true) too.
    function maybeSafe(selfId) {
        if (seen.has(selfId)) return seen.get(selfId);
        const allowed = speciesBound(selfId);
        if (seen.size < 4096) seen.set(selfId, allowed);
        return allowed;
    }
    function speciesBound(selfId) {
        const npc = npcTemplate(selfId);
        if (!npc || !huntingTargetPolicy().canHunt(npc)) return null;
        const target = coldCombatProfile().npcCombatStats(npc);
        if (!(target?.maxHp > 0) || !(target.pAtk > 0)
            || !(target.basePDef > 0) || !(target.baseMDef > 0)) return true;
        // The gate's own lifetime and opening (soloSurvival), no summon cast.
        const seconds = sideLifetime(target, profiles, coldMobAction(), coldCombatProfile().openingMs(receivers[0], target) / 1000).total;
        // The largest term a hit of theirs can meet: a damage weakness of the
        // target, times a profile's bonus against its race or undead kind.
        let vulnerability = 1, bonus = 1;
        for (const stat of DAMAGE_VULN_STATS) vulnerability = Math.max(vulnerability, coldCombatProfile().npcVulnerability(target, stat));
        for (const profile of profiles) bonus = Math.max(bonus, HitRules.targetModifier({ race: target.race, undead: target.undead === true },
            () => 1, profileBonus(profile)));
        vulnerability *= bonus;
        const damage = bounds.reduce((sum, bound) => sum + Math.max(
            bound.continuous * seconds / positive(target.pDef),
            Math.min(bound.physicalRate * seconds, bound.physicalBudget) / positive(target.pDef),
            Math.min(bound.magicRate * seconds, bound.magicBudget) / positive(target.mDef)) * vulnerability, 0);
        return damage / target.maxHp >= SOLO_GATE_MARGIN;
    }
    return spot => {
        let total = 0, safe = 0;
        for (const entry of spot.npcEntries || []) {
            const allowed = maybeSafe(Number(entry.selfId));
            if (allowed === null) continue;
            const weight = Math.max(1, number(entry.count));
            total += weight;
            if (allowed) safe += weight;
        }
        return !total || safe / total >= 0.6;
    };
}

// options.buffed: the fight profile (buffs and night at options.timestamp)
// instead of the bot's kit profile; options.store: handed to the profile
// (false: a what-if state under the bot's id).
function stateProfiles(state, options = {}) {
    if (options.matchupProfiles) return options.matchupProfiles;
    const states = (options.capacityStates?.length ? options.capacityStates : [state])
        .filter(member => member.vitals?.hp !== 0 && member.activity !== 'dead');
    // Do not invent the other members of an incomplete party projection.
    if (options.mode === 'party' && states.length === 1) return [];
    const Cold = coldCombatProfile();
    const profiles = states.flatMap(member => typeof member.fetchHp === 'function'
        ? actorProfiles([member])
        : coldProfiles({ ...Cold.withBuildSite('matchup', () => (options.buffed === true ? Cold.fightProfile : Cold.profileFor)(
            member, options.timestamp, { store: options.store })),
            // Partial route projections must not turn an invented default
            // class/build into evidence that the real character is too weak.
            survivalKnown: !!member.stats?.coldCombat
                || Number.isFinite(Number(member.stats?.classId ?? member.classId))
        }, member, options.timestamp));
    return profiles;
}

// A spot search checks hundreds of spots with one profile array, and each mob
// species appears on several of them. The verdict depends only on the
// profiles, the species and the safety options: it is computed when asked and
// kept only for that array (a WeakMap keyed by it, options.matchupProfiles of
// one search), so it dies with the search.
const npcVerdicts = new WeakMap();

// Verdicts of one profile array: safety options key -> species id -> verdict.
function optionVerdicts(profiles, options) {
    let byOptions = npcVerdicts.get(profiles);
    if (!byOptions) npcVerdicts.set(profiles, byOptions = new Map());
    const optionsKey = `${options.soloSafety ? 1 : 0}:${options.maxTargetLevel || 0}`;
    let verdicts = byOptions.get(optionsKey);
    if (!verdicts) byOptions.set(optionsKey, verdicts = new Map());
    return verdicts;
}

// pull: one size of the species' pulls on the spot; the fight meets a whole
// pull (resolveFight: BotPullEstimate.pullView), so the verdict judges it.
function npcVerdict(verdicts, selfId, options, pull = 1) {
    const size = wholePull(pull);
    const key = size > 1 ? `${selfId}:${size}` : selfId;
    if (verdicts.has(key)) return verdicts.get(key);
    const npc = npcTemplate(selfId);
    let verdict = null;
    if (npc && huntingTargetPolicy().canHunt(npc)) {
        const stats = coldCombatProfile().npcCombatStats(npc);
        const target = Pull.pullView(stats, size);
        // One attack list per profile against this species: the efficiency and
        // the solo survival read the same channels (pure in profile and target).
        const lists = new Map();
        const attacksOf = profile => { let list = lists.get(profile);
            if (!list) lists.set(profile, list = channels(profile, target)); return list; };
        const match = evaluate(options.profiles, target, attacksOf);
        const withinRecoveryLevel = !options.maxTargetLevel || Number(npc.template?.level || 0) <= options.maxTargetLevel;
        const canHunt = options.soloSafety ? pullVerdict(options.profiles, stats, size,
            { maxTargetLevel: options.maxTargetLevel, npcLevel: Number(npc.template?.level || 0), attacksOf }).eligible
            : match.eligible && withinRecoveryLevel;
        verdict = Object.freeze({ efficiency: match.efficiency, canHunt });
    }
    verdicts.set(key, verdict);
    return verdict;
}

// A spot's matchup reads only its mob list and the verdicts of one profile
// array and safety options, so it is kept beside them: a spot search checks
// hundreds of spots against the same verdicts.
const spotMatchups = new WeakMap();

// One spawn group's verdict over its pulls (BotPullEstimate.pullsOf): the
// pulls the profiles survive (allowed, their shares as measured), their
// share of the group, and the efficiency over all its pulls; null for a
// species no one hunts. The bot takes only the spawns it can (user 10-29).
function entryVerdict(verdicts, entry, verdictOptions) {
    const allowed = [];
    let efficiency = 0, share = 0, known = false;
    for (const [size, part] of Pull.pullsOf(entry)) {
        const verdict = npcVerdict(verdicts, Number(entry.selfId), verdictOptions, size);
        if (!verdict) continue;
        known = true;
        efficiency += part * verdict.efficiency;
        if (verdict.canHunt) {
            allowed.push([size, part]);
            share += part;
        }
    }
    return known ? { efficiency, canHunt: share > 0, share, allowed } : null;
}

// The spawn group's verdict for profiles under safety options, the one a spot
// search with the same profiles and options reads (spotMatchup), so a solo
// fight's pick (ColdCombatProfile.npcForSpot) shares it.
function speciesPulls(profiles, entry, options = {}) {
    return entryVerdict(optionVerdicts(profiles, options), entry,
        { profiles, soloSafety: options.soloSafety, maxTargetLevel: options.maxTargetLevel });
}

function spotMatchup(spot, profiles, options = {}) {
    if (!profiles?.length) return evaluate([], {});
    let total = 0, effective = 0, eligible = false, safe = 0;
    const verdicts = optionVerdicts(profiles, options);
    let bySpot = spotMatchups.get(verdicts);
    if (!bySpot) spotMatchups.set(verdicts, bySpot = new WeakMap());
    const known = bySpot.get(spot);
    if (known) return known;
    const verdictOptions = { profiles, soloSafety: options.soloSafety, maxTargetLevel: options.maxTargetLevel };
    for (const entry of spot.npcEntries || []) {
        const verdict = entryVerdict(verdicts, entry, verdictOptions);
        if (!verdict) continue;
        const weight = Math.max(1, number(entry.count));
        total += weight;
        effective += weight * Math.min(1, verdict.efficiency);
        eligible ||= verdict.canHunt;
        safe += weight * verdict.share;
    }
    const efficiency = total ? effective / total : 1;
    const safeFraction = total ? safe / total : 1;
    const spotEligible = !total || (eligible && (!options.soloSafety || safeFraction >= 0.6));
    const penalty = Math.round((1 - efficiency) * 250 + (options.soloSafety ? (1 - safeFraction) * 250 : 0));
    const result = Object.freeze({ efficiency, safeFraction, eligible: spotEligible, penalty });
    bySpot.set(spot, result);
    return result;
}

// A fixed attack envelope, shared with the survival gate. Admission may
// compare native buff effects without running an encounter simulation.
function damageRate(profiles, target = {}) {
    const rates = profiles.map(profile => bestRate(channels(profile, target)));
    const pair = soloPair(profiles);
    if (pair) rates[pair.owner] = Math.min(rates[pair.owner], rates[pair.pet]);
    return rates.reduce((sum, rate) => sum + rate, 0);
}

module.exports = { MIN_EFFICIENCY, SOLO_GATE_MARGIN, actorProfiles, coldProfiles, servitorProfile, profileKey, targetView, skillModifier, channels, damageRate, attackRate, spellRate, incomingRate,
    profileStats, skillStats, evaluate, atVitals, soloSurvival, soloCanHunt, pullVerdict, soloSpotUpperBound, stateProfiles, spotMatchup, speciesPulls, expectedHit, actorHit };
