const PAGE_SIZE = 100;
const SECTIONS = new Set(['inventory', 'warehouse', 'skills', 'pvp', 'board']);
const value = (row, getter, field) => typeof row?.[getter] === 'function' ? row[getter]() : row?.[field];

function inventoryRows(inventory = {}) {
    return Object.values(inventory).flatMap(item => item.instances?.length
        ? item.instances.map(instance => ({ ...item, ...instance, selfId: item.selfId })) : [item]);
}

function createActorCollections({ subjectFor, execute, itemFor, shopsFor, enemiesFor }) {
    const compactItem = row => ({ ...itemFor(Number(value(row, 'fetchSelfId', 'selfId'))),
        id: Number(value(row, 'fetchId', 'id')) || null,
        amount: Number(value(row, 'fetchAmount', 'amount')) || 0,
        enchant: Number(value(row, 'fetchEnchantLevel', 'enchant')) || 0,
        equipped: !!value(row, 'fetchEquipped', 'equipped'), slot: Number(value(row, 'fetchSlot', 'slot')) || null });
    const compactSkill = row => ({ selfId: Number(value(row, 'fetchSelfId', 'selfId')),
        name: String(value(row, 'fetchName', 'name') || '').slice(0, 160),
        level: Number(value(row, 'fetchLevel', 'level')) || 0,
        passive: !!value(row, 'fetchPassive', 'passive') });
    return async function collection(kind, id, section, { offset = 0, limit = PAGE_SIZE } = {}) {
        if (!SECTIONS.has(section) || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000
            || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE) throw Error('invalid_profile_collection');
        const subject = await subjectFor(kind, id);
        if (!subject) return null;
        const { actor, state, session } = subject;
        const stats = state?.stats || {};
        let rows = [], total = 0, source = actor ? 'live_actor' : 'persisted';
        if (section === 'inventory' && (actor || state)) {
            const all = actor ? actor.backpack?.fetchItems?.() || [] : inventoryRows(state.inventory);
            rows = all.map(compactItem).filter(row => row.amount > 0)
                .sort((a, b) => a.selfId - b.selfId || (a.id || 0) - (b.id || 0));
            total = rows.length; rows = rows.slice(offset, offset + limit);
            source = actor ? 'live_actor' : 'cold_state';
        } else if (section === 'skills' && actor) {
            const all = (actor.skillset?.fetchSkills?.() || []).map(compactSkill).sort((a, b) => a.selfId - b.selfId);
            total = all.length; rows = all.slice(offset, offset + limit);
        } else if (section === 'board') {
            const shops = await shopsFor(id);
            const all = shops.flatMap(shop => (shop.lines || []).map(line => ({
                ...compactItem({ ...line, amount: line.count }), recordId: shop.id, kind: shop.kind || 'shop',
                side: Number(shop.storeType) === 3 ? 'Buying' : 'Selling', town: shop.town,
                conditional: Number(shop.custodyPolicy) === 1, custodyPolicy: shop.custodyPolicy ?? null,
                price: Number(line.price), expiresAt: shop.expiresAt || null,
                loc: (shop.kind || 'shop') === 'shop' ? { locX: shop.locX, locY: shop.locY, locZ: shop.locZ } : null
            }))).sort((a, b) => a.recordId - b.recordId || a.selfId - b.selfId);
            total = all.length; rows = all.slice(offset, offset + limit);
            const meetings = await execute(['SELECT id, actorA, actorB, state, town, reason FROM board_trade_meetings WHERE actorA = ? OR actorB = ? ORDER BY id DESC LIMIT 25', [id, id]]);
            return { section, source: 'board', rows, total, offset, limit, hasMore: offset + rows.length < total, meetings, generatedAt: Date.now() };
        } else if (section === 'pvp') {
            const counters = actor ? { pvp: actor.fetchPvp?.(), pk: actor.fetchPk?.(), karma: actor.fetchKarma?.() }
                : (await execute(['SELECT pvp, pk, karma FROM characters WHERE id = ?', [id]]))[0] || {};
            const cold = stats.coldPvp;
            const incidents = session?.pvpIncidents instanceof Map ? [...session.pvpIncidents.values()]
                : Array.isArray(stats.pvpIncidents) ? stats.pvpIncidents : [];
            return { section, generatedAt: Date.now(), source,
                totals: counters, enemies: enemiesFor(subject),
                lastEncounter: cold?.at > 0 && cold.outcome ? { at: cold.at, outcome: cold.outcome, lastVictimId: cold.lastVictimId,
                    lastVictimAt: cold.lastVictimAt, flagUntil: cold.flagUntil } : null,
                incidents: incidents.slice(-8).map(row => ({ at: row.at, startedAt: row.startedAt,
                    opponentId: row.opponentId, responsibility: row.responsibility, aggressionRole: row.aggressionRole })) };
        } else {
            const table = section === 'warehouse' ? 'warehouse_items' : section === 'skills' ? 'skills' : 'items';
            const positive = section === 'skills' ? '' : ' AND amount > 0';
            const columns = section === 'skills' ? 'selfId, name, level, passive'
                : table === 'items' ? 'id, selfId, name, amount, enchant, equipped, slot' : 'id, selfId, name, amount, enchant';
            const [count, page] = await Promise.all([
                execute([`SELECT COUNT(*) AS total FROM ${table} WHERE characterId = ?${positive}`, [id]]),
                execute([`SELECT ${columns} FROM ${table} WHERE characterId = ?${positive} ORDER BY ${section === 'skills' ? 'selfId' : 'id'} LIMIT ? OFFSET ?`, [id, limit, offset]])
            ]);
            total = Number(count[0]?.total || 0);
            rows = page.map(section === 'skills' ? compactSkill : compactItem);
            source = 'persisted';
        }
        return { section, source, rows, total, offset, limit, hasMore: offset + rows.length < total, generatedAt: Date.now() };
    };
}
module.exports = { createActorCollections, inventoryRows, PAGE_SIZE };
