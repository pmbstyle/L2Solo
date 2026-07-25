const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let connection;
let queryTail = Promise.resolve();
let databasePath;
let flushPendingCharacterWrites = null;
const cooperative = {
    depth: 0,
    sliceStartedAt: 0,
    sliceMs: 0
};

const metrics = {
    pending: 0,
    total: 0,
    reads: 0,
    writes: 0,
    transactions: 0,
    failures: 0,
    waitMs: 0,
    runMs: 0,
    maxPending: 0,
    byOperation: new Map()
};

function now() {
    return Date.now();
}

function yieldToEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}

function normalizeValue(value) {
    if (typeof value === 'bigint') return Number(value);
    if (Buffer.isBuffer(value)) return value;
    return value;
}

function normalizeRow(row) {
    if (!row || typeof row !== 'object') return row;
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]));
}

function normalizeRows(rows) {
    return (rows || []).map(normalizeRow);
}

function escapeIdentifier(value) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        throw new Error(`invalid SQL identifier: ${value}`);
    }
    return `"${value}"`;
}

function databaseFile() {
    const configured = options.default.Database?.path || 'tmp/nodel2.sqlite';
    return path.resolve(process.cwd(), configured);
}

function isReadStatement(sql) {
    return /^\s*(SELECT|EXPLAIN|PRAGMA\s+[^=]+$)/i.test(String(sql || ''));
}

function operationName(sql, fallback = 'raw') {
    const match = String(sql || '').trim().match(/^([A-Za-z]+)/);
    return match ? `${fallback}:${match[1].toLowerCase()}` : fallback;
}

function record(operation, wait, run, read, failed = false) {
    metrics.total += 1;
    metrics.waitMs += wait;
    metrics.runMs += run;
    if (read) metrics.reads += 1;
    else metrics.writes += 1;
    if (failed) metrics.failures += 1;
    const entry = metrics.byOperation.get(operation) || { count: 0, waitMs: 0, runMs: 0, failures: 0 };
    entry.count += 1;
    entry.waitMs += wait;
    entry.runMs += run;
    if (failed) entry.failures += 1;
    metrics.byOperation.set(operation, entry);
}

function enqueue(work, { operation = 'raw', read = false } = {}) {
    const queuedAt = now();
    metrics.pending += 1;
    metrics.maxPending = Math.max(metrics.maxPending, metrics.pending);
    const execute = () => {
        const startedAt = now();
        const wait = startedAt - queuedAt;
        try {
            const result = work();
            record(operation, wait, now() - startedAt, read);
            return result;
        } catch (error) {
            record(operation, wait, now() - startedAt, read, true);
            throw error;
        } finally {
            metrics.pending -= 1;
        }
    };
    const queued = queryTail.then(execute, execute);
    const cooperativeQueue = cooperative.depth > 0;
    const result = cooperativeQueue
        ? queued.then((value) => {
            if (cooperative.depth <= 0 || now() - cooperative.sliceStartedAt < cooperative.sliceMs) return value;
            return yieldToEventLoop().then(() => {
                cooperative.sliceStartedAt = now();
                return value;
            });
        })
        : queued;
    queryTail = result.catch(() => null);
    return result;
}

function run(sql, params = [], operation) {
    const read = isReadStatement(sql);
    return enqueue(() => {
        if (!connection) throw new Error(`SQLite is not initialized (${operation || operationName(sql)})`);
        const statement = connection.prepare(sql);
        if (read) return normalizeRows(statement.all(...params));
        const result = statement.run(...params);
        return {
            affectedRows: Number(result.changes || 0),
            insertId: Number(result.lastInsertRowid || 0)
        };
    }, { operation: operation || operationName(sql), read });
}

