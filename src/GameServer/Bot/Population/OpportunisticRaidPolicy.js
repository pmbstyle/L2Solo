'use strict';

const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Shots = invoke('GameServer/Inventory/ShotStock');
const Rules = invoke('GameServer/Skills/C4SkillRules');
const Buffs = invoke('GameServer/Bot/AI/PartyBuffLoadout');
const Capabilities = require('../../Clan/ClanCandidateCapabilities');
const Rewards = require('../../Actor/PartyRewardMath');
const Supply = require('./RaidSupplyPolicy');
const Priority = require('./RaidRosterPriority');
const BASE_CLASSES = new Set([0, 10, 18, 25, 31, 38, 44, 53]);
const id = s => Number(s?.characterId);
const isObjective = o => o?.opportunisticRaid === true && o.sourceKind === 'raid';
const levelAllowed = (s, bossLevel) => Number(s.level) >= Math.max(20, bossLevel - 2) && Number(s.level) <= bossLevel + 8;
// Nearby ordinary mobs can grant a level during travel or preparation.
// Keep one level before the native +8 curse boundary when recruiting.
const recruitLevelAllowed = (s, bossLevel) => levelAllowed(s, bossLevel) && Number(s.level) <= bossLevel + 7;
const criminal = s => !!s?.stats?.pkProfile || !!s?.pkProfile || ['pk', 'pk_hunting'].includes(s?.stats?.strategy)
    || Number(s?.stats?.karma ?? s?.karma) > 0 || Number(s?.stats?.pk ?? s?.pk) > 0;
const role = s => Roles.isPartyMusicFighter(s) ? 'damage'
    : Roles.inferRole(s) === 'tank' ? 'tank'
        : ['healer', 'buffer'].includes(Roles.inferRole(s)) && Capabilities.learnedSkills(s).some(Capabilities.healingSkill)
            ? 'healer' : ['dps', 'spoiler', 'crafter', 'archer', 'dagger'].includes(Roles.inferRole(s)) ? 'damage' : null;

function candidatePower(s) {
    if (role(s) !== 'damage') return Gear.combatReadiness(s).effectiveLevel || s.level;
    const weapon = Object.values(s.inventory || {}).find(i => (i.equipped || i.equippedCount > 0) && [7, 14].includes(Number(i.slot)));
    const stats = require('../../Item/ItemTemplateIndex').find(invoke('GameServer/DataCache').items, weapon?.selfId)?.stats;
    return Number(stats?.pAtk || 0) * Number(stats?.atkSpd || 300) * (1 + Number(s.level) / 100);
}

function candidateReady(s, timestamp = Date.now()) {
    if (!available(s, timestamp) || !role(s) || !(Supply.cash(s) > 0)) return false;
    if (role(s) === 'tank') return tankArmor(s).length === 0;
    const readiness = Gear.combatReadiness(s);
    if (role(s) !== 'damage') return true;
    const shot = Shots.planForState(s);
    return readiness.hasWeapon && shot.perAction > 0;
}

function available(s, timestamp = Date.now(), preparationId = null) {
    return !!s?.accountName && s.phase === 'cold' && Number(s.level) >= 20
        && !BASE_CLASSES.has(Number(s.classId ?? s.stats?.classId))
        && ['hunting', 'resting', 'party_wait'].includes(s.activity)
        && !s.party?.partyId && !s.partyId && Number(s.vitals?.hp) > 0
        && (!Supply.held(s, timestamp) || Supply.held(s, timestamp).id === preparationId)
        && !criminal(s)
        && !s.stats?.travel && !s.stats?.tradeMeeting && !s.stats?.supplyErrand
        && !s.stats?.warehouseWorkflow && !s.stats?.pvpEncounter && !s.stats?.pveEncounter
        && !s.stats?.clanPartyObjective && !s.stats?.playerPartyTakeover
        && s.stats?.strategy !== 'market' && s.stats?.partyRequest?.priority !== 'required'
        && !(Number(s.stats?.coldCompetition?.wait?.until) > timestamp);
}

