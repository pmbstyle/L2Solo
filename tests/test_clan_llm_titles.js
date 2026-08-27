const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const ClanService = invoke('GameServer/Clan/ClanService');
const ClanTitleBrain = invoke('GameServer/Clan/ClanTitleBrain');
const ClanTitleService = invoke('GameServer/Clan/ClanTitleService');
const ClanSimulationConfig = invoke('GameServer/Clan/ClanSimulationConfig');
const ContextAssembler = invoke('GameServer/Clan/ClanContextAssembler');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');

function response(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    };
}

async function main() {
    const originalFetchEvents = Database.fetchClanGoalEvents;
    const originalRecordEvent = Database.recordClanGoalEvent;
    const originalApplyTitles = ClanService.applyAutonomousMemberTitles;
    const originalTitleEnabled = ClanSimulationConfig.llmTitleManagementEnabled;
    try {
        ClanSimulationConfig.llmTitleManagementEnabled = true;
        ClanTitleService.resetMetrics();
        BotInferenceBudget.reset();
        OpenRouterGateway.resetCircuit();

        const clan = {
            id: 88,
            name: 'IronOath',
            level: 3,
            leaderId: 801,
            state: {
                goal: {
                    type: 'equipment',
                    status: 'executing',
                    target: { itemName: 'Full Plate Armor' },
                    plan: { kind: 'farm' }
                }
            },
            members: [
                { id: 801, name: 'Aster', title: '', classId: 5, level: 44 },
                { id: 802, name: 'Mira', title: '', classId: 16, level: 42 },
                { id: 803, name: 'Rook', title: 'Oathkeeper', classId: 22, level: 41 }
            ]
        };
        Database.fetchClanGoalEvents = async () => [{
            eventType: 'goal_completed',
            goalType: 'item',
            plan: 'farm',
            reasonCode: 'goal_completed'
        }];
        const snapshot = await ClanTitleService.snapshotFor(clan);
        assert.deepStrictEqual(snapshot.missingMemberIds, [801, 802]);
        assert.strictEqual(snapshot.context.members[0].leader, true);
        assert.strictEqual(snapshot.context.members[2].title, 'Oathkeeper');
        assert.strictEqual(snapshot.context.recentHistory.length, 1);
        assert(ContextAssembler.estimateTokens(snapshot.context) < 1200,
            'one clan title request should remain compact even with roster context');

        assert.deepStrictEqual(
            ClanTitleBrain.responseSchema(snapshot.missingMemberIds)
                .properties.assignments.items.properties.characterId.enum,
            [801, 802]
        );
        assert.strictEqual(ClanTitleService.validateAssignments(snapshot, [
            { characterId: 801, title: 'Oath Commander' },
            { characterId: 802, title: 'Dawn Grace' }
        ]).ok, true);
        assert.strictEqual(ClanTitleService.validateAssignments(snapshot, [
            { characterId: 801, title: 'Same' },
            { characterId: 802, title: 'Same' }
        ]).code, 'invalid_clan_titles');
        assert.strictEqual(ClanTitleService.validateAssignments(snapshot, [
            { characterId: 999, title: 'Invented Member' },
            { characterId: 802, title: 'Dawn Grace' }
        ]).code, 'invalid_clan_titles');
        assert.strictEqual(ClanTitleService.validateAssignments(snapshot, [
            { characterId: 801, title: 'Oathkeeper' },
            { characterId: 802, title: 'Dawn Grace' }
        ]).code, 'invalid_clan_titles', 'new titles must not duplicate an existing clan title');

        const testConfig = {
            enabled: true,
            apiKey: 'test-key',
            apiUrl: OpenRouterGateway.OPENROUTER_URL,
            model: 'openai/gpt-5.6-luna',
            reasoningEffort: 'off',
            maxTokens: ClanTitleBrain.MAX_COMPLETION_TOKENS,
            timeoutMs: 1000,
            circuitBreakerFailureThreshold: 3,
            circuitBreakerOpenMs: 5000
        };
        let releaseTransport;
        let capturedBody;
        OpenRouterGateway.setTransport(async (_url, init) => {
            capturedBody = JSON.parse(init.body);
            await new Promise((resolve) => { releaseTransport = resolve; });
            return response({
                choices: [{ message: { content: JSON.stringify({ assignments: [
                    { characterId: 801, title: 'Oath Commander' },
                    { characterId: 802, title: 'Dawn Grace' }
                ] }) } }],
                usage: { prompt_tokens: 620, completion_tokens: 46, total_tokens: 666, cost: 0.001 }
            });
        });
        const applied = [];
        ClanService.applyAutonomousMemberTitles = async (clanId, assignments) => {
            applied.push({ clanId, assignments });
            assignments.forEach((assignment) => {
                const member = clan.members.find((entry) => entry.id === assignment.characterId);
                member.title = assignment.title;
            });
            return { ok: true, updated: assignments.map((assignment) => ({ ...assignment, hot: false })) };
        };
        let recordedEvent = null;
        Database.recordClanGoalEvent = async (event) => {
            recordedEvent = event;
            return { ok: true, eventId: 1 };
        };

        const pending = await ClanTitleService.resolveClan(clan, {
            config: testConfig,
            snapshotFor: async () => snapshot
        });
        assert.strictEqual(pending.pending, true, 'the clan action must not wait for title inference');
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(typeof releaseTransport, 'function');
        releaseTransport();
        const decision = await ClanTitleBrain.waitFor(pending.decisionKey);
        assert.strictEqual(decision.ok, true);
        const resolved = await ClanTitleService.resolveClan(clan, {
            config: testConfig,
            snapshotFor: async () => snapshot
        });
        assert.strictEqual(resolved.changed, true);
        assert.strictEqual(applied.length, 1);
        assert.deepStrictEqual(applied[0].assignments, [
            { characterId: 801, title: 'Oath Commander' },
            { characterId: 802, title: 'Dawn Grace' }
        ]);
        assert.strictEqual(clan.members[2].title, 'Oathkeeper', 'existing titles must never be rewritten');
        assert.strictEqual(recordedEvent.eventType, 'llm_titles_assigned');
        assert.strictEqual(capturedBody.max_tokens, ClanTitleBrain.completionTokenLimit(2));
        assert.strictEqual(capturedBody.messages.length, 2);
        assert(ContextAssembler.estimateTokens(capturedBody.messages) < 1800);
        assert.deepStrictEqual(
            capturedBody.response_format.json_schema.schema.properties.assignments.items.properties.characterId.enum,
            [801, 802]
        );
        assert.strictEqual(ClanTitleService.metrics().appliedTitles, 2);

        console.log('Clan LLM title management tests passed');
    } finally {
        Database.fetchClanGoalEvents = originalFetchEvents;
        Database.recordClanGoalEvent = originalRecordEvent;
        ClanService.applyAutonomousMemberTitles = originalApplyTitles;
        ClanSimulationConfig.llmTitleManagementEnabled = originalTitleEnabled;
        OpenRouterGateway.resetTransport();
        OpenRouterGateway.resetCircuit();
        BotInferenceBudget.reset();
        ClanTitleService.resetMetrics();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
