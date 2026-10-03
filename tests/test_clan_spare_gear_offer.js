const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

require('../src/Global');

// Spare gear goes to a clanmate first: a member's newly spare wearable item
// goes into the clan warehouse when a clanmate would wear it, never toward an
// enemy; the clan compensates 0-25% of its price by the giver's generosity.
// The clan warehouse exchange then hands it out.
const rootDir = path.resolve(__dirname, '..');
const databasePath = path.join(rootDir, 'tmp', 'test-clan-spare-gear-offer.sqlite');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Personas = invoke('GameServer/Bot/AI/BotPersona');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Warehouse = invoke('GameServer/Clan/ClanWarehouseService');
const Goals = invoke('GameServer/Clan/ClanGoalService');
const ItemDisposition = invoke('GameServer/Bot/Economy/ItemDisposition');

const EARRING = 847;
const generous = { sociability: 0.9, commitment: 0.9, caution: 0.5, ambition: 0.5, assertiveness: 0.5, empathy: 0.9, resilience: 0.5 };
const stingy = { sociability: 0.3, commitment: 0.3, caution: 0.5, ambition: 0.8, assertiveness: 0.5, empathy: 0.3, resilience: 0.5 };

function seed(clans) {
    [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach((file) => fs.rmSync(file, { force: true }));
    const db = new DatabaseSync(databasePath);
    db.exec(fs.readFileSync(path.join(rootDir, 'database', 'sql', 'sqlite.sql'), 'utf8'));
    db.prepare('INSERT INTO accounts(username, password) VALUES (?, ?)').run('bot_pop_gear', 'test-only');
    for (const { clanId, giver, mate, traits, worker } of clans) {
        db.prepare('INSERT INTO clans(id, name, level, leaderId) VALUES (?, ?, 2, ?)').run(clanId, `Gear${clanId}`, mate);
        db.prepare(`INSERT INTO clan_simulation_clans(clanId, mode, stateJson, createdAt, updatedAt)
            VALUES (?, 'autonomous', '{"mode":"autonomous","warehouseRevision":0}', 0, 0)`).run(clanId);
        db.prepare(`INSERT INTO clan_warehouse_items(clanId, selfId, name, kind, amount, enchant, reservedAmount)
            VALUES (?, 57, 'Adena', 'Other.Currency', 1000000, 0, 0)`).run(clanId);
        for (const id of [giver, mate]) {
            const giving = id === giver;
            db.prepare(`INSERT INTO characters(id, username, name, classId, race, level, maxHp, maxMp, sex, face, hair, hairColor,
                locX, locY, locZ, clanId) VALUES (?, 'bot_pop_gear', ?, 0, 0, 30, 500, 250, 0, 0, 0, 0, 0, 0, 0, ?)`).run(id, `Gear${id}`, clanId);
            const inventory = giving ? { [EARRING]: { selfId: EARRING, amount: 1, equippedCount: 1, name: 'Red Crescent Earring' } } : {};
            db.prepare(`INSERT INTO bot_life_state(characterId, accountName, characterName, level, adena, activity, phase,
                simulationOwner, inventorySummary, statsJson, updatedAt) VALUES (?, 'bot_pop_gear', ?, 30, 0, 'hunting', 'cold', ?, ?, '{"classId":0}', 1)`)
                .run(id, `Gear${id}`, giving && worker ? 'cold_simulation_owner' : 'legacy_main', JSON.stringify(inventory));
            db.prepare(`INSERT INTO bot_personas(characterId, version, seed, primaryDrive, archetype, traitsJson, textCard, createdAt, updatedAt)
                VALUES (?, 1, 1, 'social', 'party_regular', ?, '', 0, 0)`).run(id, JSON.stringify(giving ? traits : generous));
            if (giving) {
                db.prepare(`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId) VALUES (?, 'Red Crescent Earring', 1, 0, 1, 1, ?)`).run(EARRING, id);
            }
        }
    }
    db.close();
}

async function main() {
    DataCache.init();
    const clans = [
        { clanId: 81, giver: 4800001, mate: 4800002, traits: generous },
        { clanId: 82, giver: 4800011, mate: 4800012, traits: stingy },
        { clanId: 83, giver: 4800021, mate: 4800022, traits: generous },
        { clanId: 84, giver: 4800031, mate: 4800032, traits: stingy, worker: true }
    ];
    seed(clans);
    options.default.Database.path = path.relative(rootDir, databasePath);
    Database.init();
    await Database.initClanHalls();
    await LifeState.init();
    for (const { giver, mate } of clans) { await Personas.load(giver); await Personas.load(mate); }
    // The third giver hates its only clanmate.
    Memory.accept({ version: 1, ownerId: 4800021, revision: 1, replayFloor: 0, recent: [], relations: [{
        kind: 'character', targetId: 4800022, at: Date.now(), order: 1,
        affinity: -20, trust: -20, hostility: 30, fear: 0, familiarity: 3, reasons: [{ type: 'attacked', at: Date.now() }]
    }] });
    const spare = async (id) => Number((await Database.execute(['SELECT COUNT(*) AS n FROM items WHERE characterId = ? AND selfId = ?', [id, EARRING]]))[0].n);
    const stored = async (clanId) => Number((await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM clan_warehouse_items WHERE clanId = ? AND selfId = ?', [clanId, EARRING]]))[0].n);
    const adena = async (clanId) => Number((await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM clan_warehouse_items WHERE clanId = ? AND selfId = 57', [clanId]]))[0].n);
    const wallet = async (id) => Number((await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS n FROM items WHERE characterId = ? AND selfId = 57', [id]]))[0].n);
    try {
        // First pass: the members' spare gear is recorded, nothing is offered.
        for (const { clanId } of clans) await Warehouse.resolveClan(await Goals.clanProjectionById(clanId));
        assert.strictEqual(await stored(81), 0);
        // Then each giver loots a second earring.
        for (const { giver } of clans) {
            await Database.execute([`INSERT INTO items(selfId, name, amount, enchant, equipped, slot, characterId)
                VALUES (?, 'Red Crescent Earring', 1, 0, 0, 0, ?)`, [EARRING, giver]]);
            await Database.execute([`UPDATE bot_life_state SET inventorySummary = json_set(inventorySummary, '$."${EARRING}".amount', 2),
                simulationRevision = simulationRevision + 1 WHERE characterId = ?`, [giver]]);
            LifeState.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId = ?', [giver]]))[0]);
        }
        const priceOf = async (clanId, giver) => {
            const member = (await Goals.clanProjectionById(clanId)).members.find((entry) => entry.characterId === giver);
            return ItemDisposition.saleCandidates(member, { unlimited: true }).find((item) => item.selfId === EARRING).price;
        };
        const stingyPrice = await priceOf(82, 4800011);
        for (const { clanId } of clans) await Warehouse.resolveClan(await Goals.clanProjectionById(clanId));

        assert.strictEqual(await stored(81), 1, 'a generous member gives its spare earring to the clan');
        assert.strictEqual(await spare(4800001), 1, 'it keeps the worn one');
        assert.strictEqual(await adena(81), 1000000, 'a gift costs the clan nothing');

        assert.strictEqual(await stored(82), 1, 'a stingy member gives it too');
        assert.strictEqual(await wallet(4800011), Math.floor(stingyPrice * 0.25), 'and gets 25% of its price');
        assert.strictEqual(await adena(82), 1000000 - Math.floor(stingyPrice * 0.25));

        assert.strictEqual(await stored(83), 0, 'nothing goes to an enemy');
        assert.strictEqual(await spare(4800021), 2);

        assert.strictEqual(await stored(84), 1, 'a member owned by the cold worker gives its earring');
        const [worker] = await Database.execute(['SELECT adena FROM bot_life_state WHERE characterId = 4800031']);
        assert(Number(worker.adena) > 0, 'and is paid through its worker snapshot');

        // An item seen at the previous pass is not offered again.
        await Database.execute(["DELETE FROM clan_warehouse_items WHERE clanId = 83 AND selfId = ?", [EARRING]]);
        Memory.accept({ version: 1, ownerId: 4800021, revision: 2, replayFloor: 0, recent: [], relations: [] });
        await Warehouse.resolveClan(await Goals.clanProjectionById(83));
        assert.strictEqual(await stored(83), 0, 'only newly spare gear is offered');
        console.log('Clan spare gear offer checks passed');
    } finally {
        await Database.close();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
