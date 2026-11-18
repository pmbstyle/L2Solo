process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture inspects optional developer metrics.
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

async function verifyFullRoster(config, fullClan, applied) {
    const sizes = [];
    let attempts = 0;
    OpenRouterGateway.setTransport(async (_url, init) => {
        attempts += 1;
        if (attempts === 1) return response({}, 503);
        const ids = JSON.parse(JSON.parse(init.body).messages[1].content).assignOnlyMemberIds;
        sizes.push(ids.length);
        const assignments = ids.map((characterId) => ({ characterId, title: `Order Sigil ${characterId}` }));
        return response({ choices: [{ message: { content: JSON.stringify({ assignments }) } }] });
    });

    const realNow = Date.now;
    let time = realNow();
    Date.now = () => time;
    try {
        const pending = await ClanTitleService.resolveClan(fullClan, { config });
        await ClanTitleBrain.waitFor(pending.decisionKey);
        const failed = await ClanTitleService.resolveClan(fullClan, { config });
        assert.strictEqual(failed.retryable, true);
        assert.strictEqual(failed.code, 'provider_error');
        assert.strictEqual(attempts, 1);
        assert.strictEqual(applied.length, 0);

        for (const remaining of [21, 13, 5, 0]) {
            time += 61000;
            const next = await ClanTitleService.resolveClan(fullClan, { config });
            assert.strictEqual(next.pending, true);
            await ClanTitleBrain.waitFor(next.decisionKey);
            const batch = await ClanTitleService.resolveClan(fullClan, { config });
            assert.strictEqual(batch.changed, true);
            assert.strictEqual(batch.pending === true, remaining > 0);
            assert.strictEqual(fullClan.members.filter((member) => !member.title).length, remaining);
        }
        assert.deepStrictEqual(sizes, [8, 8, 8, 5]);
        assert.strictEqual(new Set(fullClan.members.map((member) => member.title)).size, 30);
        assert.strictEqual(fullClan.members.at(-1).title, 'Oathkeeper');
        assert.strictEqual((await ClanTitleService.resolveClan(fullClan, { config })).code, 'clan_titles_complete');
    } finally {
        Date.now = realNow;
    }
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
        const fullClan = {
            ...clan,
            id: 89,
            leaderId: 901,
            members: Array.from({ length: 30 }, (_, index) => ({
                id: 901 + index, name: `Roster${index}`, classId: 16, level: 40,
                title: index === 29 ? 'Oathkeeper' : ''
            }))
        };
        const clans = new Map([[clan.id, clan], [fullClan.id, fullClan]]);
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
            model: 'test/clan-model',
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
                const member = clans.get(clanId).members.find((entry) => entry.id === assignment.characterId);
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

        const playerManaged = { ...fullClan, state: { mode: 'player_managed' } };
        const skipped = await ClanTitleService.resolveClan(playerManaged, { config: testConfig });
        assert.strictEqual(skipped.code, 'clan_titles_unavailable');
        assert.strictEqual(skipped.skipped, true);

        applied.length = 0;
        await verifyFullRoster(testConfig, fullClan, applied);

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
