'use strict';

const ClanRules = require('./ClanRules');
const SavedSkills = require('../Bot/SavedSkills');

// Addressed planning inputs, never clan/member snapshots. Native rows stay in
// the lifecycle and warehouse; this queue only remembers which clan to visit.
const dirty = new Map();
const items = new Map();
const clanItems = new Map();
const clanLeaders = new Map();
const leaders = new Map();
const listeners = new Set();
const recruitment = new Map();
const recruitmentClasses = new Map();
let committedCandidates = null;
const MAX_RECRUITMENT_CLANS = 40;
let unsubscribeBoard = null, generation = 0;
let wake = null;

// At these levels, completing the cash goal means its ledger is funded. The
// native payment still owns the physical cash and leader-SP checks.
function cashLevelGoal(clan, goal = clan?.state?.goal) {
    const level = Number(clan?.level);
    return String(clan?.state?.mode || '') === 'autonomous'
        && (level === 0 || level === 1) && goal?.type === 'level'
        && goal.controlledBy !== 'player' && Number(goal.target?.level) === level + 1;
}

function forgetLeader(clanId) {
    const leaderId = clanLeaders.get(clanId);
    if (leaders.get(leaderId)?.clanId === clanId) leaders.delete(leaderId);
    clanLeaders.delete(clanId);
}

function untrack(clanId) {
    const id = Number(clanId);
    unwatchRecruitment(id);
    forgetLeader(id);
    for (const itemId of clanItems.get(id) || []) {
        const group = items.get(itemId); group?.delete(id); if (!group?.size) items.delete(itemId);
    }
    clanItems.delete(id);
    dirty.delete(id);
}

function leaderSpChanged(leaderId, beforeSp, afterSp) {
    const watched = leaders.get(Number(leaderId));
    if (!watched || !Number.isFinite(beforeSp) || !Number.isFinite(afterSp)
        || beforeSp < 0 || beforeSp >= watched.requiredSp || afterSp < watched.requiredSp) return false;
    return changed(watched.clanId, 'leader_sp');
}

function changed(clanId, cause = 'clan_input') {
    const id = Number(clanId);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    const causes = dirty.get(id) || new Set();
    causes.add(cause); dirty.set(id, causes);
    for (const listener of listeners) {
        try { listener(id, cause); } catch (error) { global.utils?.infoWarn?.('ClanReview', '%s', error?.message || error); }
    }
    try { wake?.(); } catch (error) { global.utils?.infoWarn?.('ClanReview', '%s', error?.message || error); }
    return true;
}

function syncRecruitment(clan) {
    const id = Number(clan?.id);
    if (!(id > 0)) return;
    const demand = clan.state?.recruitmentDemand;
    const owner = clan.state?.[demand?.ownerSection || 'goal'];
    if (clan.state?.mode === 'autonomous' && demand && owner && owner.status !== 'completed'
        && owner.controlledBy !== 'player' && (!demand.goalKey || demand.goalKey === owner.goalKey)) watchRecruitment(id, demand);
    else {
        const scan = clan.state?.recruitmentScan;
        const scanOwner = clan.state?.[scan?.ownerSection || 'goal'];
        if (clan.state?.mode === 'autonomous' && scan && (scan.goalKey || null) === (scanOwner?.goalKey || null)
            && scanOwner?.status !== 'completed' && scanOwner?.controlledBy !== 'player') watchRecruitment(id, scan);
        else unwatchRecruitment(id);
    }
}

