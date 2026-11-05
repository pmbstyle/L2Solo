const ItemTemplateIndex = require('../Item/ItemTemplateIndex');
const InventorySummary = require('../Bot/Population/InventorySummary');
const { DiagnosticMetricMap } = require('../Bot/Population/DiagnosticMetricMap');
const DiagnosticConfig = require('../Bot/Population/PopulationConfig');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Config = invoke('GameServer/Clan/ClanSimulationConfig');
const Contracts = invoke('GameServer/Clan/ClanSimulationContracts');
const ContributionPolicy = invoke('GameServer/Clan/ClanContributionPolicy');
const GoalPolicy = invoke('GameServer/Clan/ClanGoalPolicy');
const ClanSimulationPolicy = invoke('GameServer/Clan/ClanSimulationPolicy');
const ClanEquipmentService = invoke('GameServer/Clan/ClanEquipmentService');
const ClanGoalCandidateService = invoke('GameServer/Clan/ClanGoalCandidateService');
const ClanContextAssembler = invoke('GameServer/Clan/ClanContextAssembler');
const ClanBrain = invoke('GameServer/Clan/ClanBrain');
const ClanCrestService = invoke('GameServer/Clan/ClanCrestService');
const ClanService = invoke('GameServer/Clan/ClanService');
const DataCache = invoke('GameServer/DataCache');
const ClanEconomy = require('./ClanEconomyContext');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const ReviewEvents = require('./ClanReviewEvents');
const SupplyPolicy = require('./ClanSupplyPolicy');
const SavedStats = require('../Bot/SavedStats');

const metrics = {
    resolves: 0,
    goalsCreated: 0,
    goalsUpdated: 0,
    goalsCompleted: 0,
    activeGoals: 0,
    demandCreated: 0,
    demandRefreshed: 0,
    preparationCycles: 0,
    replans: 0,
    catastrophicFailures: 0,
    levelUps: 0,
    budgetStops: 0,
    planCounts: new DiagnosticMetricMap(),
    reasonCounts: new DiagnosticMetricMap()
};