function compatible(a, b, assess, timestamp) {
    return [[a, b], [b, a]].every(([source, target]) => {
        const r = assess({ id: id(source), clanId: Number(source.clanId || source.stats?.clanId || 0) },
            { id: id(target), clanId: Number(target.clanId || target.stats?.clanId || 0) }, {}, timestamp);
        return r?.ready === true && r.disposition !== 'hostile' && !r.diplomaticEnemy
            && !r.clanSocial?.diplomaticEnemy && Number(r.effective?.hostility || 0) < 10;
    });
}

function hasRaidBuffs(members) {
    const all = (1 << members.length) - 1;
    let might = 0, shield = 0;
    for (let i = 0; i < members.length; i++) {
        const source = members[i];
        let clanRecipients;
        for (const skill of Capabilities.learnedSkills(source)) {
            if (skill.passive) continue;
            const semantic = Rules.resolveCached(skill);
            if (semantic.effectType !== 'buff' || !['friendly', 'party', 'ally'].includes(semantic.target)) continue;
            const family = Buffs.family(semantic.effect, semantic.stackFamily);
            if (family !== 'might' && family !== 'shield') continue;
            if ((family === 'might' ? might : shield) === all) continue;
            let recipients = all;
            if (semantic.target === 'ally' || semantic.sourceTarget === 'clan') {
                // A clan aura includes its caster, but two clanless bots
                // cannot supply one another. Union coverage across providers.
                if (clanRecipients === undefined) {
                    const clanId = Number(source.clanId || source.stats?.clanId || 0);
                    clanRecipients = 1 << i;
                    if (clanId > 0) for (let j = 0; j < members.length; j++) {
                        if (clanId === Number(members[j].clanId || members[j].stats?.clanId || 0)) clanRecipients |= 1 << j;
                    }
                }
                recipients = clanRecipients;
            }
            if (family === 'might') might |= recipients;
            else shield |= recipients;
            if (might === all && shield === all) return true;
        }
    }
    return false;
}

function composition(members) {
    const tanks = members.filter(s => role(s) === 'tank');
    const healers = members.filter(s => role(s) === 'healer');
    const damage = members.filter(s => role(s) === 'damage');
    const aggression = tanks.some(s => Capabilities.learnedSkills(s).some(skill => !skill.passive
        && [28, 18].includes(Number(skill.selfId))));
    const ready = members.length === 9 && new Set(members.map(id)).size === 9
        && tanks.length === 1 && healers.length === 2 && damage.length === 6 && aggression
        && Rewards.validMemberIndexes(members.map(s => Number(s.level))).length === 9 && hasRaidBuffs(members);
    return { ready, tanks: tanks.length, healers: healers.length, damage: damage.length,
        reason: ready ? 'raid_ready' : 'raid_roles_or_learned_skills_missing' };
}

// Take turns between nearby level cohorts, keeping the power ranking inside
// each one. A global top-N lets older supports/DDs hide every junior roster.
// Three-level cohorts retain several choices inside the seven-level party
// window while covering the full C4 population within the existing caps.
function* levelShortlist(ranked, limit) {
    const cohorts = new Map();
    for (const s of ranked) {
        const key = Math.floor(Number(s.level) / 3);
        if (!cohorts.has(key)) cohorts.set(key, []);
        cohorts.get(key).push(s);
        yield;
    }
    const groups = [...cohorts.values()], selected = [];
    for (let rank = 0; selected.length < limit; rank++) {
        let added = false;
        for (const group of groups) {
            if (group[rank]) { selected.push(group[rank]); added = true; }
            yield;
            if (selected.length === limit) break;
        }
        if (!added) break;
    }
    return selected;
}

