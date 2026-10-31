'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Income = require('../src/GameServer/Bot/Population/PartyIncomeComparison');
const Material = require('../src/GameServer/Bot/Population/CraftMaterialParty');
const Route = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const at = Date.now(), source = 990131, itemId = 4097;
const objective = { status: 'open', priority: 'required', reason: 'craft_material', materialParty: true,
    spotId: 'material-camp', npcId: source, itemId, amount: 12, requiredTotal: 12, targetId: 5726, materialCash: null };
const core = { characterId: 910001, level: 65, phase: 'cold', activity: 'hunting', spotId: 'solo', adena: 20000000,
    inventory: {}, stats: { classId: 8, role: 'dps', wishFocus: ['power:5726:12', 0, 1000000],
        equipmentPlan: { target: { selfId: 5726 } }, partyRequest: objective } };
const helper = { ...core, characterId: 910002, stats: { classId: 8, role: 'dps', wishFocus: ['power:97:14', 0, 1000000] } };
const members = [core, helper];
const agreement = Material.agreement(members, objective);
const spot = { id: objective.spotId, avgLevel: 60, npcEntries: [{ selfId: source, count: 1 }] };
const prepared = { spots: [spot], spot, timestamp: at, rows: new Map(members.map(member => [member.characterId,
    { income: 100000, kills: 100, source: 'table_party', travelHours: 0 }])) };
const original = { select: Route.select, allowed: Routes.isSpotAllowedForState, share: Hunt.onSpotShare,
    forState: Economy.forState, forGroup: Economy.forGroup, npc: Data.npcs, rewards: Data.npcRewards };
