const assert = require('assert');

require('../src/Global');

const CandidateService = invoke('GameServer/Clan/ClanGoalCandidateService');
const ContextAssembler = invoke('GameServer/Clan/ClanContextAssembler');
const ClanBrain = invoke('GameServer/Clan/ClanBrain');
const ClanGoalService = invoke('GameServer/Clan/ClanGoalService');
const EquipmentService = invoke('GameServer/Clan/ClanEquipmentService');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const Database = invoke('Database');

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    };
}

function plan(itemId, name, status = 'active', strategy = 'direct_drop') {
    return {
        status,
        strategy,
        grade: 'd',
        expectedKills: 20,
        target: { selfId: itemId, name, slot: 7 },
        next: { spotId: 'test-spot', npcId: 20001, npcName: 'Test Mob' }
    };
}

function candidate(id, memberId, itemId, route = 'farm') {
    return {
        id,
        type: 'equipment',
        memberId,
        itemId,
        slot: 7,
        beneficiary: { id: memberId, name: `Member${memberId}`, level: 40, role: 'dps' },
        item: { id: itemId, name: `Item${itemId}`, grade: 'd', slot: 7 },
        assessment: { serverRank: memberId, priority: 100 - memberId, current: false, reason: '' },
        route: {
            kind: route,
            available: true,
            status: 'active',
            expectedKills: 20,
            partyNeed: 'solo_ok',
            source: { spotId: 'test-spot', npcId: 20001, npcName: 'Test Mob' },
            market: null
        },
        blockers: []
    };
}