// Checkpoint after each equipment/shot inspection, power calculation and
// shortlist entry. Roles and scores never outlive this pass.
function* candidateSteps(candidates, cooldowns, tankCursor, timestamp, coverage = null, deferred = []) {
    const pool = [], tanks = [], byId = new Map();
    for (const s of candidates) {
        if ((cooldowns.get(id(s)) || 0) <= timestamp && candidateReady(s, timestamp)) {
            pool.push(s); byId.set(id(s), s);
            if (role(s) === 'tank') tanks.push(s);
        }
        yield;
    }
    const offset = tanks.length ? (tankCursor || 0) % tanks.length : 0;
    const anchors = [...tanks.slice(offset), ...tanks.slice(0, offset)].slice(0, 8);
    // Alternate a fresh, promising roster with the ordinary coverage queue.
    // It replaces one of the eight slots; neither lane can starve the other.
    const priorityPass = coverage && coverage.passes++ % 2 === 0;
    let priorityTank;
    if (priorityPass && tanks.length) {
        const scores = new Map();
        for (const tank of tanks) { scores.set(id(tank), Priority.facts(tank, 'tank', timestamp).score); yield; }
        const ranked = [...tanks].sort((a, b) => scores.get(id(b)) - scores.get(id(a)) || id(a) - id(b));
        priorityTank = ranked[coverage.priorityCursor++ % ranked.length];
        yield;
    }
    const healers = [], damage = [], power = new Map(), hints = new Map();
    const searchAnchors = priorityTank ? [...anchors, priorityTank] : anchors;
    for (const s of pool) {
        if (searchAnchors.some(t => Math.abs(t.level - s.level) <= 7)) {
            const wanted = role(s);
            if (wanted === 'healer' || wanted === 'damage') {
                power.set(id(s), candidatePower(s));
                if (priorityTank && Math.abs(priorityTank.level - s.level) <= 7) hints.set(id(s), Priority.facts(s, wanted, timestamp));
                (wanted === 'healer' ? healers : damage).push(s);
            }
        }
        yield;
    }
    const compare = (a, b) => power.get(id(b)) - power.get(id(a)) || id(a) - id(b);
    healers.sort(compare); yield;
    damage.sort(compare); yield;
    if (coverage) {
        const levels = list => {
            const result = new Map();
            for (const state of list) result.set(state.level, (result.get(state.level) || 0) + 1);
            return result;
        };
        const healingLevels = levels(healers), damageLevels = levels(damage), proposals = [], selected = new Map();
        const rejected = {};
        const count = (map, low, high) => {
            let total = 0;
            for (let level = low; level <= high; level++) total += map.get(level) || 0;
            return total;
        };
        // A CPU-limited pass keeps its unforecasted combinations. Re-read
        // eligibility from this pass's pool and hydrate/social-check again;
        // queued IDs never retain stale gear or permission to join a party.
        const seen = new Set();
        let priorityKey = null;
        const pick = members => {
            const key = members.map(id).sort((a, b) => a - b).join(':');
            if (seen.has(key)) return false;
            seen.add(key); proposals.push(members);
            for (const member of members) selected.set(id(member), member);
            return true;
        };
        if (priorityTank) {
            const upper = coverage.window(id(priorityTank), u => count(healingLevels, priorityTank.level + u - 7, priorityTank.level + u) >= 2
                && count(damageLevels, priorityTank.level + u - 7, priorityTank.level + u) >= 6);
            if (upper !== null) {
                // One nearby cohort can unlock a stronger learned buff without
                // replacing the tank's equipment. Both variants replace ordinary
                // slots inside the same eight-roster/72-member search budget.
                for (const window of [upper, upper === 7 ? 6 : upper + 1]) {
                    const healing = [], fighters = [], low = priorityTank.level + window - 7, high = priorityTank.level + window;
                    for (const [list, target] of [[healers, healing], [damage, fighters]]) for (const state of list) {
                        if (state.level >= low && state.level <= high) target.push(state);
                        yield;
                    }
                    const pair = yield* Priority.supportPair(healing, hints);
                    fighters.sort((a, b) => hints.get(id(b)).score - hints.get(id(a)).score || id(a) - id(b)); yield;
                    if (pair && fighters.length >= 6) {
                        const members = [priorityTank, ...pair, ...fighters.slice(0, 6)];
                        if (pick(members) && priorityKey === null) priorityKey = members.map(id).join(':');
                    }
                }
            }
        }
        const freshCount = proposals.length;
        for (const ids of deferred) {
            const members = [];
            for (const key of ids) { members.push(byId.get(key)); yield; }
            if (members.length === 9 && members.every(Boolean)) pick(members);
            if (proposals.length === 8) break;
        }
        // Drain surviving combinations before filling spare slots with more
        // ordinary ones. This also leaves room for both priority cohorts on
        // the next alternating pass, rather than dropping an untested tail.
        const draining = proposals.length > freshCount;
        let examined = 0;
        for (const tank of anchors) {
            if (proposals.length === 8 || draining) break;
            examined++;
            const upper = coverage.window(id(tank), u => count(healingLevels, tank.level + u - 7, tank.level + u) >= 2
                && count(damageLevels, tank.level + u - 7, tank.level + u) >= 6);
            if (upper === null) { rejected.raid_roles_missing = (rejected.raid_roles_missing || 0) + 1; yield; continue; }
            const healing = [], fighters = [], low = tank.level + upper - 7, high = tank.level + upper;
            let firstLevel = Infinity, lastLevel = 0;
            for (const [list, selectedRole] of [[healers, healing], [damage, fighters]]) {
                for (const s of list) {
                    if (s.level >= low && s.level <= high) {
                        selectedRole.push(s); firstLevel = Math.min(firstLevel, s.level); lastLevel = Math.max(lastLevel, s.level);
                    }
                    yield;
                }
            }
            // Empty boundary levels must not restart the same role pools as
            // eight nominally different windows.
            const members = [tank, ...coverage.members(id(tank), `${firstLevel}:${lastLevel}`, healing, fighters)];
            pick(members);
            yield;
        }
        // Deferred rosters can occupy every slot. Resume at the first tank
        // we did not examine instead of skipping a full block of eight.
        return { candidates: [...selected.values()], proposals, rejected, tankCursor: offset + examined, priorityKey };
    }
    const selectedHealers = yield* levelShortlist(healers, 40);
    const selectedDamage = yield* levelShortlist(damage, 112);
    return { candidates: [...anchors, ...selectedHealers, ...selectedDamage], tankCursor: offset + 8 };
}

