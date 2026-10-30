'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
// The author's fixed shot merchant sells shots here (off by default since T116).
invoke('GameServer/Bot/Population/PopulationConfig').staticShotsDisabled = false;
const Data = invoke('GameServer/DataCache');
Data.init({ validate: false });
const Policy = invoke('GameServer/Bot/Population/OpportunisticRaidPolicy');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog');
const { OpportunisticRaidDirector } = require('../src/GameServer/Bot/Population/OpportunisticRaidDirector');
const SearchWork = require('../src/GameServer/Bot/Population/RaidSearchWork');
const at = 1800000000000;
const neutral = () => ({ ready: true, disposition: 'neutral', effective: { hostility: 0 } });

function member(id, classId, level, weapon, healer = false) {
    const gear = [weapon, 40, 45, 50, ...(healer ? [432, 465] : [347, 376, 625])];
    const slot = [7, 12, 6, 9, 10, 11, 8];
    const items = gear.map((selfId, i) => ({ selfId, amount: 1, equipped: 1,
        slot: [93, 124, 178, 291].includes(selfId) ? 14 : slot[i], name: Data.items.find(t => t.selfId === selfId).template.name }));
    [114, 114, 118, 876, 876].forEach((selfId, i) => items.push({ selfId, amount: 1, equipped: 1,
        slot: i + 1, name: Data.items.find(t => t.selfId === selfId).template.name }));
    items.push({ selfId: weapon === 3 ? 1835 : 1463, amount: 2500, slot: 0, equipped: 0 });
    const s = { characterId: id, name: `adventurer_${id}`, accountName: `bot_${id}`, level, classId,
        adena: 100000, phase: 'cold', activity: 'hunting', party: { partyId: null }, updatedAt: at,
        stats: { classId, coldCombat: { classId, skills: Combat.skillsFor({ classId, level }) } },
        inventory: Life.inventorySummaryFromItems(items) };
    const p = Combat.profileFor(s); s.vitals = { hp: p.maxHp, maxHp: p.maxHp, mp: p.maxMp, maxMp: p.maxMp };
    return s;
}

// Member 8 holds a Two-Handed Sword: a Human Warrior wears only two-handers or polearms (user 10-29).
const party = [member(1, 32, 26, 3), member(2, 42, 29, 178, true), member(3, 29, 26, 178, true),
    member(4, 54, 31, 157), member(5, 56, 29, 93), member(6, 56, 28, 168),
    member(7, 54, 28, 156), member(8, 1, 29, 124), member(9, 56, 30, 291)];
const spot = Catalog.findById('raid:10366');

// Frozen synchronous behavior for a narrow population: scheduling preserves
// score ties and tank order. Mixed level cohorts have separate coverage below.
function legacyShortlist(pool, cooldowns, cursor) {
    const all = pool.filter(s => (cooldowns.get(s.characterId) || 0) <= at && Policy.candidateReady(s, at));
    const tanks = all.filter(s => Policy.role(s) === 'tank');
    const offset = tanks.length ? cursor % tanks.length : 0;
    const anchors = [...tanks.slice(offset), ...tanks.slice(0, offset)].slice(0, 8);
    const nearby = all.filter(s => anchors.some(t => Math.abs(t.level - s.level) <= 7));
    const power = new Map(nearby.map(s => [s.characterId, Policy.candidatePower(s)]));
    const ranked = wanted => nearby.filter(s => Policy.role(s) === wanted)
        .sort((a, b) => power.get(b.characterId) - power.get(a.characterId) || a.characterId - b.characterId);
    return { candidates: [...anchors, ...ranked('healer').slice(0, 40), ...ranked('damage').slice(0, 112)], tankCursor: offset + 8 };
}

function legacyRosters(candidates, assess) {
    const pool = candidates.filter(s => Policy.candidateReady(s, at));
    const power = new Map(pool.map(s => [s.characterId, Policy.candidatePower(s)]));
    const ranked = [...pool].sort((a, b) => power.get(b.characterId) - power.get(a.characterId) || a.characterId - b.characterId);
    const result = [], seen = new Set();
    for (const tank of pool.filter(s => Policy.role(s) === 'tank')) {
        for (const upper of [0, 3, 7]) {
            const members = [tank];
            for (const wanted of ['healer', 'healer', ...Array(6).fill('damage')]) {
                const next = ranked.find(s => Policy.role(s) === wanted && !members.includes(s)
                    && s.level >= tank.level + upper - 7 && s.level <= tank.level + upper
                    && Math.max(...members.map(m => m.level), s.level) - Math.min(...members.map(m => m.level), s.level) <= 7
                    && members.every(peer => Policy.compatible(s, peer, assess, at)));
                if (!next) break;
                members.push(next);
            }
            const key = members.map(s => s.characterId).sort((a, b) => a - b).join(':');
            if (Policy.composition(members).ready && !seen.has(key)) { result.push(members); seen.add(key); }
            if (result.length >= 8) return result;
        }
    }
    return result;
}

