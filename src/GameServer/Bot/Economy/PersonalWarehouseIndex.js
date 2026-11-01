'use strict';
const { isMainThread } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const CONTENT_IDENTITY = Symbol('warehouse_content_identity');
const EMPTY_IDENTITY = createHash('sha256').update('[]').digest('hex');
let ItemTemplateIndex = null;
const records = new Map(), pending = new Set();
let source = id => records.get(id), initialized = false, draining = false, revision = 0;
let ready = null;
let sourceReady = () => initialized;
const LIMIT = 64;
function prepareRow(row) {
    const valid = Array.isArray(row) && row.length === 3 && Number.isSafeInteger(row[0]) && row[0] > 0
        && Array.isArray(row[2]) && row[2].length <= LIMIT && row[2].every(value => Array.isArray(value)
            && value.length === 3 && Number.isSafeInteger(value[0]) && value[0] > 0
            && Number.isFinite(value[1]) && value[1] > 0 && Number.isSafeInteger(value[2]) && value[2] >= 0);
    if (!valid) { if (row && typeof row === 'object') delete row[CONTENT_IDENTITY]; return row; }
    if (!Object.hasOwn(row, CONTENT_IDENTITY)) Object.defineProperty(row, CONTENT_IDENTITY,
        { configurable: true, value: createHash('sha256').update(JSON.stringify(row[2])).digest('hex') });
    return row;
}
function publish(id, rows) {
    const quantities = new Map();
    for (const item of rows) {
        const key = `${item.selfId}:${Number(item.enchant || 0)}`;
        const row = quantities.get(key) || [Number(item.selfId), 0, Number(item.enchant || 0)];
        row[1] += Math.max(0, Number(item.amount) || 0); quantities.set(key, row);
    }
    const values = [...quantities.values()].filter(row => row[1] > 0).slice(0, LIMIT);
    if (JSON.stringify(records.get(id)?.[2] || []) === JSON.stringify(values)) return;
    const row = prepareRow([id, ++revision, values]);
    records.set(id, row);
    require('../Population/ColdTableChannel').shared.changed('personal_warehouse', row);
}
async function drain() {
    if (draining || !initialized) return;
    draining = true;
    try {
        const Database = invoke('Database');
        for (const id of [...pending].slice(0, 8)) {
            pending.delete(id);
            publish(id, await Database.fetchWarehouseItems(id));
        }
    } catch (error) { utils.infoWarn('BotWarehouse', 'asset projection: %s', error.message); }
    finally {
        draining = false;
        if (pending.size) setImmediate(drain);
    }
}
async function init() {
    if (!isMainThread || initialized) return;
    if (ready) return ready;
    ready = initialize();
    return ready;
}
async function initialize() {
    const rows = await invoke('Database').execute([`SELECT stock.characterId, stock.selfId, stock.enchant, SUM(stock.amount) AS amount
        FROM warehouse_items stock JOIN bot_life_state life ON life.characterId = stock.characterId
        WHERE stock.amount > 0 GROUP BY stock.characterId, stock.selfId, stock.enchant ORDER BY stock.characterId, stock.selfId`, []], 'warehouse:asset-projection');
    const byOwner = new Map();
    for (const row of rows) {
        const list = byOwner.get(Number(row.characterId)) || [];
        if (list.length < LIMIT) list.push(row);
        byOwner.set(Number(row.characterId), list);
    }
    for (const [id, items] of byOwner) publish(id, items);
    initialized = true;
    // lazy: worker only the main warehouse projection publishes readiness.
    require('../Population/ColdTableChannel').shared.flush();
    void drain();
}
function inventory(state) {
    const row = source(Number(state?.characterId));
    const Data = invoke('GameServer/DataCache'), Index = ItemTemplateIndex ||= require('../../Item/ItemTemplateIndex');
    const result = {};
    for (const [id, amount, enchant] of row?.[2] || []) {
        const item = Index.find(Data.items, id);
        if (!item) continue;
        const old = result[id];
        result[id] = { selfId: id, amount: amount + Number(old?.amount || 0), name: item.template.name,
            kind: item.template.kind, rank: item.etc?.rank, stackable: item.etc?.stackable,
            equipped: false, equippedCount: 0, slot: 0, enchant: Math.max(enchant, Number(old?.enchant || 0)),
            ...(item.etc?.stackable !== true ? { instances: [...(old?.instances || []),
                { id: 0, amount, enchant, equipped: false }] } : {}) };
    }
    return result;
}
if (isMainThread) require('../Population/ColdTableChannel').shared.register('personal_warehouse', {
    key: row => row[0], allRows: () => records.values(), eventDriven: true, ready: () => initialized
});
module.exports = { init, inventory, LIMIT, prepareRow,
    ready() { return sourceReady() === true; },
    contentIdentity(state) {
        if (sourceReady() !== true) return null;
        const row = source(Number(state?.characterId));
        return row ? row[CONTENT_IDENTITY] ?? null : EMPTY_IDENTITY;
    },
    saleState(state) {
        const stored = inventory(state), bag = { ...state.inventory };
        for (const [id, item] of Object.entries(stored)) {
            const held = bag[id];
            bag[id] = { ...item, ...held, amount: Number(held?.amount || 0) + item.amount,
                ...(item.instances ? { instances: [...(held?.instances || (held ? [{ id: 0, amount: held.amount,
                    enchant: held.enchant || 0, equipped: held.equipped }] : [])), ...item.instances] } : {}) };
        }
        return { ...state, inventory: bag };
    },
    version(state) { return Number(source(Number(state?.characterId))?.[1] || 0); },
    hasItems(state) { return !!source(Number(state?.characterId))?.[2]?.length; },
    changed(id) { if (isMainThread) { pending.add(Number(id)); if (initialized) setImmediate(drain); } },
    useRowSource(reader, isReady) {
        source = reader || (id => records.get(id));
        sourceReady = reader ? (isReady || (() => false)) : () => initialized;
    } };