function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson(value, fallback = {}) {
    if (value && typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (_) {
        return fallback;
    }
}

// Parsed member stats and inventory kept between projections, keyed by the row
// text (also the warehouse gear pass's stats). Clan actions project their clan many times a minute (live x10: ~15
// projections a minute, ~6% of main-thread busy, nearly all of it parsing) and
// ~90% of member texts are the same as in the previous read, so they are parsed
// once. The text is the key, not simulationRevision: some writes change the
// text under the same revision. Readers share these objects across projections
// and never write into them. A member not projected for MEMBER_JSON_IDLE_MS
// (left the clan, clan no longer acting) is forgotten at the next projection.
const MEMBER_JSON_IDLE_MS = 10 * 60 * 1000;
const parsedMemberJson = new Map();
let memberJsonSweepAt = 0;

function memberEntry(characterId, now) {
    let entry = parsedMemberJson.get(characterId);
    if (!entry) parsedMemberJson.set(characterId, entry = {});
    entry.seenAt = now;
    return entry;
}

function memberJson(characterId, field, text, now = Date.now(), parse = raw => parseJson(raw, {})) {
    const entry = memberEntry(characterId, now);
    const cached = entry[field];
    if (cached && cached.text === text) return cached.value;
    const value = parse(text);
    entry[field] = { text, value };
    return value;
}

// A member's one stats object: the saved mind over the saved body
// (SavedStats.merge). The body keeps its parse while only the mind moves.
function memberStats(characterId, statsJson, mindJson, now = Date.now()) {
    const entry = memberEntry(characterId, now);
    const cached = entry.stats;
    if (cached && cached.text === statsJson && cached.mind === mindJson) return cached.value;
    const body = cached && cached.text === statsJson ? cached.body : parseJson(statsJson, {});
    const value = SavedStats.merge(body, mindJson);
    entry.stats = { text: statsJson, mind: mindJson, body, value };
    return value;
}

function forgetIdleMemberJson(now) {
    if (now < memberJsonSweepAt) return;
    memberJsonSweepAt = now + MEMBER_JSON_IDLE_MS;
    for (const [characterId, entry] of parsedMemberJson) {
        if (now - entry.seenAt >= MEMBER_JSON_IDLE_MS) parsedMemberJson.delete(characterId);
    }
}

function record(map, value) {
    if (!DiagnosticConfig.developerDiagnostics) return;
    if (value) map.set(value, (map.get(value) || 0) + 1);
}

function goalComparable(goal) {
    if (!goal) return null;
    const copy = JSON.parse(JSON.stringify(goal));
    delete copy.createdAt;
    delete copy.updatedAt;
    delete copy.progressAt;
    delete copy.progressSnapshot;
    if (copy.plan) delete copy.plan.selectedAt;
    return copy;
}

async function clanProjection(clanId = null) {
    const hasClanId = Number(clanId) > 0;
    const rows = await Database.execute([`
        SELECT simulated.clanId, simulated.stateJson,
               clans.name, clans.level, clans.leaderId,
               members.id AS characterId, members.name AS memberName,
               members.title AS memberTitle, members.classId, members.level AS memberLevel, members.clanId AS memberClanId,
               life.accountName, life.activity, life.phase, life.adena, life.currentRegion, life.spotId,
               life.level AS lifeLevel,
               COALESCE(life.locX, members.locX) AS locX, COALESCE(life.locY, members.locY) AS locY,
               COALESCE(life.locZ, members.locZ) AS locZ,
               life.partyId,
               life.simulationRevision, life.inventorySummary, life.statsJson, life.mindJson, personas.traitsJson, personas.primaryDrive, personas.archetype
        FROM clan_simulation_clans simulated
        JOIN clans ON clans.id = simulated.clanId
        JOIN characters members ON members.clanId = simulated.clanId
        LEFT JOIN bot_life_state life ON life.characterId = members.id
        LEFT JOIN bot_personas personas ON personas.characterId = members.id
        ${hasClanId ? 'WHERE simulated.clanId = ?' : ''}
        ORDER BY simulated.clanId ASC, members.id ASC
    `, hasClanId ? [Number(clanId)] : []], hasClanId ? 'clan-goal:projection-one' : 'clan-goal:projection');
    const byId = new Map();
    const now = Date.now();
    forgetIdleMemberJson(now);
    rows.forEach((row) => {
        const clanId = number(row.clanId);
        if (!byId.has(clanId)) {
            byId.set(clanId, {
                id: clanId,
                name: String(row.name || ''),
                level: number(row.level),
                leaderId: number(row.leaderId),
                state: parseJson(row.stateJson, {}),
                physicalMemberCount: 0,
                members: []
            });
        }
        const member = {
            characterId: number(row.characterId),
            id: number(row.characterId),
            name: String(row.memberName || ''),
            title: String(row.memberTitle || ''),
            classId: number(row.classId, -1),
            loc: { locX: number(row.locX), locY: number(row.locY), locZ: number(row.locZ) },
            level: number(row.lifeLevel, number(row.memberLevel)),
            clanId: number(row.memberClanId),
            accountName: String(row.accountName || ''),
            activity: String(row.activity || ''),
            phase: String(row.phase || ''),
            currentRegion: String(row.currentRegion || ''),
            spotId: row.spotId || null,
            partyId: row.partyId || null,
            adena: number(row.adena),
            simulationRevision: number(row.simulationRevision),
            inventory: memberJson(number(row.characterId), 'inventory', row.inventorySummary, now, InventorySummary.read),
            stats: memberStats(number(row.characterId), row.statsJson, row.mindJson, now),
            persona: { primaryDrive: row.primaryDrive, archetype: row.archetype, traits: parseJson(row.traitsJson, {}) }
        };
        byId.get(clanId).physicalMemberCount++;
        if (!ClanSimulationPolicy.isStaticService(member)) byId.get(clanId).members.push(member);
    });
    const projection = [...byId.values()];
    for (const clan of projection) SupplyPolicy.publish(clan);
    // Level-only startup rows are not the final native demand projection.
    if (!hasClanId) SupplyPolicy.projectionReady();
    return projection;
}

async function clanProjectionById(clanId) {
    const clans = await clanProjection(clanId);
    return clans[0] || null;
}

function bloodMarkSourceLevel() {
    return number(ItemTemplateIndex.findFinite(DataCache.npcs, Config.bloodMarkSourceNpcId)
        ?.template?.level, 60);
}

function levelingProgress(members = [], count = Config.operationMinMembers) {
    const requiredMembers = Math.max(1, number(count, Config.operationMinMembers));
    const levels = members
        .filter(GoalPolicy.operationAvailable)
        .map((member) => number(member.level))
        .filter((level) => level > 0)
        .sort((left, right) => right - left)
        .slice(0, requiredMembers);
    // The last required fighter is the gating member for an operation. An
    // average could mark the preparation goal complete while one member is
    // still below the source threshold, which would stop future replans.
    return levels.length >= requiredMembers ? Math.min(...levels) : 0;
}

async function contextFor(clan) {
    const level = number(clan.level);
    const members = clan.members || [];
    if (level <= 1) {
        const summary = (await Database.fetchClanContributionSummary(clan.id, level))[0] || { amount: 0 };
        const warehouseRows = await Database.fetchClanWarehouseItems(clan.id);
        const warehouse = warehouseRows
            .filter((item) => Number(item.selfId) === 57)
            .reduce((sum, item) => sum + number(item.amount), 0);
        return {
            required: ContributionPolicy.scaledAdenaRequirement(level),
            progress: number(summary.amount),
            warehouse,
            itemId: 0,
            itemName: '',
            partyReady: false,
            economy: ClanEconomy.forClan(clan, { warehouse: warehouseRows }),
            members
        };
    }
    if (level >= 3) return { required: 1, progress: 1, warehouse: 1, itemId: Config.bloodMarkItemId, itemName: 'Blood Mark', members };

    const warehouseRows = await Database.fetchClanWarehouseItems(clan.id);
    const stock = warehouseRows
        .filter((item) => Number(item.selfId) === Number(Config.bloodMarkItemId))
        .reduce((sum, item) => sum + Math.max(0, number(item.amount) - number(item.reservedAmount)), 0);
    const offer = stock < 1 ? MarketOpportunity.bestOffer(Config.bloodMarkItemId, { budget: Infinity }) : null;
    const halls = await Database.fetchClanHallAuctions();
    const economy = ClanEconomy.forClan(clan, { warehouse: warehouseRows, halls, proofOffer: offer });
    const affordable = offer && Number(offer.price) <= economy.budgetFor('level', Config.bloodMarkItemId);
    // Purchasing the real C4 proof competes in the same purse as gear and a
    // residence. An unavailable/unfunded offer keeps the native farm route.
    if (affordable) return { required: 1, progress: stock, warehouse: stock,
        itemId: Config.bloodMarkItemId, itemName: 'Proof of Blood', members,
        marketOffer: true, marketOfferPrice: Number(offer.price), partyReady: false,
        economy, offer };
    const demands = await Database.fetchClanMarketDemands({ clanId: clan.id, itemId: Config.bloodMarkItemId, status: 'open', limit: 4 });
    const latestDemand = demands.sort((left, right) => number(right.updatedAt) - number(left.updatedAt))[0] || null;
    const sourceLevel = bloodMarkSourceLevel();
    const targetLevel = GoalPolicy.operationLevelThreshold(sourceLevel);
    const readyMembers = GoalPolicy.levelReadyMembers(members, sourceLevel);
    if (stock < 1 && readyMembers.length < Config.operationMinMembers) {
        return {
            required: targetLevel,
            progress: levelingProgress(members),
            warehouse: stock,
            itemId: Config.bloodMarkItemId,
            itemName: 'Blood Mark',
            sourceNpcId: Config.bloodMarkSourceNpcId,
            sourceLevel,
            levelingTargetLevel: targetLevel,
            levelingProgress: levelingProgress(members),
            marketDemand: latestDemand,
            economy,
            partyReady: false,
            craftReady: false,
            members
        };
    }
    return {
        required: 1,
        progress: stock,
        warehouse: stock,
        itemId: Config.bloodMarkItemId,
        itemName: 'Blood Mark',
        sourceNpcId: Config.bloodMarkSourceNpcId,
        sourceLevel,
        marketOffer: false,
        marketOfferPrice: 0,
        marketDemandFresh: false,
        marketDemand: latestDemand,
        economy,
        // Missing support inside the clan is repaired by ClanPartyService.
        // It must not keep a level-ready Blood Mark goal in prepare forever.
        partyReady: true,
        craftReady: false,
        members,
        operationMembers: readyMembers
    };
}

async function cancelLegacyBloodMarkDemand(clan, context) {
    const demand = context?.marketDemand;
    if (!demand) return null;
    const cancelled = await Database.upsertClanMarketDemand({
        clanId: clan.id,
        itemId: Config.bloodMarkItemId,
        amount: Math.max(1, number(demand.amount, 1)),
        maxPrice: Math.max(1, number(demand.maxPrice, Config.bloodMarkMaxPrice)),
        goalKey: demand.goalKey,
        status: 'cancelled'
    });
    await LifeState.syncClanMarketDemandSignal({
        clanId: clan.id,
        itemId: Config.bloodMarkItemId,
        amount: Math.max(1, number(demand.amount, 1)),
        maxPrice: Math.max(1, number(demand.maxPrice, Config.bloodMarkMaxPrice)),
        goalKey: demand.goalKey,
        status: 'cancelled'
    });
    return cancelled;
}

async function resolveClan(clan, options = {}) {
    ReviewEvents.track(clan);
    try {
        const strategic = await require('./ClanStrategyService').review(clan, options);
        if (strategic.pending || strategic.ok === false) return strategic;
        const strategy = require('./ClanStrategyPolicy').active(clan);
        if (!strategy && clan?.state?.goal?.type === 'strategy') {
            const cleared = await Database.updateAutonomousClanGoal({ clanId: clan.id, goal: null,
                expectedUpdatedAt: number(clan.state.updatedAt), eventType: null });
            if (!cleared.ok) return cleared;
            clan.state = cleared.state;
        }
        if (strategic.managed && ['treasury', 'recruit', 'clan_hall', 'maintain'].includes(strategy?.objective)) {
            const goal = require('./ClanStrategyService').waitingGoal(strategy);
            const saved = await Database.updateAutonomousClanGoal({ clanId: clan.id, goal,
                expectedUpdatedAt: number(clan.state?.updatedAt), eventType: null });
            return { ...saved, changed: false, goal, strategy };
        }
        const result = await resolveClanInternal(clan, options);
        if (result.goal && clan) ReviewEvents.track({ ...clan, state: { ...clan.state,
            [result.ownerSection || 'goal']: result.goal,
            recruitmentDemand: result.recruitmentDemand === undefined ? clan.state?.recruitmentDemand : result.recruitmentDemand,
            recruitmentScan: result.recruitmentScan === undefined ? clan.state?.recruitmentScan : result.recruitmentScan } });
        return result;
    }
    catch (error) {
        if (error.code !== 'clan_planning_deferred') throw error;
        return { ok: true, skipped: true, retryable: true, reason: 'clan_planning_deferred' };
    }
}

async function resolveClanInternal(clan, options = {}) {
    if (!clan) return { ok: true, skipped: true, reason: 'target_not_autonomous' };
    const stateGoal = clan.state?.goal || null;
    if (String(stateGoal?.controlledBy || '') === 'player'
        && stateGoal?.status !== 'completed') {
        return {
            ok: true,
            clanId: clan.id,
            level: number(clan.level),
            changed: false,
            skipped: true,
            reason: 'player_order_active',
            goal: stateGoal
        };
    }
    // A completed player order is only a temporary override. The autonomous
    // planner starts with a clean slate instead of treating that order as its
    // own previous goal.
    const automaticPrevious = String(stateGoal?.controlledBy || '') === 'player' ? null : stateGoal;
    const strategy = require('./ClanStrategyPolicy').active(clan);
    if (number(clan.level) === 3 && String(clan.state?.mode || '') === 'autonomous'
        && (!strategy || strategy.objective === 'advance_clan' || stateGoal?.plan?.kind === 'alliance_trial')) {
        const trial = await Database.resolveBotClanAlliance(clan.id);
        if (trial.advanced?.ok) {
            await ClanService.reload();
            return { ...trial, clanId: clan.id, changed: true, level: 4 };
        }
        if (trial.state?.stage === 'running') {
            const goal = { type: 'level', status: 'executing', target: { level: 4 }, required: 30,
                progress: Math.min(30, trial.state.elapsedMs / require('../World/GameTime').GAME_MINUTE_MS), assignedMemberIds: trial.state.members,
                plan: { kind: 'alliance_trial', reasonCode: 'clan_alliance_trial' }, updatedAt: Date.now() };
            const saved = await Database.updateAutonomousClanGoal({ clanId: clan.id, goal,
                eventType: 'alliance_trial_started', reasonCode: 'clan_alliance_trial' });
            return { ...saved, clanId: clan.id, changed: true, goal };
        }
    }
    if (number(clan.level) >= 3 || strategy && ['equip_roster', 'raid_preparation'].includes(strategy.objective)) {
        const previous = automaticPrevious?.type === 'equipment' ? automaticPrevious : clan.state?.productionGoal || null;
        const candidateSnapshot = await ClanGoalCandidateService.snapshotFor(clan, previous, options);
        await ClanEquipmentService.validatePlanning(clan, candidateSnapshot.planning);
        const brain = !strategy && candidateSnapshot.decisionNeeded
            ? ClanBrain.choose(clan, candidateSnapshot, options) : null;
        if (brain?.pending) {
            return {
                ok: true,
                clanId: clan.id,
                level: number(clan.level),
                changed: false,
                skipped: true,
                pending: true,
                reason: brain.reasonCode,
                decisionKey: brain.key,
                context: {
                    candidateCount: candidateSnapshot.candidates.length,
                    cacheHit: candidateSnapshot.cacheHit
                }
            };
        }
        const equipment = await ClanEquipmentService.resolveClan(clan, previous, {
            ...options,
            planning: candidateSnapshot.planning,
            selectedCandidate: brain?.source === 'llm' ? brain.candidate : null,
            candidateIds: candidateSnapshot.candidates.map(candidate => candidate.id)
        });
        if (equipment.skipped && !equipment.completed) {
            if (strategy && ['equip_roster', 'raid_preparation'].includes(strategy.objective)
                && equipment.reason === 'no_equipment_debt') {
                const blocked = await require('./ClanStrategyService').block(clan);
                return { ...blocked, retryable: true, reason: 'clan_planning_deferred' };
            }
            if (equipment.recruitmentScan) {
                const section = equipment.ownerSection || 'goal';
                const saved = await Database.updateAutonomousClanGoal({ clanId: clan.id,
                    goal: clan.state?.[section] || null, ownerSection: section,
                    expectedUpdatedAt: number(clan.state?.updatedAt), recruitmentDemand: null,
                    recruitmentScan: equipment.recruitmentScan, eventType: null });
                if (!saved.ok) return saved;
            }
            return {
                ok: true,
                clanId: clan.id,
                level: number(clan.level),
                changed: false,
                skipped: true,
                reason: equipment.reason,
                retryable: !!equipment.continuation,
                ...(equipment.continuation ? { reason: 'clan_planning_deferred' } : {}),
                ownerSection: equipment.ownerSection,
                recruitmentScan: equipment.recruitmentScan,
                recruitmentDemand: equipment.recruitmentDemand,
                goal: previous,
                context: { members: clan.members || [] }
            };
        }
        if (!equipment.ok) {
            return equipment;
        }
        const goal = equipment.goal;
        const economy = candidateSnapshot.planning.economy;
        if (economy && !equipment.persistedGoal) goal.economy = { focus: economy.network.focus, dormant: economy.network.dormant,
            moneyPrice: economy.moneyPrice, incomePerHour: economy.incomePerHour };
        const changed = JSON.stringify(goalComparable(previous)) !== JSON.stringify(goalComparable(goal));
        let persisted = { ok: true, goal: equipment.persistedGoal ? goal : previous };
        const metadataChanged = equipment.recruitmentScan !== undefined && JSON.stringify(clan.state?.recruitmentScan || null)
            !== JSON.stringify(equipment.recruitmentScan) || !!clan.state?.recruitmentDemand
            || Number(previous?.progressAt) !== Number(goal.progressAt)
            || JSON.stringify(previous?.progressSnapshot) !== JSON.stringify(goal.progressSnapshot);
        if (!equipment.persistedGoal && (changed || metadataChanged)) {
            const eventType = !changed ? null : !previous ? 'equipment_goal_created'
                : equipment.completed ? 'equipment_goal_completed'
                : equipment.previousFulfilled ? 'equipment_goal_advanced'
                    : 'equipment_goal_updated';
            persisted = await Database.updateAutonomousClanGoal({
                clanId: clan.id,
                goal,
                ownerSection: equipment.ownerSection || 'goal',
                recruitmentDemand: equipment.recruitmentDemand,
                recruitmentScan: equipment.recruitmentScan,
                // The adopted production goal, or a copy of the same goal a
                // promotion before this fix left in the production section.
                supersededProductionGoalKey: previous && (previous === clan.state?.productionGoal
                    || (previous.goalKey && previous.goalKey === clan.state?.productionGoal?.goalKey)) ? previous.goalKey : null,
                expectedUpdatedAt: number(equipment.expectedUpdatedAt ?? clan.state?.updatedAt) || null,
                eventType,
                reasonCode: goal.plan?.reasonCode || ''
            });
            if (persisted.ok) {
                if (!previous) DiagnosticConfig.developerDiagnostics && (metrics.goalsCreated += 1);
                else DiagnosticConfig.developerDiagnostics && (metrics.goalsUpdated += 1);
            }
        }
        if (persisted.ok && brain?.source === 'llm') {
            await Database.recordClanGoalEvent({
                clanId: clan.id,
                eventType: changed ? 'llm_goal_selected' : 'llm_goal_retained',
                goalType: goal.type,
                plan: goal.plan?.kind || '',
                reasonCode: brain.reasonCode || candidateSnapshot.decisionReason || 'llm_goal_selected',
                payload: {
                    candidateId: brain.candidateId,
                    route: brain.route,
                    target: goal.target,
                    stall: candidateSnapshot.stall || null,
                    context: brain.contextTelemetry || null,
                    usage: brain.usage || null
                }
            });
        }
        record(metrics.planCounts, goal.plan?.kind);
        DiagnosticConfig.developerDiagnostics && (metrics.activeGoals += goal.status !== 'completed' ? 1 : 0);
        return {
            ok: !!persisted.ok,
            clanId: clan.id,
            level: number(clan.level),
            changed,
            goal: persisted.goal || goal,
            ownerSection: equipment.ownerSection || 'goal',
            recruitmentDemand: equipment.recruitmentDemand,
            recruitmentScan: equipment.recruitmentScan,
            retryable: equipment.retryable || equipment.continuation || false,
            context: {
                members: clan.members || [],
                plans: equipment.plans,
                candidateCount: candidateSnapshot.candidates.length,
                candidateCacheHit: candidateSnapshot.cacheHit,
                stall: candidateSnapshot.stall || null,
                partyReform: equipment.partyReform || null,
                decisionSource: brain?.source || 'deterministic',
                decisionReason: brain?.reasonCode || candidateSnapshot.decisionReason
            },
            assignment: equipment.assignment,
            reason: persisted.code || (equipment.retryable || equipment.continuation ? 'clan_planning_deferred' : null)
        };
    }
    const context = await contextFor(clan);
    const cancelledDemand = context.marketOffer ? null : await cancelLegacyBloodMarkDemand(clan, context);
    const previous = automaticPrevious;
    if (number(clan.level) === 2 && number(context.progress) >= number(context.required)) {
        const advanced = await Database.advanceAutonomousClanLevel({
            clanId: clan.id,
            fromLevel: 2,
            toLevel: 3,
            requiredAmount: 1,
            requiredItemId: Config.bloodMarkItemId,
            requiredItemAmount: 1
        });
        if (advanced.ok) {
            DiagnosticConfig.developerDiagnostics && (metrics.levelUps += 1);
            DiagnosticConfig.developerDiagnostics && (metrics.goalsCompleted += previous?.status === 'completed' ? 0 : 1);
            record(metrics.reasonCounts, Contracts.REASON_CODES.CONTRIBUTION_LEVEL_UP);
            await ClanCrestService.ensureAutonomousCrest(clan.id);
            await ClanService.reload();
            return {
                ok: true,
                clanId: clan.id,
                level: 3,
                changed: true,
                goal: null,
                advanced,
                context,
                reason: advanced.code || null
            };
        }
        if (advanced.code !== 'level_already_advanced') {
            return { ok: false, clanId: clan.id, level: 2, changed: false, goal: previous, advanced, context, reason: advanced.code };
        }
        return {
            ok: true,
            clanId: clan.id,
            level: number(advanced.level, 3),
            changed: false,
            skipped: true,
            goal: previous,
            advanced,
            context,
            reason: advanced.code
        };
    }
    let goal = GoalPolicy.buildGoal(clan, context, previous, {
        timestamp: Date.now(),
        failureThreshold: Config.catastrophicFailureThreshold
    });
    let demand = null;
    if (context.marketOffer) {
        demand = await Database.upsertClanMarketDemand({ clanId: clan.id, itemId: Config.bloodMarkItemId,
            amount: 1, maxPrice: context.marketOfferPrice, goalKey: `${clan.id}:level-2:${Config.bloodMarkItemId}`, status: 'open' });
        await LifeState.syncClanMarketDemandSignal({ clanId: clan.id, itemId: Config.bloodMarkItemId,
            amount: 1, maxPrice: context.marketOfferPrice, goalKey: `${clan.id}:level-2:${Config.bloodMarkItemId}`, status: 'open' });
    }
    if (goal.type === 'item' && demand?.created && !context.marketOffer) {
        context.marketDemandFresh = true;
        goal = GoalPolicy.buildGoal(clan, context, previous, {
            timestamp: Date.now(),
            failureThreshold: Config.catastrophicFailureThreshold
        });
    }

    if (context.economy) {
        goal.economy = { focus: context.economy.network.focus, dormant: context.economy.network.dormant,
            moneyPrice: context.economy.moneyPrice, incomePerHour: context.economy.incomePerHour };
        if (context.marketOffer) { goal.plan.maxPrice = context.marketOfferPrice; goal.budget = context.marketOfferPrice; }
    }
    const changed = JSON.stringify(goalComparable(previous)) !== JSON.stringify(goalComparable(goal));
    let persisted = { ok: true, goal: previous };
    if (changed) {
        const eventType = !previous ? 'goal_created'
            : goal.status === 'completed' ? 'goal_completed'
                : previous.plan?.kind !== goal.plan?.kind ? 'goal_plan_selected' : 'goal_progress';
        persisted = await Database.updateAutonomousClanGoal({
            clanId: clan.id,
            goal,
            expectedUpdatedAt: number(clan.state?.updatedAt) || null,
            eventType,
            reasonCode: goal.plan?.reasonCode || ''
        });
        if (persisted.ok) {
            if (!previous) DiagnosticConfig.developerDiagnostics && (metrics.goalsCreated += 1);
            else DiagnosticConfig.developerDiagnostics && (metrics.goalsUpdated += 1);
            if (goal.status === 'completed' && previous?.status !== 'completed') DiagnosticConfig.developerDiagnostics && (metrics.goalsCompleted += 1);
        }
    }
    if (goal.status === 'completed') record(metrics.reasonCounts, Contracts.REASON_CODES.GOAL_COMPLETED);
    else record(metrics.reasonCounts, goal.plan?.reasonCode);
    record(metrics.planCounts, goal.plan?.kind);
    if (goal.status === 'preparing') DiagnosticConfig.developerDiagnostics && (metrics.preparationCycles += 1);
    if (goal.status !== 'completed') DiagnosticConfig.developerDiagnostics && (metrics.activeGoals += 1);
    return {
        ok: !!persisted.ok,
        clanId: clan.id,
        level: number(clan.level),
        changed,
        goal: persisted.goal || goal,
        demand,
        cancelledDemand,
        context,
        reason: persisted.code || null
    };
}

async function recordCatastrophicFailure(clanId, reasonCode = Contracts.REASON_CODES.PARTY_CATASTROPHIC_FAILURE) {
    const clans = await clanProjection();
    const clan = clans.find((entry) => number(entry.id) === number(clanId));
    if (!clan?.state?.goal) return { ok: false, code: 'goal_missing' };
    if (String(clan.state.goal.controlledBy || '') === 'player') {
        return { ok: true, skipped: true, code: 'player_order_controls_replan', goal: clan.state.goal };
    }
    const context = await contextFor(clan);
    const next = GoalPolicy.replanGoal(clan.state.goal, {
        ...context,
        level: number(clan.level),
        members: clan.members
    }, reasonCode, {
        failureThreshold: Config.catastrophicFailureThreshold
    });
    const result = await Database.updateAutonomousClanGoal({
        clanId: clan.id,
        goal: next,
        expectedUpdatedAt: number(clan.state.updatedAt) || null,
        eventType: 'goal_replanned',
        reasonCode
    });
    if (result.ok) {
        DiagnosticConfig.developerDiagnostics && (metrics.catastrophicFailures += 1);
        DiagnosticConfig.developerDiagnostics && (metrics.replans += 1);
        record(metrics.reasonCounts, Contracts.REASON_CODES.GOAL_REPLANNED);
    }
    return { ...result, goal: next };
}

const ClanGoalService = {
    config: Config,
    policy: GoalPolicy,
    clanProjection,
    clanProjectionById,
    memberStats,
    resolveClan,
    recordCatastrophicFailure,

    resolveBatch(limit = Config.resolveBatchSize, options = {}) {
        if (!Config.enabled) return Promise.resolve({ attempted: 0, changed: 0, budgetStopped: false });
        const deadlineAt = Date.now() + Math.max(1, number(options.budgetMs, Config.resolveBudgetMs));
        return clanProjection().then(async (clans) => {
            const summary = { attempted: 0, changed: 0, completed: 0, budgetStopped: false };
            for (const clan of clans.slice(0, Math.max(1, number(limit, Config.resolveBatchSize)))) {
                if (Date.now() >= deadlineAt) {
                    summary.budgetStopped = true;
                    DiagnosticConfig.developerDiagnostics && (metrics.budgetStops += 1);
                    break;
                }
                const result = await resolveClan(clan, { deadlineAt });
                summary.attempted += 1;
                summary.changed += result.changed ? 1 : 0;
                summary.completed += result.goal?.status === 'completed' ? 1 : 0;
            }
            DiagnosticConfig.developerDiagnostics && (metrics.resolves += summary.attempted);
            return summary;
        });
    },

    metrics() {
        if (!DiagnosticConfig.developerDiagnostics) return { enabled: false };
        return {
            resolves: metrics.resolves,
            goalsCreated: metrics.goalsCreated,
            goalsUpdated: metrics.goalsUpdated,
            goalsCompleted: metrics.goalsCompleted,
            activeGoals: metrics.activeGoals,
            demandCreated: metrics.demandCreated,
            demandRefreshed: metrics.demandRefreshed,
            preparationCycles: metrics.preparationCycles,
            replans: metrics.replans,
            catastrophicFailures: metrics.catastrophicFailures,
            levelUps: metrics.levelUps,
            budgetStops: metrics.budgetStops,
            planCounts: Object.fromEntries(metrics.planCounts.entries()),
            reasonCounts: Object.fromEntries(metrics.reasonCounts.entries()),
            equipment: ClanEquipmentService.metrics(),
            candidates: ClanGoalCandidateService.metrics(),
            context: ClanContextAssembler.metrics(),
            llm: ClanBrain.metrics()
        };
    },

    resetMetrics() {
        Object.keys(metrics).forEach((key) => {
            if (metrics[key] instanceof Map) metrics[key].clear();
            else metrics[key] = 0;
        });
    }
};

module.exports = ClanGoalService;