async function run() {
    assert(Policy.composition(party).ready, 'the proven 1 tank, 2 oracles, 6 physical DD shape includes dwarves');
    const beforeForecast = JSON.stringify(party);
    const fit = Policy.assessment(party, spot, { timestamp: at });
    assert.equal(JSON.stringify(party), beforeForecast, 'forecast preparation never consumes the real inventory or mutates real vitals');
    assert(fit.ready, JSON.stringify(fit));
    assert(fit.seconds > 100 && fit.seconds <= 720, 'forecast includes boss regeneration and add waves');
    assert(fit.shotPlans.every(p => p.required > 0 && p.required < p.stock));
    const weaker = structuredClone(party); weaker[4].level = 24;
    assert(Policy.assessment(weaker, spot, { timestamp: at }).ready,
        'the lower level boundary is a power/gear check, not the original DD +5 observation');
    const cursed = structuredClone(party); cursed[1].level = 32;
    assert.equal(Policy.assessment(cursed, spot).reason, 'raid_level', 'support above +8 is also forbidden');
    const poor = structuredClone(party); poor[5].inventory[1463].amount = 1;
    assert.equal(Policy.candidatePower(poor[5]), Policy.candidatePower(party[5]),
        'purchasable shots do not rank otherwise identical fighters');
    assert(Policy.candidateReady(poor[5], at), 'a funded fighter can replenish before the raid');
    const fundedFit = Policy.assessment(poor, spot, { timestamp: at, fundSupplies: true });
    assert(fundedFit.ready && fundedFit.supplies.some(s => s.missing > 0), JSON.stringify(fundedFit));
    const broke = structuredClone(poor); broke[5].adena = 0;
    assert.equal(Policy.assessment(broke, spot, { timestamp: at, fundSupplies: true }).reason, 'raid_consumables_funds');
    assert.equal(Policy.assessment(poor, spot, { timestamp: at }).reason, 'raid_shot_reserve');
    const wrongGrade = structuredClone(party); wrongGrade[4].inventory[1464] = { selfId: 1464, amount: 9000 };
    delete wrongGrade[4].inventory[1463];
    assert.equal(Policy.assessment(wrongGrade, spot, { timestamp: at }).reason, 'raid_shot_reserve');
    const naked = structuredClone(party); delete naked[0].inventory[347]; delete naked[0].inventory[376];
    assert.equal(Policy.assessment(naked, spot).reason, 'raid_tank_body');
    const older = structuredClone(party).map(s => ({ ...s, level: s.level + 30 }));
    assert(!Policy.assessment(older, { ...spot, avgLevel: 53 }).ready,
        'higher boss tiers still require the unchanged combat safety margins');
    assert(Policy.levelAllowed({ level: 78 }, 80), 'the curse gate must not permanently exclude endgame bosses above the player cap');
    assert(Policy.levelAllowed({ level: 29 }, 21));
    assert(!Policy.recruitLevelAllowed({ level: 29 }, 21), 'recruitment leaves room for a level from ordinary mobs before the pull');
    assert(Policy.recruitLevelAllowed({ level: 29 }, 22));
    const npcRows = Data.npcs;
    Data.npcs = npcRows.map(n => n.selfId === 10366 ? { ...n, stats: { ...n.stats, mAtk: 1000000 } } : n);
    try { assert.equal(Policy.assessment(party, spot, { timestamp: at }).reason, 'raid_skill_burst_survival',
        'armor and physical DPS alone cannot admit a party that dies to the boss spell'); }
    finally { Data.npcs = npcRows; }
    const unlearned = structuredClone(party); unlearned[1].stats.coldCombat.skills = [];
    assert(!Policy.composition(unlearned).ready, 'a class name alone does not provide learned healing');
    for (const change of [{ karma: 1 }, { pk: 1 }, { pkProfile: {} }, { strategy: 'pk_hunting' }]) {
        assert(!Policy.available({ ...party[3], stats: { ...party[3].stats, ...change } }, at));
    }
    const hates = (source, target) => source.id === 9 && target.id === 4
        ? { ready: true, disposition: 'hostile', effective: { hostility: 20 } } : neutral();
    assert.equal(Policy.rosters(party, hates, at).length, 0, 'hostility between two DDs, in either direction, rejects the roster');
    assert.equal(Policy.rosters(party, () => ({ ready: false }), at).length, 0, 'unloaded social state fails closed');
    assert.equal(Policy.rosters(party, neutral, at).length, 1);
    const objective = { sourceKind: 'raid', opportunisticRaid: true, raidBossTemplateId: 10366,
        sourceLevel: 23, spotId: spot.id, assessment: fit };
    assert.equal(Policy.pullAdmission(party, objective), null);
    assert.equal(Policy.pullAdmission(poor, objective), 'raid_shot_reserve', 'native activation rereads depleted stock');

    const grouped = party.map(s => ({ ...s, activity: 'grouped', spotId: spot.id, loc: spot.center }));
    const formation = { partyId: 'native_raid_test', memberIds: grouped.map(s => s.characterId), leaderId: 1,
        status: 'active', spotId: spot.id, startedAt: at, stats: { objective } };
    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const mission = JSON.stringify(formation);
    assert.deepEqual(await Population.applyWorkerPartyRequirements(formation, {
        requirementRefreshedAt: at, memberPlans: party.map(s => ({ characterId: s.characterId, plan: null })) }), []);
    assert.equal(JSON.stringify(formation), mission, 'ordinary gear replanning cannot replace or release an agreed raid expedition');
    const Calculation = invoke('GameServer/Bot/Population/PartyGoalCalculation');
    const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
    const joint = await Calculation.calculate(formation, grouped, () => { throw Error('raid forecast must not build personal wishes'); }, at);
    const payload = { ok: true, joint, sources: Calculation.sources(grouped) };
    assert(Protocol.validateEnvelope(Protocol.envelope('party_goal_result', 'raid_test_epoch', payload), 'worker').ok,
        'the real worker forecast packet must pass transport validation');
    const fundedParty = { ...formation, stats: { objective: { ...objective, fundRaidSupplies: true } } };
    const fundedJoint = await Calculation.calculate(fundedParty, poor, () => { throw Error('no personal wishes'); }, at);
    const fundedPayload = { ok: true, joint: fundedJoint, sources: Calculation.sources(poor) };
    assert(fundedJoint.raidAssessment.ready && fundedJoint.raidAssessment.supplies.some(s => s.missing > 0));
    assert(Protocol.validateEnvelope(Protocol.envelope('party_goal_result', 'raid_test_epoch', fundedPayload), 'worker').ok);
    const corruptSupply = structuredClone(fundedPayload); corruptSupply.joint.raidAssessment.supplies[0].cost = Infinity;
    assert(!Protocol.validateEnvelope(Protocol.envelope('party_goal_result', 'raid_test_epoch', corruptSupply), 'worker').ok);
    const unsafe = structuredClone(payload); unsafe.joint.raidAssessment.seconds = Infinity;
    assert(!Protocol.validateEnvelope(Protocol.envelope('party_goal_result', 'raid_test_epoch', unsafe), 'worker').ok);
    const held = invoke('GameServer/Bot/Population/BackgroundPartyResolver').resolve({ party: formation,
        members: grouped, spot, elapsedMs: 60000, timestamp: at, targetNpcId: 10366 });
    assert.equal(held.debug.reason, 'raid_wait_native_activation', JSON.stringify(held.debug));
    assert.equal(held.debug.fights, 0, 'the invisible simplified resolver never rewards these raids');

    const Safety = invoke('GameServer/Bot/AI/BotRaidSafety'), World = invoke('GameServer/World/World');
    const actor = (id, selfId, boss = false) => ({ fetchId: () => id, fetchSelfId: () => selfId,
        fetchLevel: () => 23, fetchMaxHp: () => 1922, fetchHp: () => 1922, isDead: () => false,
        fetchIsRaidBoss: () => boss, ...(boss ? {} : { minionBossObjectId: 900 }), state: {} });
    const boss = actor(900, 10366, true), follower = actor(901, 10367), healer = actor(902, 10368);
    World.npc = { spawns: [boss, follower, healer], grid: {} };
    const owner = { backgroundRaidTactics: { bossId: 900, focusMinionId: 901 } };
    assert.equal(Safety.botClanRaidCombatPlan(owner, boss).focusMinion, healer, 'a healer preempts a sticky ordinary focus');
    const Effects = invoke('GameServer/Effects/EffectStore');
    Effects.apply(healer, { id: 100, key: 'stun', category: 'stun', type: 'debuff', duration: 30000 });
    assert.equal(Safety.botClanRaidCombatPlan(owner, boss).focusMinion, healer, 'stunning a healer must not move damage off it');
    Effects.remove(healer, 'stun');
    Effects.apply(healer, { id: 1069, key: 'sleep', category: 'sleep', type: 'debuff', duration: 30000 });
    assert.equal(Safety.botClanRaidCombatPlan(owner, boss).focusMinion, follower, 'sleep remains protected');
    Effects.remove(healer, 'sleep');

    let publications, formations = 0, selectedLevel;
    const crowd = [...party.map(s => Policy.role(s) === 'damage' ? { ...s, level: 31 } : s),
        ...Array.from({ length: 90 }, (_, i) => member(100 + i, 56, 31, 168))];
    const config = { opportunisticRaidMemberCooldownMs: 1800000, opportunisticRaidIntervalMs: 900000,
        opportunisticRaidSearchIntervalMs: 60000, opportunisticRaidMaxParties: 2, opportunisticRaidAliveFraction: .5 };
    const secondSpot = { ...spot, id: 'raid:10362', raidBossTemplateId: 10362, avgLevel: 24 };
    const director = new OpportunisticRaidDirector({ config, database: { execute: async () => [] },
        life: { cachedState: id => crowd.find(s => s.characterId === id),
            statesByIds: async ids => { assert(ids.length <= 16, 'main-thread normalization is paged below the native 64-owner limit');
                return crowd.filter(s => ids.includes(s.characterId)); },
            subscribePublications: listener => { publications = listener; crowd.forEach(s => listener({ characterId: s.characterId })); return () => {}; } },
        parties: { admitted: () => [], subscribeChanges: () => () => {} },
        catalog: { all: () => [spot, secondSpot], liveTemplateIds: () => new Set([10366, 10362]) },
        memory: { ensureMany: async () => {}, assess: neutral }, canWork: () => true, bossFree: () => true,
        assess: async () => fit,
        form: async (members, o) => { formations++; selectedLevel = o.sourceLevel;
            return { partyId: 'new', memberIds: members.map(s => s.characterId), stats: { objective: o } }; }
    });
    await director.start();
    await director.pulse(at); assert.equal(formations, 1, 'a compatible available roster autonomously creates one expedition');
    assert.equal(director.snapshot().search.total.formations, 1);
    assert.equal(director.rosterWindowCursor, 1, 'a completed search rotates the preferred member-level window');
    assert.equal(selectedLevel, 24, 'choose the first boss with preparation headroom, rather than the younger boss at the curse boundary');
    await director.pulse(at + 120000); assert.equal(formations, 1, 'the global cadence stops a second kill sweep');
    assert.equal(director.rosterWindowCursor, 1, 'a cadence-only tick does not consume a search-window turn');
    assert.equal(director.room(spot, [spot, secondSpot], new Set([10366]), []), false,
        'the last living boss in a band remains available to players');
    director.stop();
    publications({ characterId: 1 });

    const rotatedCrowd = Array.from({ length: 8 }, (_, i) => party.map((s,j) => ({ ...s,
        characterId: 9000 + i * 9 + j, level: 28 }))).flat();
    const bosses = Array.from({ length: 7 }, (_, i) => ({ ...spot, id: `raid:${11000+i}`,
        raidBossTemplateId: 11000+i, avgLevel: 24 }));
    const visited = new Set(); let forecasts = 0;
    const rotating = new OpportunisticRaidDirector({ config, database: { execute: async () => [] },
        life: { cachedState: id => rotatedCrowd.find(s => s.characterId === id),
            statesByIds: async ids => rotatedCrowd.filter(s => ids.includes(s.characterId)),
            subscribePublications: fn => { rotatedCrowd.forEach(s => fn({characterId:s.characterId})); return () => {}; } },
        parties: { admitted: () => [], subscribeChanges: () => () => {} },
        catalog: { all: () => bosses, liveTemplateIds: () => new Set(bosses.map(s => s.raidBossTemplateId)) },
        memory: { ensureMany: async () => {}, assess: neutral }, canWork: () => true, bossFree: () => true,
        assess: async (_m, target) => { forecasts++; visited.add(target.raidBossTemplateId);
            return {ready:false,reason:'raid_fight_too_long'}; }
    });
    await rotating.start();
    for (let i = 0; i < 8; i++) { const prior = forecasts; await rotating.pulse(at+i*60000);
        assert(forecasts-prior <= 12, 'boss rotation retains the worker forecast cap'); }
    assert.equal(visited.size, bosses.length, 'later suitable bosses are not starved by restarting every queue at the first boss');
    rotating.stop();

    let released = 0;
    const stranded = new OpportunisticRaidDirector({ config,
        parties: { admitted: () => [formation], find: () => formation, createOrUpdate: async () => formation },
        life: { statesByIds: async () => grouped }, canWork: () => true,
        catalog: { findById: () => spot }, assembly: { ready: () => true },
        memory: { ensureMany: async () => {}, assess: neutral }, assess: async () => fit,
        bossFree: () => true, hot: { activate: async () => ({ ok: false, reason: 'party_no_safe_placement' }) },
        dissolve: async () => { released++; }
    });
    stranded.active = true;
    const unexpired = formation.stats.objective.expiresAt;
    formation.stats.objective.expiresAt = at + 600000;
    for (let i = 0; i < 3; i++) await stranded.maintain(at + i * 4000);
    formation.stats.objective.expiresAt = unexpired;
    assert.equal(released, 1, 'an unreachable encounter releases the adventurers after bounded native placement attempts');
    assert.equal(stranded.lastResult.reason, 'raid_boss_unreachable');
    assert(stranded.blockedBosses.get(10366) > at, 'a broken spawn is temporarily skipped by subsequent roster proposals');

    const young = [member(4000, 32, 26, 3), member(4001, 29, 26, 178, true), member(4002, 42, 26, 178, true),
        ...Array.from({ length: 6 }, (_, i) => member(4010 + i, 56, 26, 168))];
    const olderCrowd = [member(4100, 32, 36, 3),
        ...Array.from({ length: 50 }, (_, i) => member(4200 + i, i % 2 ? 29 : 42, 36, 178, true)),
        ...Array.from({ length: 140 }, (_, i) => member(4300 + i, 56, 36, 168))];
    const mixed = [...young, ...olderCrowd];
    const oldMixed = legacyShortlist(mixed, new Map(), 0);
    assert(!oldMixed.candidates.some(s => s.characterId === 4001),
        'the previous global power cutoff reproduces the observed starvation of ready young healers');
    const fairMixed = await SearchWork.run(Policy.candidateSteps(mixed, new Map(), 0, at));
    assert(young.every(s => fairMixed.candidates.some(c => c.characterId === s.characterId)),
        'a complete ready junior cohort survives the shortlist beside a larger, stronger cohort');
    assert(fairMixed.candidates.length <= 160, 'level diversity retains the existing hydration and social-work cap');
    for (const wanted of ['healer', 'damage']) {
        const retained = fairMixed.candidates.filter(s => s.level === 36 && Policy.role(s) === wanted).map(s => s.characterId);
        assert.deepEqual(retained, oldMixed.candidates.filter(s => Policy.role(s) === wanted)
            .slice(0, retained.length).map(s => s.characterId), 'power ranking and stable ties inside a level cohort are unchanged');
    }
    const mixedRosters = await SearchWork.run(Policy.rosterSteps(fairMixed.candidates, neutral, at));
    assert(mixedRosters.some(r => r.every(s => s.level === 26)), 'the planner can actually assemble the retained young cohort');
    assert(mixedRosters.some(r => r.every(s => s.level === 36)), 'young candidates do not displace the senior cohort');
    assert(!Policy.rosters(fairMixed.candidates, (source, target) => source.id === 4001 && target.id === 4010
        ? { ready: true, disposition: 'hostile', effective: { hostility: 20 } } : neutral(), at)
        .some(r => r.every(s => s.level === 26)), 'diverse shortlisting must still reject hostile junior teammates');

    const tiers = [20, 26, 35, 44, 53, 62, 71, 78];
    const spread = tiers.flatMap((level, i) => [member(5000 + i, 32, level, 3),
        ...Array.from({ length: 10 }, (_, n) => member(5100 + i * 10 + n, n % 2 ? 29 : 42, level, 178, true)),
        ...Array.from({ length: 30 }, (_, n) => member(6000 + i * 30 + n, 56, level, 168))]);
    const wideShortlist = await SearchWork.run(Policy.candidateSteps(spread, new Map(), 0, at));
    assert(wideShortlist.candidates.length <= 160);
    assert.deepEqual(wideShortlist.candidates.filter(s => Policy.role(s) === 'tank').map(s => s.level), tiers,
        'fair support and DD selection preserves the rotating tank order');
    for (const level of tiers) {
        assert(wideShortlist.candidates.filter(s => s.level === level && Policy.role(s) === 'healer').length >= 2,
            `two learned healers remain represented at level ${level}`);
        assert(wideShortlist.candidates.filter(s => s.level === level && Policy.role(s) === 'damage').length >= 6,
            `six armed DDs remain represented at level ${level}`);
    }

    const variantTanks = Array.from({ length: 8 }, (_, i) => member(8000 + i, 32, 26, 3));
    const variants = [...variantTanks, ...[26, 29, 33].flatMap((level, i) => [
        member(8100 + i * 10, 29, level, 178, true), member(8101 + i * 10, 42, level, 178, true),
        ...Array.from({ length: 6 }, (_, n) => member(8200 + i * 10 + n, 56, level, 168))])];
    for (let cursor = 0; cursor < 3; cursor++) {
        const proposals = await SearchWork.run(Policy.rosterSteps(variants, neutral, at, 8, cursor));
        assert.deepEqual(proposals.map(r => r.find(s => Policy.role(s) === 'tank').characterId), variantTanks.map(s => s.characterId),
            'the eight-proposal budget gives each tank a turn before considering another variant of the same tank');
        assert(proposals.every(r => r.filter(s => Policy.role(s) !== 'tank').every(s => s.level === [26, 29, 33][cursor])),
            'rotating the preferred level window also exposes stronger alternatives when the first window cannot win');
    }

    // A roster with many level-compatible bosses must not consume every
    // worker forecast before a different, viable roster gets one attempt.
    const budgetPool = [...crowd, ...Array.from({ length: 7 }, (_, i) => member(9001 + i, 32, 26, 3))];
    const budgetSpots = Array.from({ length: 20 }, (_, i) => ({ ...secondSpot,
        id: `raid:${50000 + i}`, raidBossTemplateId: 50000 + i }));
    function budgetSearch(acceptedTank) {
        const assessed = [], formed = [];
        const service = new OpportunisticRaidDirector({ config, database: { execute: async () => [] },
            life: { cachedState: id => budgetPool.find(s => s.characterId === id),
                statesByIds: async ids => budgetPool.filter(s => ids.includes(s.characterId)),
                subscribePublications: listener => { budgetPool.forEach(s => listener({ characterId: s.characterId })); return () => {}; } },
            parties: { admitted: () => [], subscribeChanges: () => () => {} },
            memory: { ensureMany: async () => {}, assess: neutral }, canWork: () => true, bossFree: () => true,
            catalog: { all: () => budgetSpots, liveTemplateIds: () => new Set(budgetSpots.map(s => s.raidBossTemplateId)) },
            assess: async members => { assessed.push(members[0].characterId);
                return members[0].characterId === acceptedTank ? fit : { ready: false, reason: 'raid_fight_too_long' }; },
            form: async (members, objective) => { formed.push(members[0].characterId);
                return { partyId: 'budget-test', memberIds: members.map(s => s.characterId), stats: { objective } }; }
        });
        return { service, assessed, formed };
    }
    const viableLater = budgetSearch(9001);
    await viableLater.service.start(); await viableLater.service.pulse(at); viableLater.service.stop();
    assert.deepEqual(viableLater.assessed, [1, 9001], 'give the next roster a forecast before retrying the first roster on another boss');
    assert.deepEqual(viableLater.formed, [9001], 'the later viable roster can form under the existing forecast cap');
    const rejectedBudget = budgetSearch(-1);
    await rejectedBudget.service.start(); await rejectedBudget.service.pulse(at); rejectedBudget.service.stop();
    assert.equal(rejectedBudget.assessed.length, 12, 'fair scheduling preserves the per-search worker forecast limit');
    assert.equal(new Set(rejectedBudget.assessed.slice(0, 8)).size, 8, 'all eight proposed rosters get their first assessment');
    assert.equal(rejectedBudget.formed.length, 0);
    const counted = rejectedBudget.service.snapshot().search;
    assert.equal(counted.total.searches, 1);
    assert.equal(counted.total.rosterAttempts, 8);
    assert.equal(counted.total.rostersAssessed, 8);
    assert.equal(counted.total.forecasts, 12);
    assert.equal(counted.rejections.forecast.raid_fight_too_long, 12,
        'a refusal is counted once per actual worker forecast, not once per roster');
    assert(counted.total.hydratedBots <= 72 && counted.total.socialChecks <= 288);

    const heavyReady = budgetSearch(1);
    heavyReady.service.assess = async () => ({ ...fit, workMs: 100 });
    await heavyReady.service.start(); await heavyReady.service.pulse(at); heavyReady.service.stop();
    assert.deepEqual(heavyReady.formed, [1], 'a completed successful forecast may form even if that one forecast exceeded the CPU budget');

    const cpuLimited = budgetSearch(-1);
    cpuLimited.service.assess = async members => {
        cpuLimited.assessed.push(members[0].characterId);
        return { ready: false, reason: 'raid_fight_too_long', workMs: 6,
            reasons: ['raid_fight_too_long', 'raid_tank_survival'], unchecked: ['supplies'] };
    };
    await cpuLimited.service.start(); await cpuLimited.service.pulse(at); cpuLimited.service.stop();
    const cpuCounted = cpuLimited.service.snapshot().search;
    assert.equal(cpuLimited.assessed.length, 2, 'stop before another worker forecast once its CPU budget is spent');
    assert.equal(cpuCounted.lastSearch.status, 'forecast_cpu_budget');
    assert.equal(cpuCounted.total.forecastWorkMs, 12);
    assert.equal(cpuCounted.total.forecastFailures, 2);
    assert.equal(cpuCounted.rejections.forecast.raid_fight_too_long, 2);
    assert.equal(cpuCounted.additionalReasons.raid_tank_survival, 2);
    assert.equal(cpuCounted.unchecked.supplies, 2);

    const queued = budgetSearch(-1);
    queued.service.assess = async members => {
        queued.assessed.push(members[0].characterId);
        return { ready: false, reason: 'raid_fight_too_long', workMs: 6 };
    };
    await queued.service.start(); await queued.service.pulse(at);
    const awaiting = queued.service.deferredRosters.map(ids => ids[0]);
    assert.equal(awaiting.length, 6, 'the CPU limit preserves unforecasted combinations');
    await queued.service.pulse(at + 60000);
    assert(queued.assessed.slice(2).every(id => awaiting.includes(id)), 'deferred combinations get forecasts before newly sampled ones');
    assert.equal(queued.service.deferredRosters.filter(ids => awaiting.includes(ids[0])).length, 4,
        'only the two forecasted deferred rosters are retired; fresh proposals remain bounded');
    assert(queued.service.snapshot().search.lastSearch.hydratedBots <= 72);
    queued.service.stop();

    // A full deferred queue leaves room for just one fresh anchor per pass.
    // Rotation must advance only past tanks actually examined, or the same
    // two blocks of anchors repeatedly hide the tail of a stable tank pool.
    const tankPool = Array.from({ length: 16 }, (_, i) => member(10000 + i, 32, 28, 3));
    const sustainedPool = [...tankPool, member(10100, 42, 28, 178, true), member(10101, 29, 28, 178, true),
        ...Array.from({ length: 18 }, (_, i) => member(10200 + i, 56, 28, 168))];
    const tankForecasts = new Map();
    const sustained = new OpportunisticRaidDirector({ config,
        database: { execute: async () => [] },
        life: { cachedState: id => sustainedPool.find(s => s.characterId === id),
            statesByIds: async ids => sustainedPool.filter(s => ids.includes(s.characterId)),
            subscribePublications: listener => { sustainedPool.forEach(s => listener({ characterId: s.characterId })); return () => {}; } },
        parties: { admitted: () => [], subscribeChanges: () => () => {} },
        memory: { ensureMany: async () => {}, assess: neutral }, canWork: () => true, bossFree: () => true,
        catalog: { all: () => [spot, secondSpot], liveTemplateIds: () => new Set([spot.raidBossTemplateId, secondSpot.raidBossTemplateId]) },
        assess: async members => {
            const id = members[0].characterId;
            tankForecasts.set(id, (tankForecasts.get(id) || 0) + 1);
            return { ready: false, reason: 'raid_fight_too_long', workMs: 12 };
        }, form: async () => assert.fail('rejected forecasts must never form a party') });
    await sustained.start();
    try {
        for (let turn = 0; turn < 120; turn++) {
            await sustained.pulse(at + turn * 60000);
            const report = sustained.snapshot().search;
            assert.equal(report.lastSearch.forecasts, 1, 'the same 12 ms CPU budget permits only one forecast per window');
            assert(report.lastSearch.rosterAttempts <= 8 && report.lastSearch.hydratedBots <= 72
                && report.lastSearch.socialChecks <= 288 && report.pendingRosters <= 7,
            'sustained coverage retains the existing per-window work and queue bounds');
        }
        assert.equal(tankForecasts.size, 16, 'every eligible tank reaches the actual forecast despite the persisted queue');
        assert(tankPool.every(s => tankForecasts.get(s.characterId) >= 2), 'all tanks keep receiving turns after first coverage');
        assert(tankPool.every(s => [...sustained.coverage.tanks.get(s.characterId).combinations.values()]
            .reduce((sum, c) => sum + c.turn, 0) >= 2), 'fresh combinations continue rotating for every tank');
    } finally { sustained.stop(); }

    const overrun = budgetSearch(-1);
    overrun.service.assess = async () => ({ ready: false, reason: 'raid_fight_too_long', workMs: 30 });
    await overrun.service.start(); await overrun.service.pulse(at);
    assert.equal(overrun.service.snapshot().search.total.forecasts, 1);
    await overrun.service.pulse(at + 60000);
    assert.equal(overrun.service.snapshot().search.total.forecasts, 1, 'a CPU overrun is repaid by deferring the following window');
    assert.equal(overrun.service.snapshot().search.cpuBudget.deferredSearches, 1);
    await overrun.service.pulse(at + 120000);
    assert.equal(overrun.service.snapshot().search.total.forecasts, 2, 'a refilled positive allowance resumes search');
    overrun.service.stop();

    const hotParty = { partyId: 'progress', status: 'hot', startedAt: at,
        stats: { objective: { sourceKind: 'raid', opportunisticRaid: true, sourceLevel: 26, expiresAt: at + 2700000 },
            hotLifecycle: { startedAt: at } } };
    let guardHp = 2000, guardsPresent = true;
    const progressBoss = { fetchId: () => 1, fetchHp: () => 17694, isDead: () => false };
    const guard = { fetchId: () => 2, fetchHp: () => guardHp, fetchMaxHp: () => 2000 };
    const hotSession = { hotBackgroundPartyId: 'progress', actor: { fetchLevel: () => 31 } };
    const abandoned = [];
    const progressing = new OpportunisticRaidDirector({ config,
        parties: { admitted: () => [hotParty] }, sessions: () => [hotSession],
        bossFor: () => progressBoss, defeated: () => null,
        raidEntities: () => [progressBoss, ...(guardsPresent ? [guard] : [])],
        lod: { promote() {} }, hot: { abandonRaid: async (_s, reason) => { abandoned.push(reason); } }
    });
    progressing.active = true;
    await progressing.maintain(at);
    guardHp = 1000;
    await progressing.maintain(at + 7 * 60000);
    await progressing.maintain(at + 9 * 60000);
    assert.equal(abandoned.length, 0, 'real damage to the guard is progress while the boss regenerates to full');
    guardsPresent = false;
    await progressing.maintain(at + 10 * 60000);
    await progressing.maintain(at + 17 * 60000);
    assert.equal(abandoned.length, 0, 'a killed guard removed from the world index is also progress');
    await progressing.maintain(at + 18 * 60000 + 1);
    assert.deepEqual(abandoned, ['raid_no_progress'], 'idle target decisions cannot keep an expedition alive');

    abandoned.length = 0;
    progressing.encounters.clear();
    await progressing.maintain(at);
    hotSession.lastSupportOutcome = { outcome: 'landed', at: at + 7 * 60000 };
    await progressing.maintain(at + 7 * 60000);
    await progressing.maintain(at + 9 * 60000);
    assert.equal(abandoned.length, 0, 'native landed preparation buffs prevent a false pre-pull timeout');
    hotSession.lastSupportOutcome = { outcome: 'failed', at: at + 14 * 60000 };
    await progressing.maintain(at + 15 * 60000 + 1);
    assert.deepEqual(abandoned, ['raid_no_progress'], 'rejected casts and regeneration do not count as progress');

    abandoned.length = 0;
    progressing.encounters.clear();
    hotSession.raidPreparationComplete = true;
    hotSession.lastSupportOutcome = null;
    await progressing.maintain(at);
    hotSession.lastSupportOutcome = { outcome: 'landed', at: at + 7 * 60000 };
    await progressing.maintain(at + 8 * 60000 + 1);
    assert.deepEqual(abandoned, ['raid_no_progress'], 'combat rebuffs cannot conceal a stalled fight');

    abandoned.length = 0;
    progressing.encounters.clear();
    hotSession.raidPreparationComplete = false;
    hotSession.lastSupportOutcome = null;
    await progressing.maintain(at);
    for (const minute of [7, 14, 21, 25]) {
        hotSession.lastSupportOutcome = { outcome: 'landed', at: at + minute * 60000 };
        await progressing.maintain(at + minute * 60000);
    }
    await progressing.maintain(at + 25 * 60000 + 1);
    assert.deepEqual(abandoned, ['raid_admission_expired'], 'preparation activity cannot extend the hard expedition limit');
    abandoned.length = 0;
    progressing.encounters.clear();
    await progressing.maintain(at + 26 * 60000);
    assert.deepEqual(abandoned, ['raid_admission_expired'], 'the native hot start keeps the hard limit across a director restart');

    const large = [...crowd, ...Array.from({ length: 12 }, (_, i) => member(1000 + i, 32, 26, 3)),
        ...Array.from({ length: 1400 }, (_, i) => ({ ...crowd[9], characterId: 2000 + i }))];
    const cooldowns = new Map([[1003, at + 1000]]);
    const slices = [];
    let heartbeat = false;
    setImmediate(() => { heartbeat = true; });
    const shortlist = await SearchWork.run(Policy.candidateSteps(large, cooldowns, 5, at), {
        onSlice: slice => slices.push(slice)
    });
    assert(heartbeat, 'game-loop callbacks run before the large equipment scan finishes');
    assert(slices.length > 10 && slices.every(s => s.steps <= 32), 'both expensive and cheap scans have bounded portions');
    assert.deepEqual(shortlist, legacyShortlist(large, cooldowns, 5), 'same scores, cooldowns and rotating anchors as the synchronous picker');
    const rows = rosters => rosters.map(r => r.map(s => s.characterId));
    for (const relations of [neutral, (source, target) => source.id % 4 === target.id % 4
        ? { ready: true, disposition: 'hostile', effective: { hostility: 20 } } : neutral()]) {
        heartbeat = false;
        setImmediate(() => { heartbeat = true; });
        const selected = await SearchWork.run(Policy.rosterSteps(shortlist.candidates, relations, at));
        assert(heartbeat, 'relationship search yields inside the greedy member loop');
        assert.deepEqual(rows(selected), rows(legacyRosters(shortlist.candidates, relations)), 'relationship and tie decisions are unchanged');
    }

    let clock = 0, timeYields = 0;
    function* timedWork() { for (let i = 0; i < 12; i++) { clock += .75; yield; } return 'done'; }
    const timedSlices = [];
    assert.equal(await SearchWork.run(timedWork(), { now: () => clock, sliceMs: 2, maxSteps: 100,
        yieldNow: async () => { timeYields++; }, onSlice: s => timedSlices.push(s) }), 'done');
    assert(timeYields > 0 && timedSlices.filter(s => !s.done).every(s => s.steps === 3),
        'the time budget yields before the item-count limit, allowing at most one indivisible step over budget');
    let alive = true, closed = false;
    function* cancelledWork() { try { while (true) yield; } finally { closed = true; } }
    assert.equal(await SearchWork.run(cancelledWork(), { current: () => alive, now: () => 0, maxSteps: 2,
        yieldNow: async () => { alive = false; } }), null);
    assert(closed, 'cancellation closes suspended generator state');

    for (const reason of ['stop', 'reset', 'memory_reset', 'hydration_stop', 'assessment_stop']) {
        let publish, commits = 0, assessments = 0, reads = 0, interrupted = false;
        const cancelled = new OpportunisticRaidDirector({ config, database: { execute: async () => [] },
            life: { cachedState: id => crowd.find(s => s.characterId === id), statesByIds: async ids => {
                reads++;
                if (reason === 'hydration_stop') cancelled.stop();
                return crowd.filter(s => ids.includes(s.characterId));
            },
                subscribePublications: listener => { publish = listener; crowd.forEach(s => listener({ characterId: s.characterId })); return () => {}; } },
            parties: { admitted: () => [], subscribeChanges: () => () => {} },
            memory: { ensureMany: async () => { if (reason === 'memory_reset') publish({ kind: 'reset' }); }, assess: neutral },
            catalog: { all: () => [spot, secondSpot], liveTemplateIds: () => new Set([10366, 10362]) },
            canWork: () => true, bossFree: () => true,
            assess: async () => { assessments++; if (reason === 'assessment_stop') cancelled.stop(); return fit; },
            form: async () => { commits++; return null; },
            searchScheduling: { maxSteps: 2, yieldNow: async () => {
                if (!['stop', 'reset'].includes(reason) || interrupted) return;
                interrupted = true;
                if (reason === 'stop') cancelled.stop(); else publish({ kind: 'reset' });
            } }
        });
        await cancelled.start();
        await cancelled.pulse(at);
        assert.equal(commits, 0, `${reason}: a suspended proposal cannot commit after shutdown or a world reset`);
        assert.equal(cancelled.running, false);
        assert.equal(assessments, reason === 'assessment_stop' ? 1 : 0);
        if (reason === 'memory_reset') assert.equal(reads, 0, 'no hydration starts after a reset during social loading');
        if (reason === 'hydration_stop') assert.equal(reads, 1, 'shutdown stops the remaining hydration pages');
        cancelled.stop();
    }
    console.log('Opportunistic raid recruitment, admission, native combat boundary and healer priority checks passed');
}
run().catch(e => { console.error(e); process.exitCode = 1; });