function track(clan) {
    const id = Number(clan?.id);
    if (!(id > 0)) return;
    syncRecruitment(clan);
    forgetLeader(id);
    const leaderId = Number(clan.leaderId);
    if (cashLevelGoal(clan) && Number.isSafeInteger(leaderId) && leaderId > 0) {
        clanLeaders.set(id, leaderId);
        leaders.set(leaderId, { clanId: id, requiredSp: ClanRules.LEVEL_REQUIREMENTS[Number(clan.level)].sp });
    }
    const previous = clanItems.get(id) || new Set();
    const wanted = new Set();
    for (const goal of [clan.state?.goal, clan.state?.productionGoal]) {
        if (goal?.status === 'completed') continue;
        const itemId = Number(goal?.target?.itemId || goal?.target?.selfId);
        if (itemId > 0) wanted.add(itemId);
        for (const item of goal?.plan?.craft?.materials || []) if (Number(item.selfId) > 0) wanted.add(Number(item.selfId));
    }
    // The durable clan goal names its final item; actual material/part needs
    // live on the beneficiary's original equipment plan.
    for (const member of clan.members || []) {
        const plan = member.stats?.equipmentPlan;
        for (const itemId of [plan?.target?.selfId, plan?.next?.itemId]) {
            if (Number(itemId) > 0) wanted.add(Number(itemId));
        }
        for (const item of plan?.materials || []) if (Number(item.selfId) > 0) wanted.add(Number(item.selfId));
    }
    if (Number(clan.level) === 2) wanted.add(ClanRules.LEVEL_REQUIREMENTS[2].itemId);
    for (const itemId of previous) {
        if (wanted.has(itemId)) continue;
        const group = items.get(itemId); group?.delete(id); if (!group?.size) items.delete(itemId);
    }
    for (const itemId of wanted) {
        const group = items.get(itemId) || new Set(); group.add(id); items.set(itemId, group);
    }
    clanItems.set(id, wanted);
}

function boardChanged(change) {
    if (change.reset || change.ready === true && !change.selfIds) {
        for (const id of clanItems.keys()) changed(id, 'board');
    } else {
        for (const itemId of change.selfIds || []) for (const id of items.get(Number(itemId)) || []) changed(id, 'board');
    }
}

function tracks(clanId, selfId) { return clanItems.get(Number(clanId))?.has(Number(selfId)) === true; }
function trackedItems(clanId) { return clanItems.get(Number(clanId)) || []; }

function unwatchRecruitment(clanId) {
    const id = Number(clanId), previous = recruitment.get(id);
    if (!previous) return false;
    for (const classId of previous.classIds) {
        const group = recruitmentClasses.get(classId);
        group?.delete(id); if (!group?.size) recruitmentClasses.delete(classId);
    }
    recruitment.delete(id); committedCandidates?.delete(id);
    return true;
}

// Finite request watch owned by the existing PLAN inputs. Keep only scalars;
// the durable goal and native rows own people, reservations and wallets.
function watchRecruitment(clanId, demand = {}) {
    const id = Number(clanId);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    const classIds = [...new Set((demand.classIds || []).map(Number).filter(value => Number.isSafeInteger(value) && value >= 0))];
    unwatchRecruitment(id);
    if (!classIds.length || ['completed', 'fulfilled', 'cancelled'].includes(demand.status)
        || recruitment.size >= MAX_RECRUITMENT_CLANS) return false;
    const economicRequirements = Array.isArray(demand.requirements) ? demand.requirements : [];
    const request = { classIds, minLevel: Math.max(1, Number(demand.minLevel) || 1),
        maxLevel: Math.min(100, Number(demand.maxLevel) || 100), generation: demand.generation,
        recipeIds: new Set([...(demand.source?.recipes || []), ...economicRequirements.filter(row => row.kind === 'craft').map(row => row.recipeId)]),
        sourceIds: new Set(economicRequirements.filter(row => row.kind === 'spoil').map(row => String(row.spotId))),
        skillIds: demand.skillIds ? new Set(demand.skillIds.map(Number)) : null };
    recruitment.set(id, request);
    for (const classId of classIds) {
        const group = recruitmentClasses.get(classId) || new Set();
        group.add(id); recruitmentClasses.set(classId, group);
    }
    return true;
}

function beginCandidateCommit() { committedCandidates = null; }
function discardCandidateCommit() { committedCandidates = null; }
function candidateCheckpoint() { return committedCandidates ? new Set(committedCandidates) : null; }
function restoreCandidateCheckpoint(checkpoint) { committedCandidates = checkpoint; }
function commitCandidateInputs() {
    const pending = committedCandidates; committedCandidates = null;
    for (const clanId of pending || []) if (recruitment.has(clanId)) changed(clanId, 'recruitment_input');
}

