'use strict';
const InventorySummary = require('./GameServer/Bot/Population/InventorySummary');

// Run before actors load. Keep the original object ID (and its paperdoll
// references), and expand hidden equipment counts into unequipped copies.
// Pet identities are excluded: they cannot be reconstructed from a count.
function create({ all, write, inTransaction, bagRevisionSet, now }) {
    function repairColdSnapshots(splits) {
        for (const [characterId, splitIds] of splits) {
            const [row] = all(`SELECT inventorySummary FROM bot_life_state WHERE characterId = ? AND phase = 'cold'`, [characterId]);
            if (!row) continue;
            const inventory = InventorySummary.read(row.inventorySummary);
            let changed = false;
            for (const item of Object.values(inventory)) {
                const hasInstances = Array.isArray(item.instances);
                // A cold loot merge could lose the instance list altogether.
                // Bind that legacy count to the same repaired physical copies.
                if (!hasInstances && ![...splitIds.values()].some(split => split.selfId === Number(item.selfId))) continue;
                let itemChanged = !hasInstances;
                let source = item;
                if (!hasInstances) {
                    // The count also includes untouched single copies. Bind all
                    // physical identities before completing pending +0 loot.
                    const copies = all(`SELECT id, enchant, equipped, slot FROM items
                        WHERE characterId = ? AND selfId = ? ORDER BY id`, [characterId, Number(item.selfId)]);
                    const worn = copies.filter(copy => copy.equipped && Number(copy.slot) > 0).map(copy => Number(copy.slot));
                    const equippedSlots = Array.isArray(item.equippedSlots) ? item.equippedSlots
                        : item.equipped === false || item.equippedCount === 0 ? []
                            : worn.length ? worn : item.equipped && Number(item.slot) > 0 ? [Number(item.slot)] : [];
                    source = { ...item, equippedSlots, instances: copies.map(copy => ({
                        id: Number(copy.id), amount: 1, enchant: Number(copy.enchant || 0),
                        equipped: !!copy.equipped, slot: Number(copy.slot || 0)
                    })) };
                }
                const instances = source.instances.flatMap(instance => {
                    const split = splitIds.get(Number(instance.id));
                    if (!split || !(Number(instance.amount) > 1)) return [instance];
                    itemChanged = true;
                    return split.ids.slice(0, Number(instance.amount)).map((id, index) => ({
                        ...instance, id, amount: 1,
                        equipped: index === 0 && !!instance.equipped,
                        slot: index === 0 ? instance.slot : 0
                    }));
                });
                // Keep the cold count, including pending unmaterialized loot.
                // Older saves may already have expanded a stack into anonymous
                // +0 placeholders. Bind those to the repaired physical copies
                // before hydration can mistake them for newly acquired loot.
                let repaired = InventorySummary.completeInstances({ ...source, stackable: false, instances });
                const heldIds = new Set(repaired.instances.map(instance => Number(instance.id)).filter(Boolean));
                for (const split of splitIds.values()) {
                    if (Number(item.selfId) !== split.selfId) continue;
                    for (const id of split.ids) {
                        if (heldIds.has(id)) continue;
                        const placeholder = repaired.instances.find(instance => !instance.id && !Number(instance.enchant))
                            || repaired.instances.find(instance => !instance.id);
                        if (!placeholder) break;
                        placeholder.id = id;
                        placeholder.enchant = split.enchant;
                        heldIds.add(id);
                        itemChanged = true;
                    }
                }
                if (itemChanged) {
                    if (!hasInstances) {
                        const equippedSlots = repaired.instances.filter(copy => copy.equipped).map(copy => copy.slot);
                        repaired = { ...repaired, equipped: equippedSlots.length > 0,
                            equippedCount: equippedSlots.length, equippedSlots,
                            slot: Number(item.slot || equippedSlots[0] || 0) };
                    }
                    inventory[String(item.selfId)] = InventorySummary.completeInstances(repaired);
                    changed = true;
                }
            }
            if (!changed) continue;
            const summary = InventorySummary.saved(inventory);
            write(`UPDATE bot_life_state SET inventorySummary = ?, ${bagRevisionSet('?')},
                simulationRevision = simulationRevision + 1, updatedAt = ? WHERE characterId = ? AND phase = 'cold'`,
            [summary, summary, now(), characterId]);
        }
    }
    return {
        splitNonStackableItems(selfIds = []) {
            const ids = [...new Set(selfIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
            if (!ids.length) return Promise.resolve({ rowsSplit: 0, copiesCreated: 0 });
            const tables = [
                ['items', ['selfId', 'name', 'amount', 'enchant', 'equipped', 'slot', 'characterId']],
                ['warehouse_items', ['selfId', 'name', 'amount', 'enchant', 'characterId']],
                ['account_warehouse_items', ['accountName', 'selfId', 'name', 'amount', 'enchant']]
            ];
            return inTransaction(() => {
                let rowsSplit = 0, copiesCreated = 0;
                const splits = new Map();
                for (const [table, columns] of tables) {
                    const rows = all(`SELECT * FROM ${table} WHERE amount > 1 AND petData IS NULL
                        AND selfId IN (SELECT value FROM json_each(?))`, [JSON.stringify(ids)]);
                    for (const row of rows) {
                        if (!Number.isSafeInteger(row.amount)) throw new Error('invalid non-stackable item count');
                        write(`UPDATE ${table} SET amount = 1 WHERE id = ?`, [row.id]);
                        const instanceIds = [Number(row.id)];
                        const values = columns.map(column => column === 'amount' ? 1 : column === 'equipped' ? 0 : row[column]);
                        for (let index = 1; index < row.amount; index++) {
                            const added = write(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, values);
                            instanceIds.push(Number(added.insertId));
                            copiesCreated++;
                        }
                        rowsSplit++;
                        if (table === 'items') {
                            if (!splits.has(row.characterId)) splits.set(row.characterId, new Map());
                            splits.get(row.characterId).set(Number(row.id), {
                                selfId: Number(row.selfId), enchant: Number(row.enchant), ids: instanceIds
                            });
                        }
                    }
                }
                repairColdSnapshots(splits);
                return { rowsSplit, copiesCreated };
            }, 'item:split-non-stackable');
        }
    };
}

module.exports = { create };