function insert(table, values, operation) {
    const columns = Object.keys(values || {});
    if (!columns.length) throw new Error(`cannot insert empty ${table}`);
    const sql = `INSERT INTO ${escapeIdentifier(table)} (${columns.map(escapeIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    return run(sql, columns.map((key) => values[key]), operation || `insert:${table}`);
}

function update(table, values, where, params = [], operation) {
    const columns = Object.keys(values || {});
    if (!columns.length) return Promise.resolve({ affectedRows: 0, insertId: 0 });
    const sql = `UPDATE ${escapeIdentifier(table)} SET ${columns.map((key) => `${escapeIdentifier(key)} = ?`).join(', ')}${where ? ` WHERE ${where}` : ''}`;
    return run(sql, [...columns.map((key) => values[key]), ...params], operation || `update:${table}`);
}

function remove(table, where, params = [], operation) {
    return run(`DELETE FROM ${escapeIdentifier(table)}${where ? ` WHERE ${where}` : ''}`, params, operation || `delete:${table}`);
}

function select(table, columns = ['*'], where = '', params = [], operation) {
    const selected = columns.length === 1 && columns[0] === '*'
        ? '*'
        : columns.map(escapeIdentifier).join(', ');
    return run(`SELECT ${selected} FROM ${escapeIdentifier(table)}${where ? ` WHERE ${where}` : ''}`, params, operation || `select:${table}`);
}

function selectOne(table, columns, where, params, operation) {
    return select(table, columns, `${where} LIMIT 1`, params, operation);
}

function cleanZeroAmountItems() {
    return run('DELETE FROM items WHERE amount <= 0', [], 'maintenance:zero-items');
}

async function inTransaction(work, operation = 'transaction') {
    return enqueue(() => {
        metrics.transactions += 1;
        connection.exec('BEGIN IMMEDIATE');
        try {
            const result = work();
            connection.exec('COMMIT');
            return result;
        } catch (error) {
            connection.exec('ROLLBACK');
            throw error;
        }
    }, { operation, read: false });
}

function withCharacterFlush(characterId, work) {
    if (!flushPendingCharacterWrites || !Number(characterId)) return work();
    return Promise.resolve(flushPendingCharacterWrites(Number(characterId))).then(work);
}

function withCharacterFlushes(characterIds, work) {
    if (!flushPendingCharacterWrites) return work();
    const ids = [...new Set((characterIds || []).map(Number).filter(Boolean))];
    return ids.reduce(
        (pending, characterId) => pending.then(() => flushPendingCharacterWrites(characterId)),
        Promise.resolve()
    ).then(work);
}

function applySchemaMigrations() {
    const migrations = [
        [1, () => {}],
        [2, () => connection.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_nocase ON accounts(username COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS characters_username_nocase ON characters(username COLLATE NOCASE);
        `)]
    ];
    const applied = new Set(connection.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)));
    migrations.forEach(([version, apply]) => {
        if (applied.has(version)) return;
        apply();
        connection.prepare('INSERT INTO schema_migrations(version, appliedAt) VALUES (?, ?)').run(version, now());
    });
}

function one(sql, params = []) {
    return normalizeRow(connection.prepare(sql).get(...params));
}

function all(sql, params = []) {
    return normalizeRows(connection.prepare(sql).all(...params));
}

function write(sql, params = []) {
    const result = connection.prepare(sql).run(...params);
    return { affectedRows: Number(result.changes || 0), insertId: Number(result.lastInsertRowid || 0) };
}

function applyBufferedCharacterStateUnsafe(characterId, state = {}) {
    const character = state.character || {};
    const fields = Object.entries(character).filter(([, value]) => value !== undefined);
    if (fields.length) {
        const sql = `UPDATE characters SET ${fields.map(([key]) => `${escapeIdentifier(key)} = ?`).join(', ')} WHERE id = ?`;
        write(sql, [...fields.map(([, value]) => value), characterId]);
    }
    Object.values(state.items || {}).forEach((item) => {
        if (item.delete || Number(item.amount) <= 0) {
            write('DELETE FROM items WHERE id = ? AND characterId = ?', [item.id, characterId]);
        } else {
            write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [item.amount, item.id, characterId]);
        }
    });
    return { characterId, fields: fields.length, items: Object.keys(state.items || {}).length };
}

