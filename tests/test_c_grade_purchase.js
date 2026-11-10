'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('c-grade-purchase');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Native = require('./helpers/nativeMarketFixture');
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const location = { locX: 83396, locY: 147904, locZ: -3400 };
async function seed(id) {
    await Native.character(DB, id, `EarlyBuyer${id}`, `bot_early_buyer_${id}`, location);
    await DB.execute(['UPDATE characters SET level=33,classId=54,race=4,exp=? WHERE id=?', [Data.experience[32], id]]);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 30000000 });
    for (const row of Gear.planFor({ classId: 54, level: 20 }).items)
        await DB.setItem(id, { ...row, amount: 1, equipped: true, enchant: 0,
            name: Data.items.find(item => item.selfId === row.selfId).template.name });
    return Life.upsertState({ characterId: id, accountName: `bot_early_buyer_${id}`, name: `EarlyBuyer${id}`,
        phase: 'cold', activity: 'shopping', level: 33, exp: Data.experience[32], adena: 30000000, currentRegion: 'Giran', loc: location,
        inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)), timing: {},
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, stats: { classId: 54, money: [0, 0, 0, 0] } },
    'early_c_purchase_fixture');
}
async function run() {
    try {
        await DB.init(); await Life.init();
        let state = await seed(9631);
        const before = structuredClone(state.inventory);
        state = await Life.applyMarketPurchase(state, { selfId: 103, price: 10000, sourceType: 'fixture' });
        assert(state, 'physical acquisition accepts early C');
        assert.equal(state.adena, 30000000 - 10000);
        assert.equal(state.inventory[103].amount, 1);
        assert.equal(state.inventory[103].equipped, false, 'acquisition keeps C in the bag');
        for (const [id, row] of Object.entries(before)) if (Number(id) !== 57)
            assert.deepEqual(state.inventory[id].equippedSlots, row.equippedSlots, 'physical D kit remains usable');
        assert(!Disposition.saleCandidates(state).some(row => row.selfId === 103));
        assert.equal(await Life.applyMarketPurchase(state, { selfId: 103, price: 10000, sourceType: 'fixture' }), null);
        assert.equal((await DB.fetchItems(state.characterId)).find(row => row.selfId === 57).amount, state.adena,
            'already held future gear is not charged twice');

        state = await seed(9632);
        const wornBefore = Object.values(state.inventory).filter(row => row.equipped).map(row => [row.selfId, row.equippedSlots]);
        state = await Life.applyMarketPurchase(state, { selfId: 883, price: 1000, sourceType: 'fixture' }, 2);
        assert(state);
        assert.equal(state.inventory[883].amount, 2);
        assert.equal(state.inventory[883].equippedCount, 0, 'legacy acquisition also defers both C rings');
        assert.deepEqual(Object.values(state.inventory).filter(row => row.equipped).map(row => [row.selfId, row.equippedSlots]), wornBefore);
        assert((await DB.fetchItems(state.characterId)).filter(row => row.selfId === 883).every(row => !row.equipped));
        assert(!Disposition.saleCandidates(state).some(row => row.selfId === 883));
        state = await seed(9633);
        await DB.setItem(state.characterId, { selfId: 1458, name: 'D crystal', amount: 6000 });
        state = await Life.syncExternalInventory(state.characterId, 'luxury_fixture', state);
        const Luxury = invoke('GameServer/Bot/Economy/BotLuxuryExchange');
        const recipe = Luxury.recipes().get(162);
        assert.deepEqual(recipe.materials, [{ selfId: 1458, amount: 5375 }], 'only D crystals are required for bots');
        assert(!Luxury.recipes().has(294), 'a legacy mislabeled D item is not a C transition');
        assert.deepEqual(require('../src/GameServer/World/Generics/NpcExchangeShopLists').fetchForNpc(7097)[3].required
            .map(row => row.selfId), [1459, 1458], 'player costs retain both crystal grades');
        const proposal = { kind: 'luxury_exchange', ...recipe };
        const Decision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
        const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
        const exchangeCard = Decision.capture({ riskWeight: 1, network: { activity: {
            kind: 'luxury_exchange', activity: 'improving', itemId: recipe.itemId, amount: recipe.amount,
            improvement: proposal, town: 'Giran'
        } } }, state);
        assert.equal(Economy.leafCheck(state, exchangeCard.activity, {}, {}), '', 'the unpaid exchange remains actionable');
        assert(Luxury.eligible(state, recipe), JSON.stringify(invoke('GameServer/Bot/AI/PersonalGearProgression').assess(state),
            (key, value) => value instanceof Map ? [...value] : value));
        const [physicalCharacter] = await DB.execute(['SELECT level,classId,clanId,locX,locY,locZ FROM characters WHERE id=?', [state.characterId]]);
        assert.equal(physicalCharacter.level, 33);
        assert.equal(physicalCharacter.classId, 54);
        assert.equal(invoke('GameServer/World/TownRespawn').getClosestTown(physicalCharacter.locX, physicalCharacter.locY,
            physicalCharacter.locZ).name, 'Giran');
        await DB.execute(['UPDATE characters SET locX=91058,locY=171959,locZ=-3760 WHERE id=?', [state.characterId]]);
        const beforeExchange = await DB.fetchItems(state.characterId);
        await DB.execute([`CREATE TEMP TRIGGER fail_luxury BEFORE INSERT ON items WHEN NEW.characterId=9633
            AND NEW.selfId=162 BEGIN SELECT RAISE(ABORT,'luxury rollback'); END`]);
        await assert.rejects(DB.applyBotImprovement(state.characterId, proposal, { coldState: state }), /luxury rollback/);
        assert.deepEqual(await DB.fetchItems(state.characterId), beforeExchange, 'failed exchange restores every physical input');
        await DB.execute(['DROP TRIGGER fail_luxury']);
        const exchanged = await DB.applyBotImprovement(state.characterId, proposal, { coldState: state });
        const fresh = Life.acceptLifecycleRow(exchanged.coldLifeRow, 'luxury_fixture');
        assert.equal(exchanged.result, 'luxury_exchange');
        assert.equal(fresh.inventory[1458].amount, 625);
        assert.equal(fresh.inventory[162].amount, 1);
        assert.equal(fresh.inventory[162].equipped, false, 'exchanged C awaits expertise');
        assert.equal(fresh.adena, state.adena, 'exchange price is crystals, with travel paid separately');
        assert(!fresh.inventory[1459], 'no C crystal input or synthetic C crystal appears');
        assert.equal(Economy.leafCheck(fresh, exchangeCard.activity, {}, {}).reason, 'check:filled',
            'receiving future C gear ends the selected exchange during the same town visit');
        await assert.rejects(DB.applyBotImprovement(state.characterId, proposal, { coldState: state }), /economy_state_changed/);
        await assert.rejects(DB.applyBotImprovement(state.characterId, proposal, { coldState: fresh }), /already_owned/);
        assert.equal((await DB.fetchItems(state.characterId)).filter(row => row.selfId === 162).length, 1);
        state = await seed(9634);
        await assert.rejects(DB.applyBotImprovement(state.characterId, proposal, { coldState: state }), /improvement_missing_materials/);
        assert(!(await DB.fetchItems(state.characterId)).some(row => row.selfId === 162));
        state = await seed(9637);
        await DB.setItem(state.characterId, { selfId: 1458, name: 'D crystal', amount: 6000 });
        state = await Life.syncExternalInventory(state.characterId, 'luxury_fixture', state);
        state = await Life.upsertState({ ...state, inventory: { ...state.inventory,
            1458: { ...state.inventory[1458], protectedAmount: 1000 } } }, 'reserved_crystal_fixture');
        const reservedBag = await DB.fetchItems(state.characterId);
        await assert.rejects(DB.applyBotImprovement(state.characterId, proposal, { coldState: state }), /improvement_missing_materials/);
        assert.deepEqual(await DB.fetchItems(state.characterId), reservedBag, 'Luxury respects crystal ownership reservations');
        // Expertise permits immediate native wear after the same exchange.
        state = await seed(9635);
        await DB.execute(["INSERT INTO clans(id,name,level,leaderId) VALUES(77,'CTransitionClan',1,9635)"]);
        invoke('GameServer/Clan/ClanSupplyPolicy').publish({ id: 77, level: 1, state: {} });
        await DB.execute(['UPDATE characters SET level=40,exp=?,clanId=77 WHERE id=?', [Data.experience[39], state.characterId]]);
        state = await Life.upsertState({ ...state, level: 40, exp: Data.experience[39], clanId: 77,
            stats: { ...state.stats, clanId: 77, exp: Data.experience[39] } }, 'c_expertise_fixture');
        assert.equal(invoke('GameServer/Bot/AI/PersonalGearProgression').personal(state), false,
            'the native exchange fixture has actual clan warehouse access');
        await DB.setItem(state.characterId, { selfId: 1458, name: 'D crystal', amount: 6000 });
        state = await Life.syncExternalInventory(state.characterId, 'luxury_fixture', state);
        const adult = await DB.applyBotImprovement(state.characterId, proposal, { coldState: state });
        assert(Life.acceptLifecycleRow(adult.coldLifeRow, 'luxury_fixture').inventory[162].equipped,
            'the atomic physical exchange equips C for a clan member after expertise');

        const Crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
        state = await seed(9636);
        const spareIds = Crystals.catalog().filter(id => !state.inventory[id]).slice(0, 2);
        assert.equal(spareIds.length, 2);
        const sparePlan = { strategy: 'luxury_exchange', status: 'active', target: { selfId: 162 },
            materials: [{ selfId: 1458, amount: 5375 }, { selfId: spareIds[0], amount: 2 }, { selfId: spareIds[1], amount: 1 }] };
        state = await Life.upsertState({ ...state, stats: { ...state.stats, equipmentPlan: sparePlan } }, 'crystal_input_fixture');
        state = await Life.applyMarketPurchase(state, { selfId: spareIds[0], price: 100, sourceType: 'fixture' }, 2);
        state = await Life.applyMarketPurchase(state, { selfId: spareIds[1], price: 100, sourceType: 'fixture' });
        assert(state);
        assert.equal(state.inventory[spareIds[0]].amount, 2);
        assert.equal(state.inventory[spareIds[0]].equippedCount, 0, 'bought crystal inputs stay unequipped');
        assert(!Disposition.saleCandidates(state).some(row => spareIds.includes(row.selfId)), 'exchange inputs stay reserved');
        const batch = { kind: 'crystallize', npcId: Crystals.npcId,
            items: [{ selfId: spareIds[0], amount: 2 }, { selfId: spareIds[1], amount: 1 }] };
        const crystalCard = Decision.capture({ riskWeight: 1, network: { activity: {
            kind: 'crystallize', activity: 'improving', itemId: 1458, amount: 5375,
            improvement: batch, town: 'Giran'
        } } }, state);
        await DB.execute(['UPDATE characters SET locX=91058,locY=171959,locZ=-3760 WHERE id=?', [state.characterId]]);
        const bagBefore = await DB.fetchItems(state.characterId);
        const kitBefore = bagBefore.filter(row => row.equipped);
        await DB.execute([`CREATE TEMP TRIGGER fail_crystal BEFORE INSERT ON items WHEN NEW.characterId=9636
            AND NEW.selfId=1458 BEGIN SELECT RAISE(ABORT,'crystal rollback'); END`]);
        await assert.rejects(DB.applyBotImprovement(state.characterId, batch, { coldState: state }), /crystal rollback/);
        assert.deepEqual(await DB.fetchItems(state.characterId), bagBefore, 'a failed batch restores every source');
        await DB.execute(['DROP TRIGGER fail_crystal']);
        const shattered = await DB.applyBotImprovement(state.characterId, batch, { coldState: state });
        const shards = Life.acceptLifecycleRow(shattered.coldLifeRow, 'crystal_fixture');
        const output = 2 * Crystals.reward(Data.items.find(row => row.selfId === spareIds[0])).net
            + Crystals.reward(Data.items.find(row => row.selfId === spareIds[1])).net;
        assert.equal(shards.inventory[1458].amount, output, 'fee rounds upward separately for each item');
        assert(output < 5375, 'this command supplies only part of the final crystal need');
        assert.equal(Economy.leafCheck(shards, crystalCard.activity, {}, {}).reason, 'check:filled',
            'a partial crystal delivery ends its consumed batch before selecting the next one');
        assert(!spareIds.some(id => shards.inventory[id]));
        assert.deepEqual((await DB.fetchItems(state.characterId)).filter(row => row.equipped), kitBefore, 'the D kit survives the batch');
        assert.equal(shards.adena, state.adena);
        await assert.rejects(DB.applyBotImprovement(state.characterId, batch, { coldState: state }), /economy_state_changed/);
        await assert.rejects(DB.applyBotImprovement(state.characterId, batch, { coldState: shards }), /improvement_source_changed/);
        const worn = kitBefore.find(row => Crystals.reward(Data.items.find(item => item.selfId === row.selfId)));
        await assert.rejects(DB.applyBotImprovement(state.characterId,
            { kind: 'crystallize', npcId: Crystals.npcId, sourceSelfId: worn.selfId }, { coldState: shards }), /improvement_source_changed/);
        state = await seed(9638);
        const wornId = Object.values(state.inventory).find(row => row.equippedCount === 1
            && Crystals.reward(Data.items.find(item => item.selfId === row.selfId))).selfId;
        const wornSlots = [...state.inventory[wornId].equippedSlots];
        state = await Life.upsertState({ ...state, stats: { ...state.stats, equipmentPlan: {
            ...sparePlan, materials: [{ selfId: 1458, amount: 5375 }, { selfId: wornId, amount: 2 }] } } }, 'worn_crystal_input_fixture');
        state = await Life.applyMarketPurchase(state, { selfId: wornId, price: 100, sourceType: 'fixture' }, 2);
        assert.equal(state.inventory[wornId].amount, 3);
        assert.deepEqual(state.inventory[wornId].equippedSlots, wornSlots, 'buying spare copies preserves the worn copy');
        const spareCopies = await DB.applyBotImprovement(state.characterId,
            { kind: 'crystallize', npcId: Crystals.npcId, sourceSelfId: wornId, amount: 2 }, { coldState: state });
        const remaining = Life.acceptLifecycleRow(spareCopies.coldLifeRow, 'spare_copy_fixture');
        assert.equal(remaining.inventory[wornId].amount, 1);
        assert.deepEqual(remaining.inventory[wornId].equippedSlots, wornSlots, 'only the two spare copies are crystallized');
        // Exercise the real lifecycle handoff: the prepared worker card must
        // execute the town action before the market return can leave Giran.
        state = await seed(9639);
        const silver = Luxury.recipes().get(161);
        state = await Life.upsertState({ ...state, stats: { ...state.stats, equipmentPlan: {
            strategy: 'luxury_exchange', status: 'active', target: { selfId: 161, slot: 7 }, exchange: silver,
            materials: [...silver.materials, { selfId: 90, amount: 2 }] } } }, 'town_chain_fixture');
        state = await Life.applyMarketPurchase(state, { selfId: 90, price: 100, sourceType: 'fixture' }, 2);
        const Population = invoke('GameServer/Bot/Population/PopulationService');
        async function townStep(current, improvement) {
            return Population.resolveColdState(current, {
                precomputedPlan: { previousPlan: current.stats.equipmentPlan, acquisitionPlan: current.stats.equipmentPlan,
                    economyDecision: Decision.capture({ riskWeight: 1, network: { activity: {
                        activity: 'improving', kind: improvement.kind, improvement, town: 'Giran' } } }, current) },
                precomputedResult: { patch: {}, events: [], materialize: { exp: 0, sp: 0, adena: 0, items: [] },
                    nextResolveAt: Date.now() + 30000, debug: {} }
            });
        }
        const townCrystals = await townStep(state, { kind: 'crystallize', npcId: Crystals.npcId, sourceSelfId: 90, amount: 2 });
        assert(townCrystals.ok);
        assert.equal(townCrystals.state.currentRegion, 'Giran');
        assert.equal(townCrystals.state.activity, 'shopping', 'crystallization finishes before departure');
        assert.equal(townCrystals.state.stats.lastImprovement.kind, 'crystallize');
        assert(!townCrystals.state.inventory[90]);
        const townEquipment = await townStep(townCrystals.state, { kind: 'luxury_exchange', ...silver });
        assert(townEquipment.ok);
        assert.equal(townEquipment.state.stats.lastImprovement.kind, 'luxury_exchange');
        assert.equal(townEquipment.state.activity, 'shopping', 'exchange also precedes market return');
        assert.equal(townEquipment.state.inventory[161].equipped, false);
        // A symbol maker's henna is drawn on the visit it came for, as the exchange: a visit that left
        // without it brought the bot back to town for it again and again.
        state = await seed(9642);
        const symbol = invoke('GameServer/Henna/HennaRules').availableForClass(54).find(row => row.STR > 0);
        await DB.setItem(state.characterId, { selfId: symbol.dyeSelfId, name: 'Dye', amount: symbol.dyeAmount });
        state = await Life.syncExternalInventory(state.characterId, 'town_henna_fixture', state);
        const townHenna = await townStep(state, { kind: 'henna', symbolId: symbol.id });
        assert(townHenna.ok);
        assert.equal(townHenna.state.stats.hennas?.[0], symbol.id, 'the visit draws the henna it came for');
        assert.equal(townHenna.state.activity, 'shopping', 'the henna precedes the market return');
        // Only in a town where a symbol maker stands (C4 spawns): the Elven Village has none.
        const elven = Object.values(invoke('GameServer/World/TownRespawn').towns).find(town => town.name === 'Elven Village');
        const hennaCard = { activity: { activity: 'improving', improvement: { kind: 'henna', symbolId: symbol.id } }, riskWeight: 1 };
        const elvenHenna = await invoke('GameServer/Bot/Economy/BotImprovementService').reviewCold({ ...state, currentRegion: elven.name,
            loc: { locX: elven.locX, locY: elven.locY, locZ: elven.locZ } }, { decide: () => hennaCard });
        assert.equal(elvenHenna.changed, false, 'no henna where no symbol maker stands');
        const dropped = Life.cachedState(state.characterId);
        assert.equal(dropped.stats.activityLeaf, 0, 'a town without one refuses the held step: the next build drops it');
        assert(invoke('GameServer/Bot/Situations').woken(dropped.stats, 'build'), 'and is woken by the refusal');
        state = await seed(9640);
        state = await Life.upsertState({ ...state, stats: { ...state.stats, equipmentPlan: {
            strategy: 'luxury_exchange', status: 'active', target: { selfId: 161, slot: 7 }, exchange: silver,
            materials: [...silver.materials, { selfId: 90, amount: 2 }] } } }, 'return_to_station_fixture');
        state = await Life.applyMarketPurchase(state, { selfId: 90, price: 100, sourceType: 'fixture' }, 2);
        state = await Life.upsertState({ ...state, activity: 'hunting', currentRegion: 'Dion',
            loc: { locX: 18748, locY: 145437, locZ: -3132 } }, 'outside_station_fixture');
        const crystalCommand = { kind: 'crystallize', npcId: Crystals.npcId, sourceSelfId: 90, amount: 2 };
        await assert.rejects(DB.applyBotImprovement(state.characterId, crystalCommand, { coldState: state }),
            /invalid_bot_crystallization/, 'an old character position in Giran cannot authorize an outside cold bot');
        await assert.rejects(DB.applyBotImprovement(state.characterId, crystalCommand, {
            coldState: { ...state, activity: 'shopping', currentRegion: 'Giran', loc: location }
        }), /economy_state_changed/, 'a same-revision command cannot claim a different town');
        const economy = invoke('GameServer/Bot/Economy/EconomyContext'), originalBuild = economy.forState;
        economy.forState = () => { throw Error('town handoff must not rebuild the forecast on main'); };
        let dispatched;
        try {
            dispatched = await Population.executeWorkerLifecycleCommand(state, { precomputedResult: {},
                precomputedPlan: { economyDecision: Decision.capture({ riskWeight: 1, network: { activity: {
                    activity: 'improving', kind: 'crystallize', improvement: {
                        kind: 'crystallize', npcId: Crystals.npcId, sourceSelfId: 90, amount: 2 } } } }, state) } });
        } finally { economy.forState = originalBuild; }
        assert(dispatched.ok);
        assert.equal(dispatched.state.stats.travel.townName, 'Giran');
        assert.equal(dispatched.state.stats.travel.arrivalActivity, 'shopping');
        assert(dispatched.state.adena < state.adena, 'native dispatch pays the existing travel cost');
        assert.equal(dispatched.state.inventory[90].amount, 2, 'dispatch cannot consume inputs before arrival');
        state = await seed(9641);
        await DB.execute(['UPDATE characters SET level=47,exp=?,clanId=77 WHERE id=?', [Data.experience[46], state.characterId]]);
        state = await Life.upsertState({ ...state, level: 47, exp: Data.experience[46], clanId: 77,
            stats: { ...state.stats, clanId: 77, exp: Data.experience[46],
            equipmentPlan: { strategy: 'luxury_exchange', status: 'active', target: { selfId: 161, slot: 7 },
                exchange: silver, materials: [...silver.materials, { selfId: 90, amount: 2 }] } } }, 'clan_c_chain_fixture');
        state = await Life.applyMarketPurchase(state, { selfId: 90, price: 100, sourceType: 'fixture' }, 2);
        assert(state && Crystals.ready(state), 'a clan member admits its physically bought crystal inputs');
        const clanKit = (await DB.fetchItems(state.characterId)).filter(row => row.equipped);
        const clanCrystals = await townStep(state, crystalCommand);
        assert(clanCrystals.ok);
        assert.equal(clanCrystals.state.stats.lastImprovement.kind, 'crystallize');
        assert(!clanCrystals.state.inventory[90]);
        assert.deepEqual((await DB.fetchItems(state.characterId)).filter(row => row.equipped), clanKit,
            'clan crystallization preserves every worn D item');
        const clanEquipment = await townStep(clanCrystals.state, { kind: 'luxury_exchange', ...silver });
        assert(clanEquipment.ok);
        assert.equal(clanEquipment.state.stats.lastImprovement.kind, 'luxury_exchange');
        assert(clanEquipment.state.inventory[161].equipped, 'the real clan lifecycle chain equips the acquired C weapon');
        assert.equal(clanEquipment.state.adena, state.adena, 'a clan exchange consumes owned crystals without an extra cash charge');
        assert.equal((await DB.fetchClanWarehouseItems(77)).length, 0, 'personal C acquisition never spends the clan warehouse');
        console.log('PASS native early C acquisition/Luxury: deferred wear, protected stash, D-only cost, player costs, rollback, missing inputs, authoritative cold location and stale/repeated command');
    } finally {
        await DB.close(); require('node:fs').rmSync(fixture.directory, { recursive: true, force: true });
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