// Hydrate only the chosen combinations, then fail closed on current kits,
// membership and relationships. Eight proposals need at most 72 fresh rows
// and 288 bidirectional relationship checks, regardless of population size.
function* proposalSteps(proposals, hydrated, assess, timestamp, counters) {
    const byId = new Map(hydrated.map(s => [id(s), s])), result = [];
    for (const proposal of proposals) {
        const members = proposal.map(s => byId.get(id(s)));
        if (members.some(s => !s || !candidateReady(s, timestamp))) {
            counters?.reject('assembly', 'raid_members_changed'); yield; continue;
        }
        if (!composition(members).ready) {
            counters?.reject('assembly', 'raid_roles_or_learned_skills_missing'); yield; continue;
        }
        let agrees = true;
        for (let i = 0; i < members.length && agrees; i++) {
            for (let j = i + 1; j < members.length; j++) {
                counters?.add('socialChecks');
                agrees = compatible(members[i], members[j], assess, timestamp);
                yield;
                if (!agrees) break;
            }
        }
        if (agrees) result.push(members);
        else counters?.reject('assembly', 'raid_social_conflict');
        yield;
    }
    return result;
}

// Bounded roster search starts with the available adventurers, before looking
// at any boss. Every added member agrees with every existing member. Yield
// inside the greedy search, so a long run of incompatible peers is bounded too.
function* rosterSteps(candidates, assess, timestamp = Date.now(), limit = 8, windowCursor = 0) {
    const pool = [], power = new Map();
    for (const s of candidates) {
        if (candidateReady(s, timestamp)) pool.push(s);
        yield;
    }
    for (const s of pool) { power.set(id(s), candidatePower(s)); yield; }
    const ranked = [...pool].sort((a, b) => power.get(id(b)) - power.get(id(a)) || id(a) - id(b));
    const result = [];
    const seen = new Set();
    // Give every rotating tank one proposal before trying another window.
    // Otherwise the first three tanks can consume all eight proposal slots.
    // Rotate the preferred window too, so a valid but weak first variant
    // does not permanently hide a stronger party around the same tank.
    const windows = [0, 3, 7], offset = windowCursor % windows.length;
    const tanks = pool.filter(s => role(s) === 'tank');
    for (const upper of [...windows.slice(offset), ...windows.slice(0, offset)]) {
      for (const tank of tanks) {
        const members = [tank];
        for (const wanted of ['healer', 'healer', ...Array(6).fill('damage')]) {
            let next;
            for (const s of ranked) {
                if (role(s) !== wanted || members.includes(s)
                    || s.level < tank.level + upper - 7 || s.level > tank.level + upper
                    || Math.max(...members.map(m => m.level), s.level) - Math.min(...members.map(m => m.level), s.level) > 7) {
                    yield; continue;
                }
                let agrees = true;
                for (const peer of members) {
                    agrees = compatible(s, peer, assess, timestamp);
                    yield;
                    if (!agrees) break;
                }
                if (agrees) { next = s; break; }
            }
            if (!next) break;
            members.push(next);
        }
        const key = members.map(id).sort((a, b) => a - b).join(':');
        if (composition(members).ready && !seen.has(key)) { result.push(members); seen.add(key); }
        if (result.length >= limit) return result;
        yield;
      }
    }
    return result;
}