async function main() {
    const originalPlanningForClan = EquipmentService.planningForClan;
    const originalResolveEquipment = EquipmentService.resolveClan;
    const originalSnapshotFor = CandidateService.snapshotFor;
    const originalUpdateGoal = Database.updateAutonomousClanGoal;
    const originalRecordGoalEvent = Database.recordClanGoalEvent;
    try {
        CandidateService.reset();
        const clan = {
            id: 77,
            level: 3,
            leaderId: 701,
            state: { updatedAt: 1, goal: null },
            members: [
                { id: 701, name: 'Leader', classId: 0, level: 40, phase: 'cold', simulationRevision: 1 },
                { id: 702, name: 'Healer', classId: 15, level: 40, phase: 'cold', simulationRevision: 1 }
            ]
        };
        const plans = new Map([
            [701, plan(1001, 'Leader Armor')],
            [702, plan(1002, 'Healer Armor')]
        ]);
        let planningCalls = 0;
        EquipmentService.planningForClan = async () => {
            planningCalls += 1;
            return {
                spots: [],
                warehouseRows: [],
                plans,
                selection: { member: clan.members[1], plan: plans.get(702), priority: -1 },
                previousFulfilled: false
            };
        };

        const firstSnapshot = await CandidateService.snapshotFor(clan, null, { limit: 1 });
        assert.strictEqual(firstSnapshot.candidates.length, 1);
        assert.strictEqual(firstSnapshot.candidates[0].memberId, 702,
            'the deterministic fallback must remain in a truncated candidate shortlist');
        assert.strictEqual(firstSnapshot.deterministicCandidateId, firstSnapshot.candidates[0].id);
        const cachedSnapshot = await CandidateService.snapshotFor(clan, null, { limit: 1 });
        assert.strictEqual(cachedSnapshot.cacheHit, true);
        assert.strictEqual(planningCalls, 1, 'one clan snapshot should reuse its expensive planning pass');
        const equipmentChanged = JSON.parse(JSON.stringify(clan));
        equipmentChanged.members[0].inventory = {
            1001: { selfId: 1001, slot: 7, rank: 'd', equipped: true }
        };
        assert.notStrictEqual(
            CandidateService.fingerprint(equipmentChanged, null),
            CandidateService.fingerprint(clan, null),
            'equipping a completed goal item must invalidate the clan planning cache immediately'
        );

        CandidateService.reset();
        const stalledAt = Date.now() - 20 * 60 * 1000;
        const stalledGoal = {
            type: 'equipment',
            status: 'executing',
            goalKey: 'clan-equipment:77:701:1001:7',
            target: { memberId: 701, itemId: 1001, slot: 7 },
            assignedMemberIds: [701, 702],
            createdAt: stalledAt,
            updatedAt: stalledAt
        };
        const requiredPlan = {
            ...plans.get(701),
            partyNeed: 'required',
            requiresParty: true
        };
        plans.set(701, requiredPlan);
        clan.state.goal = stalledGoal;
        clan.state.updatedAt = stalledAt;
        clan.members.forEach((member) => {
            member.partyId = `old-party-${member.id}`;
            member.spotId = 'old-spot';
            member.stats = {
                clanPartyObjective: {
                    status: 'open',
                    clanGoalKey: stalledGoal.goalKey,
                    objectiveKey: 'direct_drop:test-spot:20001',
                    requestedAt: stalledAt,
                    lastMatchedAt: null
                }
            };
        });
        EquipmentService.planningForClan = async () => ({
            spots: [],
            warehouseRows: [],
            plans,
            selection: { member: clan.members[0], plan: requiredPlan, priority: 1 },
            previousFulfilled: false
        });
        const stalledSnapshot = await CandidateService.snapshotFor(clan, stalledGoal, {
            now: Date.now(),
            partyStallMs: 15 * 60 * 1000,
            hardStallMs: 6 * 60 * 60 * 1000
        });
        assert.strictEqual(stalledSnapshot.decisionReason, 'goal_party_stalled');
        assert.strictEqual(stalledSnapshot.decisionNeeded, true,
            'a clan party stuck on unrelated routes must be returned to the LLM');
        assert.strictEqual(stalledSnapshot.stall.conflictingPartyCount, 2);
        assert.strictEqual(stalledSnapshot.candidates.length, 1,
            'a stalled current route must leave only executable replacement candidates');
        assert.strictEqual(stalledSnapshot.candidates[0].assessment.current, false);

        CandidateService.reset();
        clan.members[0].spotId = 'test-spot';
        const progressingSnapshot = await CandidateService.snapshotFor(clan, stalledGoal, {
            now: Date.now(),
            partyStallMs: 15 * 60 * 1000,
            hardStallMs: 6 * 60 * 60 * 1000
        });
        assert.strictEqual(progressingSnapshot.decisionReason, 'goal_progressing',
            'an active party at the objective spot is productive, not stalled');

        clan.state.goal = null;
        clan.state.updatedAt = 1;
        clan.members.forEach((member) => {
            member.partyId = null;
            member.spotId = null;
            member.stats = {};
        });
        plans.set(701, plan(1001, 'Leader Armor'));

        const history = ContextAssembler.historyFromEvents([
            {
                eventType: 'equipment_goal_updated',
                goalType: 'equipment',
                plan: 'farm',
                reasonCode: 'route_recovered',
                payloadJson: JSON.stringify({
                    type: 'equipment',
                    target: { memberId: 701, itemId: 1001, itemName: 'Leader Armor' },
                    progress: 0,
                    required: 1
                }),
                occurredAt: 300
            },
            {
                eventType: 'equipment_goal_failed',
                goalType: 'equipment',
                plan: 'market',
                reasonCode: 'market_no_offer',
                payloadJson: JSON.stringify({
                    type: 'equipment',
                    target: { memberId: 702, itemId: 1002, itemName: 'Healer Armor' },
                    progress: 0,
                    required: 1
                }),
                occurredAt: 200
            }
        ], {
            type: 'equipment',
            target: { memberId: 701, itemId: 1001 },
            status: 'executing'
        });
        assert.strictEqual(history.currentEpisode.id, 'equipment:701:1001:0');
        assert.strictEqual(history.previousGoals[0].outcome, 'failed');
        assert.deepStrictEqual(ContextAssembler.learnedConstraints([
            { eventType: 'market_failed', plan: 'market', reasonCode: 'market_no_offer', occurredAt: 100 },
            { eventType: 'market_failed', plan: 'market', reasonCode: 'market_no_offer', occurredAt: 200 },
            { eventType: 'llm_goal_selected', plan: 'farm', reasonCode: 'better_value', occurredAt: 250 },
            { eventType: 'goal_completed', plan: 'farm', reasonCode: 'goal_completed', occurredAt: 300 }
        ]), [{ plan: 'market', reason: 'market_no_offer', count: 2, latestAt: 200 }]);

        ClanBrain.reset();
        BotInferenceBudget.reset();
        OpenRouterGateway.resetCircuit();
        const candidates = [
            candidate('equipment:77:701:1001:7', 701, 1001),
            candidate('equipment:77:702:1002:7', 702, 1002)
        ];
        const brainSnapshot = {
            key: 'clan-77-decision-1',
            candidates,
            deterministicCandidateId: candidates[0].id,
            decisionNeeded: true,
            decisionReason: 'goal_blocked'
        };
        const assembled = {
            context: {
                decisionReason: 'goal_blocked',
                clan: { id: 77, level: 3, members: 2 },
                currentGoal: null,
                history: { currentEpisode: null, previousGoals: [], learnedConstraints: [], recentMeaningfulEvents: [] },
                candidates,
                deterministicFallbackId: candidates[0].id
            },
            estimatedTokens: 420,
            buildMs: 2,
            truncated: false,
            historyEventCount: 3
        };
        const testConfig = {
            enabled: true,
            apiKey: 'test-key',
            apiUrl: OpenRouterGateway.OPENROUTER_URL,
            model: 'openai/gpt-5.6-luna',
            reasoningEffort: 'low',
            maxTokens: ClanBrain.MAX_COMPLETION_TOKENS,
            timeoutMs: 1000,
            circuitBreakerFailureThreshold: 3,
            circuitBreakerOpenMs: 5000
        };
        let releaseTransport;
        let capturedBody;
        let transportCalls = 0;
        OpenRouterGateway.setTransport(async (_url, init) => {
            transportCalls += 1;
            capturedBody = JSON.parse(init.body);
            await new Promise((resolve) => { releaseTransport = resolve; });
            return response({
                choices: [{
                    message: {
                        content: JSON.stringify({
                            candidateId: candidates[1].id,
                            route: 'farm',
                            reasonCode: 'better_clan_readiness'
                        })
                    }
                }],
                usage: { prompt_tokens: 450, completion_tokens: 18, total_tokens: 468, cost: 0.001 }
            });
        });

        const pending = ClanBrain.choose(clan, brainSnapshot, {
            actionId: 991,
            config: testConfig,
            assemble: async () => assembled
        });
        assert.strictEqual(pending.pending, true, 'the clan scheduler must not wait for network inference');
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(typeof releaseTransport, 'function');
        releaseTransport();
        const resolved = await ClanBrain.waitFor(pending.key);
        assert.strictEqual(resolved.source, 'llm');
        assert.strictEqual(resolved.candidateId, candidates[1].id);
        assert.strictEqual(resolved.route, 'farm');
        assert.deepStrictEqual(resolved.contextTelemetry, {
            estimatedTokens: 420,
            buildMs: 2,
            truncated: false,
            historyEventCount: 3
        });
        assert.strictEqual(capturedBody.max_tokens, ClanBrain.MAX_COMPLETION_TOKENS);
        assert.strictEqual(capturedBody.messages.length, 2);
        assert(ContextAssembler.estimateTokens(capturedBody.messages) < 2500,
            'the complete clan request should stay inside the compact prompt budget');
        assert.deepStrictEqual(
            capturedBody.response_format.json_schema.schema.properties.candidateId.enum,
            candidates.map((entry) => entry.id)
        );
        assert.strictEqual(ClanBrain.choose(clan, {
            ...brainSnapshot,
            key: 'clan-77-volatile-revision'
        }, { actionId: 991 }).candidateId, candidates[1].id,
            'a resolved decision should be reused without another model request');
        assert.strictEqual(transportCalls, 1,
            'one durable clan action must not repeat inference when the volatile snapshot key changes');

        ClanBrain.reset();
        BotInferenceBudget.reset();
        const integrationSnapshot = {
            ...brainSnapshot,
            key: 'clan-77-goal-service',
            planning: { plans: new Map(), previousFulfilled: false },
            cacheHit: true
        };
        CandidateService.snapshotFor = async () => integrationSnapshot;
        let selectedByGoalService = null;
        EquipmentService.resolveClan = async (_clan, _previous, options) => {
            selectedByGoalService = options.selectedCandidate;
            return {
                ok: true,
                previousFulfilled: false,
                expectedUpdatedAt: 1,
                plans: new Map(),
                assignment: { ok: true },
                goal: {
                    type: 'equipment',
                    goalKey: 'clan-equipment-llm-test',
                    status: 'executing',
                    target: {
                        memberId: options.selectedCandidate.memberId,
                        itemId: options.selectedCandidate.itemId,
                        itemName: options.selectedCandidate.item.name,
                        slot: options.selectedCandidate.slot
                    },
                    plan: { kind: options.selectedCandidate.route.kind, reasonCode: 'clan_equipment_farm' },
                    progress: 0,
                    required: 1,
                    updatedAt: 2
                }
            };
        };
        let recordedSelection = null;
        Database.updateAutonomousClanGoal = async ({ goal }) => ({ ok: true, goal, updatedAt: 2 });
        Database.recordClanGoalEvent = async (event) => {
            recordedSelection = event;
            return { ok: true, eventId: 1 };
        };
        OpenRouterGateway.setTransport(async () => response({
            choices: [{ message: { content: JSON.stringify({
                candidateId: candidates[1].id,
                route: 'farm',
                reasonCode: 'better_clan_readiness'
            }) } }],
            usage: { prompt_tokens: 450, completion_tokens: 18, total_tokens: 468 }
        }));
        const servicePending = await ClanGoalService.resolveClan(clan, {
            config: testConfig,
            assemble: async () => assembled
        });
        assert.strictEqual(servicePending.reason, 'clan_llm_pending');
        await ClanBrain.waitFor(servicePending.decisionKey);
        const serviceResolved = await ClanGoalService.resolveClan(clan, {
            config: testConfig,
            assemble: async () => assembled
        });
        assert.strictEqual(serviceResolved.changed, true);
        assert.strictEqual(selectedByGoalService.id, candidates[1].id);
        assert.strictEqual(serviceResolved.context.decisionSource, 'llm');
        assert.strictEqual(recordedSelection.eventType, 'llm_goal_selected');
        assert.strictEqual(recordedSelection.payload.candidateId, candidates[1].id);

        ClanBrain.reset();
        BotInferenceBudget.reset();
        OpenRouterGateway.resetCircuit();
        let invalidCalls = 0;
        OpenRouterGateway.setTransport(async () => {
            invalidCalls += 1;
            return response({
                choices: [{ message: { content: JSON.stringify({
                    candidateId: 'invented-candidate',
                    route: 'market',
                    reasonCode: 'better_value'
                }) } }]
            });
        });
        const invalidPending = ClanBrain.choose(clan, { ...brainSnapshot, key: 'clan-77-invalid' }, {
            config: testConfig,
            assemble: async () => assembled
        });
        const fallback = await ClanBrain.waitFor(invalidPending.key);
        assert.strictEqual(fallback.source, 'deterministic');
        assert.strictEqual(fallback.candidateId, candidates[0].id);
        assert(invalidCalls >= 1 && invalidCalls <= 2, 'schema repair may retry once before deterministic fallback');

        console.log('Clan LLM goal management tests passed');
    } finally {
        EquipmentService.planningForClan = originalPlanningForClan;
        EquipmentService.resolveClan = originalResolveEquipment;
        CandidateService.snapshotFor = originalSnapshotFor;
        Database.updateAutonomousClanGoal = originalUpdateGoal;
        Database.recordClanGoalEvent = originalRecordGoalEvent;
        OpenRouterGateway.resetTransport();
        OpenRouterGateway.resetCircuit();
        BotInferenceBudget.reset();
        ClanBrain.reset();
        CandidateService.reset();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