let relevantTree = null, relevantSkills = null;
function relevantSkill(skillId) {
    const Data = invoke('GameServer/DataCache');
    if (relevantTree !== Data.skills || !relevantSkills) {
        relevantTree = Data.skills; relevantSkills = new Set([254, 42, 172, 239]);
        const Rules = invoke('GameServer/Skills/C4SkillRules');
        for (const skill of Data.skills || []) {
            if (skill.template?.passive) continue;
            const rule = Rules.resolve({ selfId: skill.selfId, level: 1 });
            if (rule.effectType === 'buff' || [Rules.HEAL, Rules.HEAL_HOT, Rules.HOT, Rules.HEAL_PERCENT,
                Rules.DAMAGE, Rules.DAMAGE_EFFECT, Rules.DRAIN, Rules.DEATH_LINK, Rules.BLOW].includes(rule.skillType)) relevantSkills.add(Number(skill.selfId));
        }
    }
    return relevantSkills.has(Number(skillId));
}

function watchedCandidate(classId, level, available, clanId) {
    if (!available || !recruitment.size) return false;
    for (const id of recruitmentClasses.get(Number(classId)) || []) {
        const request = recruitment.get(id);
        if ((Number(clanId) === 0 || Number(clanId) === id) && Number(level) >= request.minLevel && Number(level) <= request.maxLevel) return true;
    }
    return false;
}

function candidateInput(classId, level, available, clanId, skillId = null) {
    if (!watchedCandidate(classId, level, available, clanId) || skillId !== null && !relevantSkill(skillId)) return;
    for (const id of recruitmentClasses.get(Number(classId)) || []) {
        const request = recruitment.get(id);
        if (Number(clanId) !== 0 && Number(clanId) !== id || Number(level) < request.minLevel || Number(level) > request.maxLevel
            || skillId !== null && request.skillIds && !request.skillIds.has(Number(skillId))) continue;
        committedCandidates ||= new Set(); committedCandidates.add(id);
    }
}

function recipeInput(classId, level, available, clanId, recipeId) {
    if (!watchedCandidate(classId, level, available, clanId)) return;
    for (const id of recruitmentClasses.get(Number(classId)) || []) {
        const request = recruitment.get(id);
        if ((Number(clanId) === 0 || Number(clanId) === id) && Number(level) >= request.minLevel && Number(level) <= request.maxLevel
            && request.recipeIds.has(Number(recipeId))) { committedCandidates ||= new Set(); committedCandidates.add(id); }
    }
}

function savedCapabilitiesChanged(classId, level, available, clanId, before, after) {
    if (!watchedCandidate(classId, level, available, clanId) || before === after) return;
    const learned = raw => {
        const [skills, source] = JSON.parse(raw);
        return Array.isArray(skills) && !['tree', 'unresolved'].includes(source) ? SavedSkills.unpack(skills) : [];
    };
    // Two compact arrays, one transient native skill-id map. No state/body
    // snapshots retained and no all-pairs comparison of learned records.
    const previous = new Map(learned(before).map(skill => [Number(skill.selfId), JSON.stringify(skill)]));
    for (const skill of learned(after)) {
        const id = Number(skill.selfId);
        if (previous.get(id) !== JSON.stringify(skill)) candidateInput(classId, level, available, clanId, id);
        previous.delete(id);
    }
    for (const id of previous.keys()) candidateInput(classId, level, available, clanId, id);
}