// Synchronous callers use exactly the same selection and relationship rules.
function rosters(...args) {
    const steps = rosterSteps(...args);
    let next;
    do { next = steps.next(); } while (!next.done);
    return next.value;
}

const Forecast = require('./RaidCombatAssessment');
const { prepared, tankArmor, equipmentFailures, damageEstimate } = Forecast;
function assessment(members, spot, options = {}) {
    return Forecast.assessment(members, spot, { ...options, roleFor: role,
        compositionReady: composition(members).ready, levelAllowed });
}

// Re-read after the worker fences, before publishing any native actors. A new
// weapon needs a fresh forecast; a changed stock never inherits old readiness.
function pullAdmission(members, objective) {
    if (!composition(members).ready || members.some(criminal)) return 'raid_composition_or_pk';
    if (members.some(s => !levelAllowed(s, objective.sourceLevel))) return 'raid_level';
    if (members.some(s => objective.assessment?.kits?.find(([key]) => key === id(s))?.[1]
        !== Combat.kitHash(Combat.combatView(s)).join(':'))) return 'raid_equipment_changed';
    for (const s of members.filter(s => role(s) !== 'healer')) {
        const expected = objective.assessment?.shotPlans?.find(p => p.id === id(s));
        const plan = Shots.planForState(s);
        if (!expected || plan.selfId !== expected.selfId || plan.perAction !== expected.perAction
            || Number(s.inventory?.[plan.selfId]?.amount || 0) + Shots.beginnerAmount(s, plan) < expected.required)
            return 'raid_shot_reserve';
    }
    return null;
}

module.exports = { isObjective, levelAllowed, recruitLevelAllowed, available, criminal, compatible, role, candidatePower, candidateReady, composition, candidateSteps, proposalSteps, rosterSteps, rosters, prepared, tankArmor, equipmentFailures, damageEstimate, assessment, pullAdmission };
