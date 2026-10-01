const assert = require('assert');

require('../src/Global');

const Database = require('../src/Database');
const Generics = invoke(path.actor);
const Response = invoke('GameServer/Network/Response');
const hennaEquipList = invoke('GameServer/Network/Response/HennaEquipList');
const hennaItemInfo = invoke('GameServer/Network/Response/HennaItemInfo');
const hennaInfo = invoke('GameServer/Network/Response/HennaInfo');

function buildBackpack({ dyeAmount = 0, adena = 0 } = {}) {
    const items = [
        { selfId: 57, amount: adena, objectId: 900 },
        { selfId: 4445, amount: dyeAmount, objectId: 901 }
    ];
    return {
        items,
        fetchItemFromSelfId(selfId) {
            const entry = this.items.find((item) => item.selfId === Number(selfId) && item.amount > 0);
            if (!entry) return null;
            return {
                fetchId: () => entry.objectId,
                fetchAmount: () => entry.amount
            };
        },
        fetchTotalAdena() {
            return this.items.find((item) => item.selfId === 57)?.amount || 0;
        },
        deleteItem(session, id, amount, callback) {
            const entry = this.items.find((item) => item.objectId === id);
            assert(entry && entry.amount >= amount, 'deleteItem must not overdraw the stack');
            entry.amount -= amount;
            callback(entry.selfId);
        }
    };
}

function buildSession({ classId = 4, dyeAmount = 10, adena = 100000 }) {
    const packets = [];
    const session = {
        actor: {
            fetchId: () => 1234,
            fetchClassId: () => classId,
            fetchStr: () => 40,
            fetchDex: () => 30,
            fetchCon: () => 40,
            fetchInt: () => 20,
            fetchWit: () => 20,
            fetchMen: () => 20,
            backpack: buildBackpack({ dyeAmount, adena })
        },
        dataSendToMe: (packet) => packets.push(packet)
    };
    session.packets = packets;
    return session;
}