function attach(connection) {
    connection.function('clan_candidate_recipe', (classId, level, available, clanId, recipeId) => {
        recipeInput(classId, level, available, clanId, recipeId); return null;
    });
    connection.function('clan_candidate_input', (classId, level, available, clanId, skillId) => {
        candidateInput(classId, level, available, clanId, skillId); return null;
    });
    connection.function('clan_candidate_watched', (classId, level, available, clanId) => Number(watchedCandidate(classId, level, available, clanId)));
    connection.function('clan_candidate_saved_capability', (classId, level, available, clanId, before, after) => {
        savedCapabilitiesChanged(classId, level, available, clanId, before, after); return null;
    });
    const call = prefix => `SELECT clan_candidate_input(${prefix}.classId,${prefix}.level,${prefix}.joinAvailability,${prefix}.clanId,NULL);`;
    const byId = (id, skillId = 'NULL') => `SELECT clan_candidate_input(classId,level,joinAvailability,clanId,${skillId})
        FROM bot_party_candidate_projection WHERE characterId = ${id};`;
    const recipeById = prefix => `SELECT clan_candidate_recipe(classId,level,joinAvailability,clanId,${prefix}.recipeId)
        FROM bot_party_candidate_projection WHERE characterId=${prefix}.characterId;`;
    connection.exec(`
        CREATE TEMP TRIGGER clan_candidate_added AFTER INSERT ON main.bot_party_candidate_projection BEGIN ${call('NEW')} END;
        CREATE TEMP TRIGGER clan_candidate_removed AFTER DELETE ON main.bot_party_candidate_projection BEGIN ${call('OLD')} END;
        CREATE TEMP TRIGGER clan_candidate_available AFTER UPDATE OF classId,level,clanId,joinAvailability ON main.bot_party_candidate_projection
        WHEN OLD.classId IS NOT NEW.classId OR OLD.level IS NOT NEW.level OR OLD.clanId IS NOT NEW.clanId
            OR OLD.joinAvailability IS NOT NEW.joinAvailability BEGIN ${call('OLD')} ${call('NEW')} END;
        CREATE TEMP TRIGGER clan_candidate_skills_added AFTER INSERT ON main.skills BEGIN ${byId('NEW.characterId', 'NEW.selfId')} END;
        CREATE TEMP TRIGGER clan_candidate_skills_removed AFTER DELETE ON main.skills BEGIN ${byId('OLD.characterId', 'OLD.selfId')} END;
        CREATE TEMP TRIGGER clan_candidate_skills_updated AFTER UPDATE OF level ON main.skills
        WHEN OLD.level IS NOT NEW.level BEGIN ${byId('NEW.characterId', 'NEW.selfId')} END;
        CREATE TEMP TRIGGER clan_candidate_recipe_added AFTER INSERT ON main.character_recipes BEGIN ${recipeById('NEW')} END;
        CREATE TEMP TRIGGER clan_candidate_recipe_removed AFTER DELETE ON main.character_recipes BEGIN ${recipeById('OLD')} END;
        CREATE TEMP TRIGGER clan_candidate_recipe_updated AFTER UPDATE OF recipeId,characterId ON main.character_recipes
        WHEN OLD.recipeId IS NOT NEW.recipeId OR OLD.characterId IS NOT NEW.characterId BEGIN ${recipeById('OLD')} ${recipeById('NEW')} END;
        CREATE TEMP TRIGGER clan_candidate_gear_added AFTER INSERT ON main.items WHEN NEW.equipped <> 0 BEGIN ${byId('NEW.characterId')} END;
        CREATE TEMP TRIGGER clan_candidate_gear_removed AFTER DELETE ON main.items WHEN OLD.equipped <> 0 BEGIN ${byId('OLD.characterId')} END;
        CREATE TEMP TRIGGER clan_candidate_gear_updated AFTER UPDATE OF equipped,enchant,selfId,characterId ON main.items
        WHEN (OLD.equipped <> 0 OR NEW.equipped <> 0) AND (OLD.equipped IS NOT NEW.equipped OR OLD.enchant IS NOT NEW.enchant
            OR OLD.selfId IS NOT NEW.selfId OR OLD.characterId IS NOT NEW.characterId) BEGIN ${byId('OLD.characterId')} ${byId('NEW.characterId')} END;
        CREATE TEMP TRIGGER clan_candidate_reserve_added AFTER INSERT ON main.clan_operation_members
        WHEN NEW.status = 'active' BEGIN ${byId('NEW.characterId')} END;
        CREATE TEMP TRIGGER clan_candidate_reserve_updated AFTER UPDATE OF status ON main.clan_operation_members
        WHEN OLD.status IS NOT NEW.status BEGIN ${byId('NEW.characterId')} END;
        CREATE TEMP TRIGGER clan_candidate_reserve_removed AFTER DELETE ON main.clan_operation_members
        WHEN OLD.status = 'active' BEGIN ${byId('OLD.characterId')} END;
        CREATE TEMP TRIGGER clan_candidate_meeting_added AFTER INSERT ON main.board_trade_participants
        WHEN NEW.meetingId IS NOT NULL BEGIN ${byId('NEW.characterId')} END;
        CREATE TEMP TRIGGER clan_candidate_meeting_updated AFTER UPDATE OF meetingId ON main.board_trade_participants
        WHEN OLD.meetingId IS NOT NEW.meetingId BEGIN ${byId('NEW.characterId')} END;
        CREATE TEMP TRIGGER clan_candidate_meeting_removed AFTER DELETE ON main.board_trade_participants
        WHEN OLD.meetingId IS NOT NULL BEGIN ${byId('OLD.characterId')} END;
        CREATE TEMP TRIGGER clan_candidate_saved_skills AFTER UPDATE OF statsJson ON main.bot_life_state
        WHEN OLD.statsJson IS NOT NEW.statsJson AND EXISTS (
            SELECT 1 FROM bot_party_candidate_projection p WHERE p.characterId=NEW.characterId
            AND clan_candidate_watched(p.classId,p.level,p.joinAvailability,p.clanId)=1)
        BEGIN
            SELECT clan_candidate_saved_capability(p.classId,p.level,p.joinAvailability,p.clanId,
                json_extract(OLD.statsJson,'$.coldCombat.skills','$.coldCombat.skillSource'),
                json_extract(NEW.statsJson,'$.coldCombat.skills','$.coldCombat.skillSource'))
            FROM bot_party_candidate_projection p WHERE p.characterId=NEW.characterId;
        END;
    `);
}

