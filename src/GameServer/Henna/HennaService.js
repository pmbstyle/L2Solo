const Database = invoke('Database');
const ServerResponse = invoke('GameServer/Network/Response');
const SystemMessage = invoke('GameServer/Network/Response/SystemMessage');
const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const ClassProgression = invoke('GameServer/ClassProgression');

const hennaData = require('../../../data/Henna/c4-henna.json');
const hennaTreeData = require('../../../data/Henna/c4-henna-trees.json');

const SYMBOLS = new Map(hennaData.symbols.map((symbol) => [symbol.id, symbol]));
const TREES = new Map(Object.entries(hennaTreeData.trees).map(([classId, ids]) => [Number(classId), ids]));
const STAT_KEYS = ['STR', 'DEX', 'CON', 'INT', 'WIT', 'MEN'];
const SLOT_COUNT = 3;

const SYSTEM_SYMBOL_ADDED = 877;
const SYSTEM_CANT_DRAW_SYMBOL = 899;
const SYSTEM_EARNED_S2_S1 = 53;

function fetchSlots(session) {
    if (!Array.isArray(session.hennas)) session.hennas = [null, null, null];
    return session.hennas;
}

function symbolOf(session, slot) {
    const symbolId = fetchSlots(session)[slot - 1];
    return symbolId ? SYMBOLS.get(symbolId) : null;
}

function availableFor(session) {
    const ids = TREES.get(Number(session.actor.fetchClassId?.())) || [];
    return ids.map((symbolId) => SYMBOLS.get(symbolId)).filter(Boolean);
}

function fetchDye(session, dyeSelfId) {
    return session.actor.backpack.fetchItemFromSelfId(dyeSelfId) || null;
}

function availableSlots(session) {
    // Lisvus: 1 + ClassId.level(), with three physical storage slots.
    return Math.min(SLOT_COUNT, ClassProgression.lineage(session.actor.fetchClassId?.()).length);
}

function refreshHennaStats(session) {
    const totals = {};
    STAT_KEYS.forEach((stat) => {
        totals[stat] = fetchSlots(session)
            .reduce((total, symbolId) => total + ((symbolId && SYMBOLS.get(symbolId)?.[stat]) || 0), 0);
        // The aggregate bonus is capped; negative penalties remain additive.
        totals[stat] = Math.min(5, totals[stat]);
    });
    session.actor.hennaStats = totals;
    invoke(path.actor).calculateStats(session, session.actor);
    return totals;
}

// Restore persists on the character table, so a missing session row simply means
// the character never drew a tattoo.
function restore(session) {
    return Database.fetchCharacterHennas(session.actor.fetchId()).then((rows) => {
        const slots = [null, null, null];
        rows.forEach((row) => {
            const slot = Number(row.slot);
            const symbol = SYMBOLS.get(Number(row.symbolId));
            if (symbol && slot >= 1 && slot <= SLOT_COUNT) slots[slot - 1] = symbol.id;
        });
        session.hennas = slots;
        refreshHennaStats(session);
        session.dataSendToMe(ServerResponse.hennaInfo(session));
        return slots;
    });
}

function sendHennaList(session) {
    const hennas = availableFor(session).map((symbol) => ({
        symbolId: symbol.id,
        dyeSelfId: symbol.dyeSelfId,
        dyeAmount: symbol.dyeAmount,
        price: symbol.price,
        // The reference client only shows symbols whose dye the player is carrying.
        owned: !!fetchDye(session, symbol.dyeSelfId)
    }));
    session.dataSendToMe(ServerResponse.hennaEquipList(session.actor.backpack.fetchTotalAdena(), hennas));
}

function sendHennaItemInfo(session, symbolId) {
    const symbol = SYMBOLS.get(Number(symbolId));
    if (!symbol) return;
    session.dataSendToMe(ServerResponse.hennaItemInfo(session.actor, symbol, session.actor.backpack.fetchTotalAdena()));
}

function canDraw(session, symbol) {
    if (!symbol) return 'forbidden';
    if (!(TREES.get(Number(session.actor.fetchClassId?.())) || []).includes(symbol.id)) return 'forbidden';
    const dye = fetchDye(session, symbol.dyeSelfId);
    if (!dye || dye.fetchAmount() < symbol.dyeAmount) return 'missing-dye';
    if (session.actor.backpack.fetchTotalAdena() < symbol.price) return 'missing-adena';
    if (fetchSlots(session).filter(Boolean).length >= availableSlots(session)) return 'no-slot';
    return null;
}

function drawSymbol(session, symbolId) {
    const symbol = SYMBOLS.get(Number(symbolId));
    const reason = canDraw(session, symbol);
    if (reason) {
        session.dataSendToMe(SystemMessage(SYSTEM_CANT_DRAW_SYMBOL));
        return false;
    }

    const backpack = session.actor.backpack;
    const dye = fetchDye(session, symbol.dyeSelfId);
    const adena = backpack.fetchItemFromSelfId(57);
    const emptySlot = fetchSlots(session).findIndex((slotSymbolId) => !slotSymbolId);

    backpack.deleteItem(session, dye.fetchId(), symbol.dyeAmount, () => {
        backpack.deleteItem(session, adena.fetchId(), symbol.price, () => {
            session.hennas[emptySlot] = symbol.id;
            refreshHennaStats(session);
            const characterId = session.actor.fetchId();
            Database.setCharacterHenna(characterId, emptySlot + 1, symbol.id)
                .catch((error) => utils.infoWarn('Henna', 'failed to store symbol %s: %s', symbol.id, error.message));
            session.dataSendToMe(ServerResponse.hennaInfo(session));
            session.dataSendToMe(ServerResponse.userInfo(session.actor));
            session.dataSendToMe(SystemMessage(SYSTEM_SYMBOL_ADDED));
        });
    });
    return true;
}

function fetchRemoveList(session) {
    const hennas = [];
    const symbolName = (symbol) => symbol.name;
    for (let slot = 1; slot <= SLOT_COUNT; slot++) {
        const symbol = symbolOf(session, slot);
        if (symbol) hennas.push({ slot, symbolId: symbol.id, name: symbolName(symbol) });
    }
    return hennas;
}

function removeSymbol(session, slot) {
    const symbol = symbolOf(session, Number(slot));
    if (!symbol) return false;

    session.hennas[Number(slot) - 1] = null;
    refreshHennaStats(session);
    const characterId = session.actor.fetchId();
    Database.deleteCharacterHenna(characterId, Number(slot))
        .catch((error) => utils.infoWarn('Henna', 'failed to remove symbol from slot %s: %s', slot, error.message));

    const refund = Math.floor(symbol.dyeAmount / 2);
    World.purchaseItem(session, symbol.dyeSelfId, refund);
    DataCache.fetchItemFromSelfId(symbol.dyeSelfId, (item) => {
        session.dataSendToMe(SystemMessage(SYSTEM_EARNED_S2_S1, item.template.name, refund));
    });
    session.dataSendToMe(ServerResponse.hennaInfo(session));
    session.dataSendToMe(ServerResponse.userInfo(session.actor));
    return true;
}

const HennaService = {
    SLOT_COUNT,
    STAT_KEYS,
    symbol(id) { return SYMBOLS.get(Number(id)) || null; },
    isTattooDye(selfId) { return hennaData.symbols.some((symbol) => symbol.dyeSelfId === Number(selfId)); },
    restore,
    sendHennaList,
    sendHennaItemInfo,
    drawSymbol,
    fetchRemoveList,
    removeSymbol,
    refreshHennaStats,
    availableSlots
};

module.exports = HennaService;