const UPSERT_CHARACTER_QUEST = `INSERT INTO character_quests (characterId, questId, state, variables)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(characterId, questId) DO UPDATE SET state = excluded.state, variables = excluded.variables`;
const UPSERT_RECIPE = `INSERT INTO character_recipes (characterId, recipeId, type) VALUES (?, ?, ?)
    ON CONFLICT(characterId, recipeId, type) DO NOTHING`;
const UPSERT_MACRO = `INSERT INTO macros (characterId, id, icon, name, descr, acronym, commands)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(characterId, id) DO UPDATE SET icon = excluded.icon, name = excluded.name,
        descr = excluded.descr, acronym = excluded.acronym, commands = excluded.commands`;

const Database = {
    init(callback = () => {}) {
        try {
            databasePath = databaseFile();
            fs.mkdirSync(path.dirname(databasePath), { recursive: true });
            connection = new DatabaseSync(databasePath, { timeout: 5000 });
            connection.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;');
            connection.exec(fs.readFileSync(path.join(process.cwd(), 'database', 'sql', 'sqlite.sql'), 'utf8'));
            applySchemaMigrations();
            cleanZeroAmountItems().catch((error) => utils.infoWarn('DB', 'failed to clean zero amount items: %s', error.message));
            utils.infoSuccess('DB', 'SQLite connected %s', databasePath);
            callback();
        } catch (error) {
            utils.infoFail('DB', 'SQLite initialization failed -> %s', error.message);
        }
    },

    execute(statement, operation = 'raw') {
        return run(statement[0], statement[1] || [], operation);
    },

    isReady() { return !!connection; },

    registerCharacterWriteFlush(flush) {
        flushPendingCharacterWrites = typeof flush === 'function' ? flush : null;
    },

    cooperatively(work, sliceMs = 12) {
        const outermost = cooperative.depth === 0;
        if (outermost) {
            cooperative.sliceStartedAt = now();
            cooperative.sliceMs = Math.max(1, Number(sliceMs) || 12);
        }
        cooperative.depth += 1;
        return Promise.resolve().then(work).finally(() => {
            cooperative.depth -= 1;
            if (cooperative.depth === 0) {
                cooperative.sliceStartedAt = 0;
                cooperative.sliceMs = 0;
            }
        });
    },

    stats({ resetPeak = false } = {}) {
        const operations = Object.fromEntries(Array.from(metrics.byOperation.entries()).map(([key, value]) => [key, { ...value }]));
        const snapshot = {
            path: databasePath || null,
            pending: metrics.pending,
            maxPending: metrics.maxPending,
            total: metrics.total,
            reads: metrics.reads,
            writes: metrics.writes,
            transactions: metrics.transactions,
            failures: metrics.failures,
            avgWaitMs: metrics.total ? Math.round(metrics.waitMs / metrics.total) : 0,
            avgRunMs: metrics.total ? Math.round(metrics.runMs / metrics.total) : 0,
            operations
        };
        if (resetPeak) metrics.maxPending = metrics.pending;
        return snapshot;
    },

    checkpoint() {
        return enqueue(() => normalizeRows(connection.prepare('PRAGMA wal_checkpoint(PASSIVE)').all()), { operation: 'maintenance:checkpoint', read: false });
    },

    applyBufferedCharacterState(characterId, state = {}) {
        return inTransaction(() => applyBufferedCharacterStateUnsafe(characterId, state), 'buffered-character:flush');
    },

    applyBufferedCharacterStates(entries = []) {
        return inTransaction(() => entries.map(([characterId, state]) => applyBufferedCharacterStateUnsafe(Number(characterId), state)), 'buffered-character:flush-batch');
    },

    syncInventorySummary(characterId, inventory = {}) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const existing = all('SELECT id, selfId, amount, equipped, slot FROM items WHERE characterId = ? ORDER BY id', [characterId]);
            const bySelfId = new Map();
            existing.forEach((row) => {
                const key = Number(row.selfId);
                if (!bySelfId.has(key)) bySelfId.set(key, row);
            });
            Object.values(inventory).forEach((item) => {
                const selfId = Number(item.selfId || 0);
                const amount = Number(item.amount || 0);
                if (!selfId) return;
                const current = bySelfId.get(selfId);
                if (amount <= 0) {
                    if (current) write('DELETE FROM items WHERE id = ? AND characterId = ?', [current.id, characterId]);
                    return;
                }
                const equipped = item.equipped ? 1 : 0;
                const slot = Number(item.slot || current?.slot || 0);
                if (current) {
                    if (Number(current.amount) !== amount || Number(current.equipped) !== equipped || Number(current.slot) !== slot) {
                        write('UPDATE items SET amount = ?, equipped = ?, slot = ? WHERE id = ? AND characterId = ?', [amount, equipped, slot, current.id, characterId]);
                    }
                } else {
                    write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, ?, ?, ?)', [selfId, item.name || `Item ${selfId}`, amount, equipped, slot, characterId]);
                }
            });
            return { characterId, entries: Object.keys(inventory).length };
        }, 'inventory:sync-summary'));
    },

    createAccount(username, password) {
        return insert('accounts', { username, password }, 'account:create');
    },
    fetchUserPassword(username) {
        return selectOne('accounts', ['username', 'password'], 'username = ? COLLATE NOCASE', [username], 'account:password');
    },
    fetchCharacters(username) {
        return select('characters', ['*'], 'username = ? COLLATE NOCASE', [username], 'character:by-account');
    },
    fetchClanCharacters() {
        return select('characters', ['*'], 'clanId != 0', [], 'character:clan-members');
    },
    fetchCharacterName(name) {
        return selectOne('characters', ['*'], 'name = ? COLLATE NOCASE', [name], 'character:by-name');
    },
    createCharacter(username, data) {
        return selectOne('accounts', ['username'], 'username = ? COLLATE NOCASE', [username], 'account:canonical-name')
            .then((accounts) => {
                if (!accounts[0]) throw new Error('account does not exist');
                return insert('characters', {
                    username: accounts[0].username, name: data.name, race: data.race, classId: data.classId,
                    maxHp: data.maxHp, maxMp: data.maxMp, sex: data.sex, face: data.face,
                    hair: data.hair, hairColor: data.hairColor, locX: data.locX, locY: data.locY, locZ: data.locZ
                }, 'character:create');
            });
    },
    deleteCharacter(username, name) {
        return remove('characters', 'username = ? COLLATE NOCASE AND name = ? COLLATE NOCASE', [username, name], 'character:delete');
    },
    fetchSkills(characterId) {
        return select('skills', ['*'], 'characterId = ?', [characterId], 'skill:list');
    },
    fetchSkill(characterId, skillSelfId) {
        return selectOne('skills', ['*'], 'characterId = ? AND selfId = ?', [characterId, skillSelfId], 'skill:one');
    },
    deleteSkills(characterId) {
        return remove('skills', 'characterId = ?', [characterId], 'skill:delete-all');
    },
    setSkill(skill, characterId) {
        return run(`INSERT INTO skills (selfId, name, passive, level, characterId) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(characterId, selfId) DO UPDATE SET name = excluded.name, passive = excluded.passive, level = excluded.level`,
        [skill.selfId, skill.name, skill.passive ? 1 : 0, skill.level, characterId], 'skill:upsert');
    },
    updateSkillLevel(characterId, skillSelfId, skillLevel) {
        return update('skills', { level: skillLevel }, 'selfId = ? AND characterId = ?', [skillSelfId, characterId], 'skill:level');
    },
    setItem(characterId, item) {
        const values = { selfId: item.selfId, name: item.name ?? '', amount: item.amount ?? 1, equipped: item.equipped ? 1 : 0, slot: item.slot ?? 0, characterId };
        if (item.petData) values.petData = typeof item.petData === 'string' ? item.petData : JSON.stringify(item.petData);
        return withCharacterFlush(characterId, () => insert('items', values, 'item:insert'));
    },
    fetchItems(characterId) {
        return withCharacterFlush(characterId, () => select('items', ['*'], 'characterId = ? AND amount > 0', [characterId], 'item:list'));
    },
    updateItemAmount(characterId, id, amount) {
        return withCharacterFlush(characterId, () => {
            if (Number(amount) <= 0) return remove('items', 'id = ? AND characterId = ?', [id, characterId], 'item:delete-empty');
            return update('items', { amount }, 'id = ? AND characterId = ?', [id, characterId], 'item:amount');
        });
    },
    updateItemEquipState(characterId, id, equipped, slot) {
        return withCharacterFlush(characterId, () => update('items', { equipped: equipped ? 1 : 0, slot }, 'id = ? AND characterId = ?', [id, characterId], 'item:equip'));
    },
    deleteItem(characterId, id) {
        return withCharacterFlush(characterId, () => remove('items', 'id = ? AND characterId = ?', [id, characterId], 'item:delete'));
    },
    deleteItems(characterId) {
        return withCharacterFlush(characterId, () => remove('items', 'characterId = ?', [characterId], 'item:delete-all'));
    },
    fetchWarehouseItems(characterId) {
        return select('warehouse_items', ['*'], 'characterId = ? AND amount > 0', [characterId], 'warehouse:list');
    },
    setWarehouseItem(characterId, item) {
        const values = { selfId: item.selfId, name: item.name ?? '', amount: item.amount ?? 1, characterId };
        if (item.petData) values.petData = typeof item.petData === 'string' ? item.petData : JSON.stringify(item.petData);
        return insert('warehouse_items', values, 'warehouse:insert');
    },
    updateWarehouseItemAmount(characterId, id, amount) {
        if (Number(amount) <= 0) return remove('warehouse_items', 'id = ? AND characterId = ?', [id, characterId], 'warehouse:delete-empty');
        return update('warehouse_items', { amount }, 'id = ? AND characterId = ?', [id, characterId], 'warehouse:amount');
    },
    deleteWarehouseItem(characterId, id) {
        return remove('warehouse_items', 'id = ? AND characterId = ?', [id, characterId], 'warehouse:delete');
    },

    transferInventoryToWarehouse(characterId, item) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const source = one('SELECT id, amount FROM items WHERE id = ? AND characterId = ?', [item.id, characterId]);
            if (!source || Number(source.amount) < Number(item.amount)) throw new Error('inventory item changed');
            const target = item.stackable ? one('SELECT id, amount FROM warehouse_items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, item.selfId]) : null;
            const warehouseAmount = Number(target?.amount || 0) + Number(item.amount);
            const warehouseId = target ? target.id : write('INSERT INTO warehouse_items (selfId, name, amount, petData, characterId) VALUES (?, ?, ?, ?, ?)', [item.selfId, item.name || '', item.amount, item.petData ? JSON.stringify(item.petData) : null, characterId]).insertId;
            if (target) write('UPDATE warehouse_items SET amount = ? WHERE id = ? AND characterId = ?', [warehouseAmount, warehouseId, characterId]);
            const inventoryAmount = Number(source.amount) - Number(item.amount);
            if (inventoryAmount <= 0) write('DELETE FROM items WHERE id = ? AND characterId = ?', [item.id, characterId]);
            else write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [inventoryAmount, item.id, characterId]);
            return { warehouseId: Number(warehouseId), warehouseAmount, inventoryAmount };
        }, 'warehouse:deposit'));
    },

    transferWarehouseToInventory(characterId, item) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const source = one('SELECT id, amount, petData FROM warehouse_items WHERE id = ? AND characterId = ?', [item.id, characterId]);
            if (!source || Number(source.amount) < Number(item.amount)) throw new Error('warehouse item changed');
            const target = item.stackable ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, item.selfId]) : null;
            const inventoryAmount = Number(target?.amount || 0) + Number(item.amount);
            const inventoryId = target ? target.id : write('INSERT INTO items (selfId, name, amount, equipped, slot, petData, characterId) VALUES (?, ?, ?, 0, 0, ?, ?)', [item.selfId, item.name || '', item.amount, source.petData, characterId]).insertId;
            if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [inventoryAmount, inventoryId, characterId]);
            const warehouseAmount = Number(source.amount) - Number(item.amount);
            if (warehouseAmount <= 0) write('DELETE FROM warehouse_items WHERE id = ? AND characterId = ?', [item.id, characterId]);
            else write('UPDATE warehouse_items SET amount = ? WHERE id = ? AND characterId = ?', [warehouseAmount, item.id, characterId]);
            return { inventoryId: Number(inventoryId), inventoryAmount, warehouseAmount, petData: source.petData };
        }, 'warehouse:withdraw'));
    },

    fetchCharacterQuests(characterId) { return select('character_quests', ['*'], 'characterId = ?', [characterId], 'quest:list'); },
    setCharacterQuest(characterId, questId, state, variables) { return run(UPSERT_CHARACTER_QUEST, [characterId, questId, state, JSON.stringify(variables || {})], 'quest:upsert'); },
    deleteCharacterQuest(characterId, questId) { return remove('character_quests', 'characterId = ? AND questId = ?', [characterId, questId], 'quest:delete'); },
    fetchCharacterRecipes(characterId) { return run('SELECT recipeId, type FROM character_recipes WHERE characterId = ?', [characterId], 'recipe:list'); },
    setCharacterRecipe(characterId, recipeId, type) { return run(UPSERT_RECIPE, [characterId, recipeId, type], 'recipe:upsert'); },

    craftInventoryItems(characterId, { materials, product, mp }) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const sources = [];
            for (const material of [...materials].sort((left, right) => Number(left.id) - Number(right.id))) {
                const source = one('SELECT id, selfId, amount FROM items WHERE id = ? AND characterId = ?', [material.id, characterId]);
                if (!source || Number(source.selfId) !== Number(material.selfId) || Number(source.amount) < Number(material.amount)) throw new Error('craft material changed');
                sources.push({ id: Number(source.id), amount: Number(source.amount) - Number(material.amount) });
            }
            const target = product?.stackable ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, product.selfId]) : null;
            let productId = Number(target?.id || 0);
            const productAmount = Number(target?.amount || 0) + Number(product?.amount || 0);
            sources.forEach((source) => source.amount <= 0 ? write('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, characterId]) : write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [source.amount, source.id, characterId]));
            if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [productAmount, productId, characterId]);
            else if (product) productId = write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, 0, ?, ?)', [product.selfId, product.name || '', product.amount, product.slot || 0, characterId]).insertId;
            write('UPDATE characters SET mp = ? WHERE id = ?', [mp, characterId]);
            return { sources, product: product ? { id: productId, amount: productAmount } : null };
        }, 'craft:self'));
    },

    crystallizeInventoryItem(characterId, { sourceId, sourceSelfId, crystalId, crystalName, crystalAmount }) {
        return withCharacterFlush(characterId, () => inTransaction(() => {
            const source = one('SELECT id, selfId, amount, equipped FROM items WHERE id = ? AND characterId = ?', [sourceId, characterId]);
            if (!source || Number(source.selfId) !== Number(sourceSelfId) || Number(source.amount) !== 1 || Number(source.equipped) !== 0) throw new Error('crystallize source changed');
            const target = one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [characterId, crystalId]);
            const amount = Number(target?.amount || 0) + Number(crystalAmount);
            let id = Number(target?.id || 0);
            write('DELETE FROM items WHERE id = ? AND characterId = ?', [sourceId, characterId]);
            if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [amount, id, characterId]);
            else id = write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, 0, 0, ?)', [crystalId, crystalName || '', crystalAmount, characterId]).insertId;
            return { crystalId, id, amount };
        }, 'crystalize'));
    },

    craftForCustomer(crafterId, customerId, { materials, product, crafterMp, price, adena }) {
        return withCharacterFlushes([crafterId, customerId], () => inTransaction(() => {
            const sources = [];
            for (const material of [...materials].sort((left, right) => Number(left.id) - Number(right.id))) {
                const source = one('SELECT id, selfId, amount FROM items WHERE id = ? AND characterId = ?', [material.id, customerId]);
                if (!source || Number(source.selfId) !== Number(material.selfId) || Number(source.amount) < Number(material.amount)) throw new Error('customer craft material changed');
                sources.push({ id: Number(source.id), amount: Number(source.amount) - Number(material.amount) });
            }
            const fee = Number(price) || 0;
            const customerAdena = fee > 0 ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = 57 ORDER BY id LIMIT 1', [customerId]) : null;
            if (fee > 0 && (!customerAdena || Number(customerAdena.amount) < fee)) throw new Error('customer adena changed');
            let crafterAdena = fee > 0 ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = 57 ORDER BY id LIMIT 1', [crafterId]) : null;
            const target = product?.stackable ? one('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? ORDER BY id LIMIT 1', [customerId, product.selfId]) : null;
            let productId = Number(target?.id || 0);
            const productAmount = Number(target?.amount || 0) + Number(product?.amount || 0);
            sources.forEach((source) => source.amount <= 0 ? write('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, customerId]) : write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [source.amount, source.id, customerId]));
            if (target) write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [productAmount, productId, customerId]);
            else if (product) productId = write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, 0, ?, ?)', [product.selfId, product.name || '', product.amount, product.slot || 0, customerId]).insertId;
            let nextCrafterAdena = null;
            if (fee > 0) {
                write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [Number(customerAdena.amount) - fee, customerAdena.id, customerId]);
                if (crafterAdena) {
                    nextCrafterAdena = Number(crafterAdena.amount) + fee;
                    write('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [nextCrafterAdena, crafterAdena.id, crafterId]);
                } else {
                    const id = write('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (57, ?, ?, 0, 0, ?)', [adena?.name || 'Adena', fee, crafterId]).insertId;
                    nextCrafterAdena = fee;
                    crafterAdena = { id, amount: 0 };
                }
            }
            write('UPDATE characters SET mp = ? WHERE id = ?', [crafterMp, crafterId]);
            return { sources, product: product ? { id: productId, amount: productAmount } : null, customerAdena: fee > 0 ? { id: Number(customerAdena.id), amount: Number(customerAdena.amount) - fee } : null, crafterAdena: fee > 0 ? { id: Number(crafterAdena.id), amount: nextCrafterAdena } : null };
        }, 'craft:customer'));
    },

    updateItemPetData(characterId, id, petData) { return withCharacterFlush(characterId, () => update('items', { petData: JSON.stringify(petData || {}) }, 'id = ? AND characterId = ?', [id, characterId], 'item:pet')); },
    fetchClans() { return select('clans', ['*'], '', [], 'clan:list'); },
    createClanCrest(clanId, kind, data) { return insert('clan_crests', { clanId, kind, data, createdAt: now() }, 'clan:crest-create'); },
    fetchClanCrest(id) { return selectOne('clan_crests', ['*'], 'id = ?', [id], 'clan:crest'); },
    createClan(data) { return insert('clans', { name: data.name, leaderId: data.leaderId }, 'clan:create'); },
    updateClanCrest(id, crestId) { return update('clans', { crestId }, 'id = ?', [id], 'clan:crest'); },
    updateClanLevel(id, level) { return update('clans', { level }, 'id = ?', [id], 'clan:level'); },
    updateCharacterClan(id, clanId, clanPrivileges, clanJoinExpiryTime, clanCreateExpiryTime) { return update('characters', { clanId, clanPrivileges, clanJoinExpiryTime, clanCreateExpiryTime }, 'id = ?', [id], 'character:clan'); },
    updateCharacterClanPrivileges(id, clanPrivileges) { return update('characters', { clanPrivileges }, 'id = ?', [id], 'character:clan-privileges'); },
    deleteGearItems(characterId) { return withCharacterFlush(characterId, () => remove('items', 'characterId = ? AND selfId != 57', [characterId], 'item:delete-gear')); },
    setShortcut(characterId, shortcut) { return run(`INSERT INTO shortcuts (id, kind, slot, unknown, characterId) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(characterId, slot) DO UPDATE SET id = excluded.id, kind = excluded.kind, unknown = excluded.unknown`, [shortcut.id, shortcut.kind, shortcut.slot, shortcut.unknown, characterId], 'shortcut:upsert'); },
    fetchShortcuts(characterId) { return select('shortcuts', ['*'], 'characterId = ?', [characterId], 'shortcut:list'); },
    deleteShortcut(characterId, slot) { return remove('shortcuts', 'slot = ? AND characterId = ?', [slot, characterId], 'shortcut:delete'); },
    deleteShortcuts(characterId) { return remove('shortcuts', 'characterId = ?', [characterId], 'shortcut:delete-all'); },
    setMacro(characterId, macro) { return run(UPSERT_MACRO, [characterId, macro.id, macro.icon, macro.name, macro.descr, macro.acronym, JSON.stringify(macro.commands)], 'macro:upsert'); },
    fetchMacros(characterId) { return select('macros', ['*'], 'characterId = ?', [characterId], 'macro:list').then((rows) => rows.map((row) => ({ ...row, commands: (() => { try { return JSON.parse(row.commands); } catch (_) { return []; } })() }))); },
    deleteMacro(characterId, macroId) { return remove('macros', 'characterId = ? AND id = ?', [characterId, macroId], 'macro:delete'); },
    deleteMacros(characterId) { return remove('macros', 'characterId = ?', [characterId], 'macro:delete-all'); },
    deleteMacroShortcuts(characterId, macroId) { return remove('shortcuts', 'characterId = ? AND kind = 4 AND id = ?', [characterId, macroId], 'shortcut:delete-macro'); },
    updateCharacterLocation(id, coords) { return withCharacterFlush(id, () => update('characters', { locX: coords.locX, locY: coords.locY, locZ: coords.locZ, head: coords.head ?? -1 }, 'id = ?', [id], 'character:location')); },
    updateCharacterName(id, name) { return withCharacterFlush(id, () => update('characters', { name }, 'id = ?', [id], 'character:name')); },
    updateCharacterExperience(id, level, exp, sp) { return withCharacterFlush(id, () => update('characters', { level, exp, sp }, 'id = ?', [id], 'character:experience')); },
    updateCharacterVitals(id, hp, maxHp, mp, maxMp) { return withCharacterFlush(id, () => update('characters', { hp, maxHp, mp, maxMp }, 'id = ?', [id], 'character:vitals')); },
    updateCharacterStatus(id, { hp, mp, cp, effects }) { return withCharacterFlush(id, () => update('characters', { hp, mp, cp, effects }, 'id = ?', [id], 'character:status')); },
    updateCharacterPvpPkKarma(id, pvp, pk, karma) { return withCharacterFlush(id, () => update('characters', { pvp, pk, karma }, 'id = ?', [id], 'character:karma')); },
    updateCharacterClassId(id, classId) { return withCharacterFlush(id, () => update('characters', { classId }, 'id = ?', [id], 'character:class')); }
};

module.exports = Database;