function committedMember(previous = {}, state = {}) {
    const clanId = Number(state.stats?.clanId || 0);
    if (!(clanId > 0)) return;
    const request = recruitment.get(clanId);
    if (request?.sourceIds.size) {
        const relevant = value => (value.stats?.clanHuntBackoffs || []).filter(row => request.sourceIds.has(String(row.spotId)));
        if (JSON.stringify(relevant(previous)) !== JSON.stringify(relevant(state))) changed(clanId, 'recruitment_input');
    }
    leaderSpChanged(state.characterId, previous.sp, state.sp);
    if (Number(state.level) > Number(previous.level)) changed(clanId, 'member_level');
    for (const itemId of trackedItems(clanId)) {
        if ((Number(previous.inventory?.[itemId]?.amount || 0) > 0) !== (Number(state.inventory?.[itemId]?.amount || 0) > 0)) {
            changed(clanId, 'member_item'); break;
        }
    }
}
async function drain(_database, limit = 64) {
    const result = [...dirty].slice(0, limit).map(([clanId, causes]) => ({ clanId, causes: [...causes] }));
    result.forEach(event => dirty.delete(event.clanId));
    return result;
}
async function start(_life, board, onWake) {
    wake = onWake;
    if (unsubscribeBoard) return;
    const token = ++generation;
    unsubscribeBoard = board.subscribeBoardChanges(boardChanged);
    const clans = await invoke('GameServer/Clan/ClanSimulationService').autonomousClanProjection();
    if (token !== generation) return;
    for (const clan of clans) { track(clan); changed(clan.id, 'startup'); }
}

function stop() {
    generation++; unsubscribeBoard?.(); unsubscribeBoard = null; wake = null;
    dirty.clear(); items.clear(); clanItems.clear(); clanLeaders.clear(); leaders.clear();
    recruitment.clear(); recruitmentClasses.clear(); committedCandidates = null;
}

module.exports = { changed, track, untrack, untrackLeader: clanId => forgetLeader(Number(clanId)),
    watchRecruitment, unwatchRecruitment, syncRecruitment, recruitmentCount: () => recruitment.size,
    beginCandidateCommit, commitCandidateInputs, discardCandidateCommit, candidateCheckpoint, restoreCandidateCheckpoint, attach,
    cashLevelGoal, leaderSpChanged, tracks, trackedItems, committedMember, start, stop, drain, pending: () => dirty.size,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