let scans = 0, exact = 0;
try {
    Route.select = () => { scans++; return { spot: { id: 'solo' }, row: { income: 1000000, kills: 100 }, earning: 1000000 }; };
    Routes.isSpotAllowedForState = () => { exact++; return false; };
    Hunt.onSpotShare = () => 1;
    Economy.forState = Economy.forGroup = () => { throw Error('material admission rebuilt wishes'); };
    Data.npcs = [{ selfId: source, template: { level: 60 } }];
    Data.npcRewards = [{ selfId: source, rewards: [{ overall: 100,
        items: [{ selfId: itemId, chance: 100, min: 1, max: 1 }] }] }];
    const answer = Income.compare(core, [helper], { prepared, objective });
    assert.equal(answer.accept, true, 'a funded final-item estimate cannot replace delivery of its missing component');
    assert.equal(answer.reason, 'goal_requires_party');
    assert.equal(answer.soloHours, null);
    assert(answer.partyHours > 0);
    assert.equal(Income.compare(helper, [core], { prepared, objective }).accept, false,
        'a helper still refuses an unpaid loss of its own income');
    const paid = { ...objective, helpDeal: { payerId: core.characterId, itemId, count: 12, fee: 10000000 } };
    assert.equal(Income.compare(helper, [core], { prepared, objective: paid }).accept, true,
        'an affordable native delivery fee can compensate the helper');
    const fundedParty = { stats: { agreement: { ...agreement, help: { ...paid.helpDeal,
        status: 'funded', helperIds: [helper.characterId], remaining: paid.helpDeal.fee } } } };
    assert.equal(Income.compare(helper, [core], { prepared, objective: paid, party: fundedParty }).accept, true);
    const newcomer = { ...helper, characterId: 910003 };
    const expanded = { ...prepared, rows: new Map([...prepared.rows,
        [newcomer.characterId, prepared.rows.get(helper.characterId)]]) };
    assert.equal(Income.compare(newcomer, members, { prepared: expanded, objective: paid, party: fundedParty }).accept, false,
        'a new helper cannot count an existing escrow reserved for the original helpers as its income');
    assert.equal(Income.compare({ ...core, adena: 1 }, [helper], { prepared, objective: paid }).accept, false,
        'a component goal cannot bypass the native fee funding gate');
    const quoted = { ...core, stats: { ...core.stats, partyRequest: { ...objective, materialCash: 1000 } } };
    assert.equal(Income.compare(quoted, [helper], { prepared, objective }).accept, false,
        'a known affordable complete purchase still beats a slower material hunt');
    const soloSource = { ...core, stats: { ...core.stats, partyRequest: { ...objective, materialSoloHours: 0.001 } } };
    assert.equal(Income.compare(soloSource, [helper], { prepared, objective }).accept, false,
        'a known faster solo source at another camp still beats the proposed material hunt');
    const alone = Income.itemHours(core, spot, 100, { ...objective, amount: 12 }, [core]);
    assert.equal(Income.itemHours(core, spot, 100, { ...objective, amount: 12 }, members, agreement), alone,
        'a helper does not dilute reserved material ownership');
    const secondOwner = { ...helper, stats: { ...core.stats } };
    const shared = Material.agreement([core, secondOwner], objective);
    assert.equal(Income.itemHours(core, spot, 100, { ...objective, amount: 12 }, [core, secondOwner], shared), alone * 2,
        'two owners conservatively forecast delivery of the combined physical need');
    const materialRoute = require('../src/GameServer/Bot/Population/CraftMaterialPartyRoute');
    const spoilSpot = { ...spot, id: 'spoil-camp' }, spoilOwner = { ...core, spotId: spoilSpot.id };
    const spoiler = { ...helper, spotId: spoilSpot.id, stats: { ...helper.stats, classId: 54, role: 'spoiler',
        coldCombat: { classId: 54, skillSource: 'database', skills: [{ selfId: 254, level: 9 }] } } };
    const spoilParty = materialRoute.retarget({ stats: { objective, agreement } }, [{
        characterId: core.characterId, itemId, targetId: objective.targetId,
        spotId: spoilSpot.id, npcId: source, sourceKind: 'spoil' }]);
    const spoilAgreement = spoilParty.stats.agreement;
    const spoilGoal = Material.needs([spoilOwner, spoiler], spoilParty.stats.objective, spoilAgreement)[0];
    const dropRewards = Data.npcRewards;
    try {
        Data.npcRewards = [{ selfId: source, rewards: [], spoils: [{ overall: 100,
            items: [{ selfId: itemId, chance: 100, min: 1, max: 1 }] }] }];
        const hours = Income.itemHours(spoilOwner, spoilSpot, 100, spoilGoal, [spoilOwner, spoiler], spoilAgreement);
        assert(hours > 0, 'retargeted spoil has a delivery ETA for its nonspoiler material owner');
        const measured = { ...prepared, spot: spoilSpot, spots: [spoilSpot], rows: new Map([
            [core.characterId, { income: 100000, kills: 100, source: 'own_party', travelHours: 0 }]]) };
        const decision = Income.compare(spoilOwner, [spoiler], { prepared: measured,
            objective: spoilParty.stats.objective, party: spoilParty });
        assert.equal(decision.accept, true, 'measured party income retains the real helper-spoil delivery path during roster review');
        assert.equal(decision.reason, 'goal_requires_party');
        assert.equal(decision.partyHours, hours);
        assert.equal(decision.partySource, 'own_party');
        assert.equal(Income.itemHours(spoilOwner, spoilSpot, 100, spoilGoal, [spoilOwner, spoiler]), null,
            'ordinary spoil loot still belongs to its spoiler without a material contract');
        assert.equal(Income.itemHours(spoilOwner, spoilSpot, 100, spoilGoal, [spoilOwner], spoilAgreement), null,
            'a solo nonspoiler cannot invent the absent helper');
        const untrained = { ...spoiler, stats: { ...spoiler.stats, coldCombat: { skills: [] } } };
        assert.equal(Income.itemHours(spoilOwner, spoilSpot, 100, spoilGoal, [spoilOwner, untrained], spoilAgreement), null,
            'class alone cannot promise spoil without the native learned skill');
    } finally { Data.npcRewards = dropRewards; }
    const scanBaseline = scans, exactBaseline = exact, durations = [];
    for (let i = 0; i < 1000; i++) {
        const start = performance.now();
        Income.compare(core, [helper], { prepared, objective });
        durations.push(performance.now() - start);
    }
    assert.equal(scans, scanBaseline, 'warm admission reuses the bounded solo choice');
    assert.equal(exact, exactBaseline, 'warm admission repeats no exact safety checks');
    durations.sort((a, b) => a - b);
    console.log(`MATERIAL_ADMISSION_WARM_P95_MS ${durations[950].toFixed(4)}`);
    console.log('PASS material admission: physical completion, real market alternative, conservative ownership, paid helper and no wish builds');
} finally {
    Route.select = original.select; Routes.isSpotAllowedForState = original.allowed; Hunt.onSpotShare = original.share;
    Economy.forState = original.forState; Economy.forGroup = original.forGroup;
    Data.npcs = original.npc; Data.npcRewards = original.rewards;
}