async function main() {
    // The full stat refresh needs a live actor; the henna hook itself is a
    // plain actor.hennaStats read inside CalculateStats, asserted via totals.
    const originalStats = Generics.calculateStats;
    Generics.calculateStats = () => {};
    // UserInfo needs a fully loaded actor; the henna flow only asserts it is sent.
    const originalUserInfo = Response.userInfo;
    Response.userInfo = () => Buffer.from([0x04]);

    const writes = [];
    const purchases = [];
    const original = {
        fetchCharacterHennas: Database.fetchCharacterHennas,
        setCharacterHenna: Database.setCharacterHenna,
        deleteCharacterHenna: Database.deleteCharacterHenna
    };
    Database.fetchCharacterHennas = () => Promise.resolve([]);
    Database.setCharacterHenna = (characterId, slot, symbolId) => {
        writes.push({ kind: 'upsert', characterId, slot, symbolId });
        return Promise.resolve();
    };
    Database.deleteCharacterHenna = (characterId, slot) => {
        writes.push({ kind: 'delete', characterId, slot });
        return Promise.resolve();
    };
    const World = invoke('GameServer/World/World');
    const originalPurchase = World.purchaseItem;
    World.purchaseItem = (session, selfId, amount) => {
        purchases.push({ selfId, amount });
        return Promise.resolve();
    };
    const DataCache = invoke('GameServer/DataCache');
    const originalFetchItem = DataCache.fetchItemFromSelfId;
    DataCache.fetchItemFromSelfId = (selfId, callback) => callback({ template: { name: `Dye ${selfId}` } });

    let HennaService;
    try {
        HennaService = invoke('GameServer/Henna/HennaService');

        // Knight (classId 4) may draw symbol 1: STR+1, CON-3, dye 4445 x10, 5100 adena.
        const session = buildSession({ classId: 4, dyeAmount: 10, adena: 5100 });
        assert.strictEqual(HennaService.drawSymbol(session, 1), true, 'valid draw must succeed');
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepStrictEqual(writes, [{ kind: 'upsert', characterId: 1234, slot: 1, symbolId: 1 }], 'draw must persist slot one');
        assert.deepStrictEqual(session.hennas, [1, null, null], 'session must track the drawn symbol');
        assert.strictEqual(session.actor.backpack.items.find((i) => i.selfId === 4445).amount, 0, 'dye must be consumed');
        assert.strictEqual(session.actor.backpack.items.find((i) => i.selfId === 57).amount, 0, 'adena must be consumed');
        assert.deepStrictEqual(
            session.actor.hennaStats,
            { STR: 1, DEX: 0, CON: -3, INT: 0, WIT: 0, MEN: 0 },
            'henna deltas must be applied to the actor'
        );
        assert.ok(session.packets.some((p) => p[0] === 0xe4), 'draw must refresh HennaInfo');
        assert.ok(session.packets.some((p) => p[0] === 0x04), 'draw must refresh UserInfo');
        assert.ok(session.packets.some((p) => p[0] === 0x64 && p.readInt32LE(1) === 877), 'draw must report symbol added');

        // Class tree gate: a Knight may not draw the mage-oriented symbol 7.
        const blocked = buildSession({ classId: 4, dyeAmount: 10, adena: 100000 });
        assert.strictEqual(HennaService.symbol(7).STR, 0, 'symbol 7 is not a STR symbol');
        assert.strictEqual(HennaService.drawSymbol(blocked, 7), false, 'class tree must block forbidden symbols');
        assert.ok(blocked.packets.some((p) => p[0] === 0x64 && p.readInt32LE(1) === 899), 'forbidden draw must report 899');
        assert.ok(!blocked.hennas || !blocked.hennas.some(Boolean), 'blocked draw must not fill a slot');

        // Dye amount gate.
        const noDye = buildSession({ classId: 4, dyeAmount: 9, adena: 100000 });
        assert.strictEqual(HennaService.drawSymbol(noDye, 1), false, 'nine dyes must not be enough');

        // Adena gate.
        const poor = buildSession({ classId: 4, dyeAmount: 10, adena: 5099 });
        assert.strictEqual(HennaService.drawSymbol(poor, 1), false, 'short adena must not draw');

        // Slot cap: three symbols max.
        const full = buildSession({ classId: 4, dyeAmount: 10, adena: 100000 });
        full.hennas = [1, 2, 3];
        assert.strictEqual(HennaService.drawSymbol(full, 4), false, 'a fourth symbol must be refused');
        assert.ok(full.packets.some((p) => p[0] === 0x64 && p.readInt32LE(1) === 899));

        // Packet shapes (reference layouts).
        const listPacket = hennaEquipList(7000, [
            { symbolId: 1, dyeSelfId: 4445, dyeAmount: 10, price: 5100, owned: true },
            { symbolId: 2, dyeSelfId: 4446, dyeAmount: 10, price: 5100, owned: false }
        ]);
        assert.strictEqual(listPacket[0], 0xe2);
        assert.strictEqual(listPacket.readInt32LE(1), 7000, 'E2 starts with adena');
        assert.strictEqual(listPacket.readInt32LE(5), 3, 'E2 reports three slots');
        assert.strictEqual(listPacket.readInt32LE(9), 2, 'E2 reports the symbol count');
        assert.strictEqual(listPacket.readInt32LE(13), 1, 'owned symbol exposes the id');
        assert.strictEqual(listPacket.readInt32LE(17), 4445, 'owned symbol exposes the dye');
        assert.strictEqual(listPacket.readInt32LE(33), 0, 'unowned symbol is a zero row');

        const preview = hennaItemInfo({
            fetchInt: () => 21, fetchStr: () => 40, fetchCon: () => 40,
            fetchMen: () => 20, fetchDex: () => 30, fetchWit: () => 20
        }, HennaService.symbol(1), 12345);
        assert.strictEqual(preview.readInt32LE(1), 1, 'E3 starts with the symbol id');
        assert.strictEqual(preview.readInt32LE(5), 4445);
        assert.strictEqual(preview.readInt32LE(25), 21, 'E3 writes the base INT as D');
        assert.strictEqual(preview[29], 21, 'E3 previews INT unchanged');
        assert.strictEqual(preview.readInt32LE(30), 40, 'E3 writes the base STR as D');
        assert.strictEqual(preview[34], 41, 'E3 previews STR with the +1 delta');

        const summary = buildSession({ classId: 4 });
        summary.hennas = [1, 180, null];
        summary.actor.hennaStats = { INT: 0, STR: 1, CON: -3, MEN: -4, DEX: 0, WIT: 4 };
        const infoPacket = hennaInfo(summary);
        assert.strictEqual(infoPacket[0], 0xe4);
        assert.strictEqual(infoPacket[1], 0, 'E4 writes the INT total first');
        assert.strictEqual(infoPacket[2], 1, 'E4 writes the STR total second');
        assert.strictEqual(infoPacket[3], 253, 'negative henna totals are signed bytes');
        assert.strictEqual(infoPacket.readInt32LE(7), 3, 'E4 keeps the slot count');
        assert.strictEqual(infoPacket.readInt32LE(11), 2, 'E4 counts only drawn symbols');
        assert.strictEqual(infoPacket.readInt32LE(15), 1);
        assert.strictEqual(infoPacket.readInt32LE(19), 1);
        assert.strictEqual(infoPacket.readInt32LE(23), 180);
        assert.strictEqual(infoPacket.readInt32LE(27), 180);

        // Restore places saved symbols and recomputes stats.
        Database.fetchCharacterHennas = () => Promise.resolve([{ slot: 2, symbolId: 1 }]);
        const login = buildSession({ classId: 4, dyeAmount: 0, adena: 0 });
        await HennaService.restore(login);
        assert.deepStrictEqual(login.hennas, [null, 1, null], 'restore must place saved symbols in slots');
        assert.strictEqual(login.actor.hennaStats.STR, 1, 'restore must recompute henna stats');
        assert.ok(login.packets.some((p) => p[0] === 0xe4), 'restore must refresh HennaInfo');

        // Remove refunds half the dye and reports it.
        Database.fetchCharacterHennas = original.fetchCharacterHennas;
        const refund = buildSession({ classId: 4, dyeAmount: 0, adena: 0 });
        refund.hennas = [null, 1, null];
        assert.strictEqual(HennaService.removeSymbol(refund, 2), true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(writes.some((entry) => entry.kind === 'delete' && entry.slot === 2), 'remove must persist the slot clear');
        assert.strictEqual(refund.actor.hennaStats.STR, 0, 'remove must drop the delta');
        assert.deepStrictEqual(purchases, [{ selfId: 4445, amount: 5 }], 'remove must refund half of the dye');
        assert.ok(
            refund.packets.filter((p) => p[0] === 0x64).some((p) => p.readInt32LE(1) === 53),
            'remove must report the dye refund'
        );

        // Slot count follows class ancestry, not character level. Packet/storage
        // layouts retain three slots, as in C4; existing saved symbols survive.
        const ClassProgression = invoke('GameServer/ClassProgression');
        for (const root of Object.keys(ClassProgression.firstProfMap)) {
            assert.strictEqual(HennaService.availableSlots(buildSession({ classId: Number(root) })), 1);
        }
        for (const first of Object.keys(ClassProgression.secondProfMap)) {
            const firstSession = buildSession({ classId: Number(first) });
            assert.strictEqual(HennaService.availableSlots(firstSession), 2);
        }
        for (const second of Object.values(ClassProgression.secondProfMap).flat()) {
            assert.strictEqual(HennaService.availableSlots(buildSession({ classId: second })), 3);
        }
        for (const third of Object.keys(ClassProgression.thirdClasses)) {
            assert.strictEqual(HennaService.availableSlots(buildSession({ classId: Number(third) })), 3);
        }
        const firstProfession = buildSession({ classId: 4, dyeAmount: 30, adena: 15300 });
        assert.strictEqual(HennaService.drawSymbol(firstProfession, 1), true);
        assert.strictEqual(HennaService.drawSymbol(firstProfession, 1), true, 'repeated symbols remain allowed');
        assert.strictEqual(HennaService.drawSymbol(firstProfession, 1), false, 'first profession must reject a third symbol');
        assert.strictEqual(firstProfession.actor.backpack.fetchItemFromSelfId(4445).fetchAmount(), 10, 'rejected draw must not consume dyes');
        assert.strictEqual(firstProfession.actor.backpack.fetchTotalAdena(), 5100, 'rejected draw must not consume adena');

        const capped = buildSession({ classId: 5, dyeAmount: 30, adena: 435000 });
        capped.actor.backpack.items.find((item) => item.selfId === 4445).selfId = 4613;
        assert.strictEqual(HennaService.drawSymbol(capped, 169), true);
        assert.strictEqual(HennaService.drawSymbol(capped, 169), true, 'installation above the effective +5 cap remains allowed');
        assert.strictEqual(capped.actor.hennaStats.STR, 5, 'two STR+4 symbols must yield +5');
        assert.strictEqual(capped.actor.hennaStats.CON, -8, 'two CON-4 penalties must yield -8');
        assert.strictEqual(HennaService.drawSymbol(capped, 169), true, 'second profession supports three repeated symbols');
        assert.strictEqual(capped.actor.hennaStats.STR, 5);
        assert.strictEqual(capped.actor.hennaStats.CON, -12);
        assert.strictEqual(hennaInfo(capped).readInt8(2), 5, 'HennaInfo must expose the capped STR bonus');
        assert.strictEqual(hennaInfo(capped).readInt8(3), -12, 'HennaInfo must preserve the full CON penalty');
        Database.fetchCharacterHennas = () => Promise.resolve([1, 2, 3].map((slot) => ({ slot, symbolId: 169 })));
        const restoredCap = buildSession({ classId: 5, dyeAmount: 0, adena: 0 });
        await HennaService.restore(restoredCap);
        assert.deepStrictEqual(restoredCap.hennas, [169, 169, 169], 'restore preserves repeated symbols');
        assert.strictEqual(restoredCap.actor.hennaStats.STR, 5, 'restore must apply the cap');
        assert.strictEqual(restoredCap.actor.hennaStats.CON, -12, 'restore must preserve all penalties');
        assert.strictEqual(HennaService.removeSymbol(restoredCap, 3), true);
        assert.strictEqual(restoredCap.actor.hennaStats.STR, 5, 'removing one of three leaves a capped bonus');
        assert.strictEqual(restoredCap.actor.hennaStats.CON, -8);
        assert.strictEqual(HennaService.removeSymbol(restoredCap, 2), true);
        assert.strictEqual(restoredCap.actor.hennaStats.STR, 4, 'removing another must recompute below the cap');
        assert.strictEqual(restoredCap.actor.hennaStats.CON, -4);

        // Every base stat uses the same positive-only aggregate cap.
        for (const stat of HennaService.STAT_KEYS) {
            const high = require('../data/Henna/c4-henna.json').symbols.find((symbol) => symbol[stat] === 4);
            assert(high, `C4 data must include a +4 ${stat} symbol`);
            restoredCap.hennas = [high.id, high.id, high.id];
            assert.strictEqual(HennaService.refreshHennaStats(restoredCap)[stat], 5, `${stat} aggregate bonus must be capped`);
        }
    } finally {
        Generics.calculateStats = originalStats;
        Response.userInfo = originalUserInfo;
        World.purchaseItem = originalPurchase;
        DataCache.fetchItemFromSelfId = originalFetchItem;
        Object.assign(Database, original);
    }
}

// All 10 official C4 symbol makers must be defined, spawned, and offer the henna bypass.
const fs = require('fs');
[
    ...require('../data/Npcs/c4_symbol_makers.json'),
    ...require('../data/Npcs/c4_goddard_rune.json').filter((npc) => npc.selfId === 8264 || npc.selfId === 8308)
].forEach((npc) => {
    assert.strictEqual(npc.template.kind, 'SymbolMaker', `npc ${npc.selfId} should be a SymbolMaker`);
    assert.ok(npc.template.name, `npc ${npc.selfId} should have a name`);
    const html = fs.readFileSync(`data/Html/${npc.selfId}.html`, 'utf8');
    assert.ok(html.includes('bypass -h henna"'), `symbol maker ${npc.selfId} dialog should offer the henna bypass`);
    assert.ok(html.includes('bypass -h henna-remove"'), `symbol maker ${npc.selfId} dialog should offer tattoo removal`);
});
const symbolMakerSpawns = [
    ...require('../data/Npcs/Spawns/c4_symbol_makers.json').flatMap((region) => region.spawns),
    ...require('../data/Npcs/Spawns/c4_goddard_rune.json').flatMap((region) => region.spawns)
];
for (let selfId = 8046; selfId <= 8053; selfId++) {
    assert.ok(symbolMakerSpawns.some((spawn) => spawn.selfId === selfId), `symbol maker ${selfId} should have a spawn spot`);
}

// Drawn dyes must move real combat stats: CalculateStats reads actor.hennaStats
// as base, so a +STR/-CON symbol must lift pAtk and sink maxHp, maxCp, and maxLoad.
function verifyHennaStatEffects() {
    const HennaService = invoke('GameServer/Henna/HennaService');
    const Formulas = invoke('GameServer/Formulas');
    const symbols = require('../data/Henna/c4-henna.json').symbols;
    const strong = symbols.find((symbol) => symbol.STR > 0 && symbol.CON < 0);
    const swift = symbols.find((symbol) => symbol.DEX > 0 && symbol.STR <= 0);
    assert.ok(strong && swift, 'c4 henna data should carry a STR/CON symbol and a DEX symbol');

    const fighter = {
        level: 20,
        classId: 1,
        hp: 100,
        mp: 100,
        cp: 0,
        effects: {},
        hennaStats: {},
        fetchLevel() { return this.level; },
        fetchClassId() { return this.classId; },
        fetchCon() { return 43; },
        fetchMen() { return 25; },
        fetchStr() { return 40; },
        fetchDex() { return 30; },
        fetchInt() { return 21; },
        fetchWit() { return 11; },
        fetchHp() { return this.hp; },
        fetchMp() { return this.mp; },
        fetchCp() { return this.cp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMaxMp() { return this.maxMp; },
        fetchMaxCp() { return this.maxCp; },
        fetchPAtk() { return 4; },
        fetchMAtk() { return 6; },
        fetchPDef() { return 80; },
        fetchMDef() { return 41; },
        fetchAccur() { return 0; },
        fetchEvasion() { return 0; },
        fetchCritical() { return 40; },
        fetchAtkSpd() { return 300; },
        fetchWalkSpd() { return 80; },
        fetchRunSpd() { return 115; },
        isSpellcaster() { return 0; },
        setMaxHp(value) { this.maxHp = value; },
        setHp(value) { this.hp = value; },
        setMaxMp(value) { this.maxMp = value; },
        setMp(value) { this.mp = value; },
        setMaxCp(value) { this.maxCp = value; },
        setCp(value) { this.cp = value; },
        setMaxLoad(value) { this.maxLoad = value; },
        setLoad(value) { this.load = value; },
        setCollectivePAtk(value) { this.collectivePAtk = value; },
        setCollectiveMAtk(value) { this.collectiveMAtk = value; },
        setCollectivePDef(value) { this.collectivePDef = value; },
        setCollectiveMDef(value) { this.collectiveMDef = value; },
        setCollectiveAccur(value) { this.collectiveAccur = value; },
        setCollectiveEvasion(value) { this.collectiveEvasion = value; },
        setCollectiveCritical(value) { this.collectiveCritical = value; },
        setCollectiveAtkSpd(value) { this.collectiveAtkSpd = value; },
        setCollectiveCastSpd(value) { this.collectiveCastSpd = value; },
        setCollectiveWalkSpd(value) { this.collectiveWalkSpd = value; },
        setCollectiveRunSpd(value) { this.collectiveRunSpd = value; },
        backpack: {
            fetchTotalArmorBonusMp: () => 0,
            fetchTotalLoad: () => 0,
            fetchTotalWeaponPAtk: () => 120,
            fetchTotalWeaponMAtk: () => 6,
            fetchTotalArmorPDef: () => 76,
            fetchTotalArmorMDef: () => 41,
            fetchTotalWeaponAccur: () => 0,
            fetchTotalArmorEvasion: () => 0,
            fetchTotalWeaponCritical: () => 40,
            fetchTotalWeaponAtkSpd: () => 300
        }
    };

    const session = { hennas: [null, null, null], actor: fighter };
    invoke(path.actor).calculateStats(session, fighter);
    const baseline = {
        pAtk: fighter.collectivePAtk,
        critical: fighter.collectiveCritical,
        maxHp: fighter.maxHp,
        maxCp: fighter.maxCp,
        maxLoad: fighter.maxLoad
    };
    assert.strictEqual(baseline.pAtk, Math.round(Formulas.calcPAtk(20, 40, 120)), 'plain pAtk should match the sourced formula');

    // A +STR/-CON symbol must flow through CalculateStats as a base-stat rewrite:
    // pAtk equals the formula recomputed with the tattooed STR, hp/cp/load sink.
    session.hennas = [strong.id, null, null];
    const totals = HennaService.refreshHennaStats(session);
    assert.strictEqual(totals.STR, strong.STR, `${strong.name} should add its STR delta`);
    assert.strictEqual(totals.CON, strong.CON, `${strong.name} should add its CON delta`);
    assert.strictEqual(
        fighter.collectivePAtk,
        Math.round(Formulas.calcPAtk(20, 40 + strong.STR, 120)),
        `${strong.name} (+STR) should lift pAtk to the tattooed formula value`
    );
    assert.ok(fighter.maxHp < baseline.maxHp, `${strong.name} (-CON) must sink maxHp`);
    assert.ok(fighter.maxCp < baseline.maxCp, `${strong.name} (-CON) must sink maxCp`);
    assert.ok(fighter.maxLoad < baseline.maxLoad, `${strong.name} (-CON) must sink maxLoad`);

    // DEX symbols are read by the combat formulas too (critical scales 4 per DEX).
    session.hennas = [swift.id, null, null];
    HennaService.refreshHennaStats(session);
    assert.ok(
        fighter.collectiveCritical > baseline.critical,
        `${swift.name} (+DEX) must lift critical rate above the base ${baseline.critical}`
    );

    // Two drawn symbols stack additively, and clearing the slots restores the baseline.
    session.hennas = [strong.id, swift.id, null];
    const stacked = HennaService.refreshHennaStats(session);
    ['INT', 'STR', 'CON', 'MEN', 'DEX', 'WIT'].forEach((stat) => {
        assert.strictEqual(stacked[stat], Math.min(5, strong[stat] + swift[stat]), `stacked ${stat} totals must respect the positive cap`);
    });

    session.hennas = [169, 169, 169];
    const cappedStats = HennaService.refreshHennaStats(session);
    assert.strictEqual(cappedStats.STR, 5);
    assert.strictEqual(cappedStats.CON, -12);
    assert.strictEqual(fighter.collectivePAtk, Math.round(Formulas.calcPAtk(20, 45, 120)), 'combat formulas must use capped STR');
    const normalCon = fighter.fetchCon;
    fighter.fetchCon = () => 1;
    HennaService.refreshHennaStats(session);
    assert.strictEqual(fighter.maxHp, Formulas.calcHp(20, 1, 1), 'final CON must remain at least one despite the full penalty');
    fighter.fetchCon = normalCon;

    session.hennas = [null, null, null];
    HennaService.refreshHennaStats(session);
    assert.strictEqual(fighter.collectivePAtk, baseline.pAtk, 'removing all symbols must restore pAtk');
    assert.strictEqual(fighter.collectiveCritical, baseline.critical, 'removing all symbols must restore critical');
    assert.strictEqual(fighter.maxHp, baseline.maxHp, 'removing all symbols must restore maxHp');
    assert.strictEqual(fighter.maxCp, baseline.maxCp, 'removing all symbols must restore maxCp');
    assert.strictEqual(fighter.maxLoad, baseline.maxLoad, 'removing all symbols must restore maxLoad');
}

main().then(() => {
    verifyHennaStatEffects();
    console.log('Henna tests passed');
});
