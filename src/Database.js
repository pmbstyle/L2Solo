const SQL = require('like-sql'), builder = new SQL();

let conn;
let transactionTail = Promise.resolve();

function normalizeRowNumbers(row) {
    return Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value])
    );
}

function migrateCharacterExperience(optn) {
    return conn.query(
        'SELECT DATA_TYPE AS dataType FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [optn.databaseName, 'characters', 'exp']
    ).then((rows) => {
        if (rows[0]?.dataType === 'bigint') return null;
        return conn.query('ALTER TABLE `characters` MODIFY COLUMN `exp` BIGINT NOT NULL DEFAULT 0');
    }).catch((error) => {
        utils.infoWarn('DB', 'failed to migrate characters.exp to BIGINT: %s', error.message);
    });
}

function migrateCharacterStatus() {
    return conn.query('ALTER TABLE `characters` ADD COLUMN `cp` FLOAT NULL')
        .catch((error) => {
            if (error?.errno !== 1060) utils.infoWarn('DB', 'failed to add characters.cp: %s', error.message);
        })
        .then(() => conn.query('ALTER TABLE `characters` ADD COLUMN `effects` TEXT NULL'))
        .catch((error) => {
            if (error?.errno !== 1060) utils.infoWarn('DB', 'failed to add characters.effects: %s', error.message);
        });
}

function migrateWarehouse() {
    return conn.query(`CREATE TABLE IF NOT EXISTS warehouse_items (
        id INT(8) NOT NULL AUTO_INCREMENT,
        selfId INT(5) NOT NULL,
        name VARCHAR(48) NOT NULL,
        amount BIGINT NOT NULL DEFAULT 1,
        petData TEXT NULL,
        characterId INT(8) NOT NULL,
        PRIMARY KEY (id),
        KEY characterId (characterId)
    )`).then(() => conn.query('ALTER TABLE warehouse_items ADD COLUMN petData TEXT NULL')
        .catch((error) => {
            if (error?.errno !== 1060) utils.infoWarn('DB', 'failed to add warehouse_items.petData: %s', error.message);
        }))
        .catch((error) => {
            utils.infoWarn('DB', 'failed to create warehouse_items: %s', error.message);
        });
}

function migrateMacros() {
    return conn.query(`CREATE TABLE IF NOT EXISTS macros (
        characterId INT(8) NOT NULL,
        id INT(8) NOT NULL,
        icon TINYINT UNSIGNED NOT NULL,
        name VARCHAR(64) NOT NULL,
        descr VARCHAR(64) NOT NULL,
        acronym VARCHAR(16) NOT NULL,
        commands TEXT NOT NULL,
        PRIMARY KEY (characterId, id),
        KEY characterId (characterId)
    )`).catch((error) => {
        utils.infoWarn('DB', 'failed to create macros: %s', error.message);
    });
}

function migrateCharacterRecipes() {
    return conn.query(`CREATE TABLE IF NOT EXISTS character_recipes (
        characterId INT(8) NOT NULL,
        recipeId INT(8) NOT NULL,
        type ENUM('dwarven', 'common') NOT NULL,
        PRIMARY KEY (characterId, recipeId, type),
        KEY characterId (characterId)
    )`).catch((error) => {
        utils.infoWarn('DB', 'failed to create character_recipes: %s', error.message);
    });
}

function migrateCharacterQuests() {
    return conn.query(`CREATE TABLE IF NOT EXISTS character_quests (
        characterId INT(8) NOT NULL,
        questId INT(8) NOT NULL,
        state ENUM('created', 'started', 'completed') NOT NULL DEFAULT 'created',
        variables TEXT NULL,
        PRIMARY KEY (characterId, questId),
        KEY characterId (characterId)
    )`).catch((error) => {
        utils.infoWarn('DB', 'failed to create character_quests: %s', error.message);
    });
}

async function inTransaction(work) {
    const previous = transactionTail;
    let release;
    transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
        await conn.beginTransaction();
        const result = await work();
        await conn.commit();
        return result;
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        release();
    }
}

function petDataValue(petData) {
    if (!petData) return null;
    return typeof petData === 'string' ? petData : JSON.stringify(petData);
}

const Database = {
    init: (callback) => {
        const optn = options.default.Database;

        require('mariadb').createConnection({
            host     : optn.hostname,
            port     : optn.port,
            user     : optn.user,
            password : optn.password,
            database : optn.databaseName

        }).then((instance) => {
            utils.infoSuccess('DB', 'connected');
            conn = instance;
            Promise.all([
                conn.query('ALTER TABLE `items` ADD COLUMN `petData` TEXT NULL')
                .catch((error) => {
                    if (error?.errno !== 1060) {
                        utils.infoWarn('DB', 'failed to add items.petData: %s', error.message);
                    }
                }),
                migrateCharacterExperience(optn),
                migrateCharacterStatus(),
                migrateWarehouse(),
                migrateMacros(),
                migrateCharacterRecipes(),
                migrateCharacterQuests()
            ]).finally(callback);

        }).catch(error => {
            utils.infoFail('DB', 'failed(%d) -> %s', error.errno, error.text);
        });
    },

    execute: (sql) => {
        // Do not let unrelated queries run inside an active item-transfer transaction
        // on this shared MariaDB connection.
        return transactionTail.then(() => conn.query(sql[0], sql[1]));
    },

    // Creates a `New Account` in the database with provided credentials
    createAccount: (username, password) => {
        return Database.execute(
            builder.insert('accounts', {
                username: username,
                password: password
            })
        );
    },

    // Returns the `Password` from a provided account
    fetchUserPassword: (username) => {
        return Database.execute(
            builder.selectOne('accounts', ['password'], 'username = ?', username)
        );
    },

    // Returns the `Characters` stored on a user's account
    fetchCharacters: (username) => {
        return Database.execute(
            builder.select('characters', ['*'], 'username = ?', username)
        ).then((rows) => rows.map(normalizeRowNumbers));
    },

    fetchClanCharacters() {
        return Database.execute(
            builder.select('characters', ['*'], 'clanId != 0')
        ).then((rows) => rows.map(normalizeRowNumbers));
    },

    // Checks if acharacter `Name` exists
    fetchCharacterName: (name) => {
        return Database.execute(
            builder.selectOne('characters', ['*'], 'name = ?', name)
        ).then((rows) => rows.map(normalizeRowNumbers));
    },

    // Stores a new `Character` in database with provided details
    createCharacter(username, data) {
        return Database.execute(
            builder.insert('characters', {
                 username: username,
                     name: data.name,
                     race: data.race,
                  classId: data.classId,
                    maxHp: data.maxHp,
                    maxMp: data.maxMp,
                      sex: data.sex,
                     face: data.face,
                     hair: data.hair,
                hairColor: data.hairColor,
                     locX: data.locX,
                     locY: data.locY,
                     locZ: data.locZ,
            })
        );
    },

    deleteCharacter(username, name) {
        return Database.execute(
            builder.delete('characters', 'username = ? AND name = ?', username, name)
        );
    },

    fetchSkills(characterId) {
        return Database.execute(
            builder.select('skills', ['*'], 'characterId = ?', characterId)
        );
    },

    fetchSkill(characterId, skillSelfId) {
        return Database.execute(
            builder.selectOne('skills', ['*'], 'characterId = ? AND selfId = ?', characterId, skillSelfId)
        );
    },

    deleteSkills(characterId) {
        return Database.execute(
            builder.delete('skills', 'characterId = ?', characterId)
        );
    },

    setSkill(skill, characterId) {
        return Database.execute(
            builder.insert('skills', {
                     selfId: skill.selfId,
                       name: skill.name,
                    passive: skill.passive,
                      level: skill.level,
                characterId: characterId,
            })
        );
    },

    updateSkillLevel(characterId, skillSelfId, skillLevel) {
        return Database.execute(
            builder.update('skills', {
                level: skillLevel
            }, 'selfId = ? AND characterId = ?', skillSelfId, characterId)
        );
    },

    setItem(characterId, item) {
        const values = {
                 selfId: item.selfId,
                   name: item.name ?? '',
                 amount: item.amount ?? 1,
               equipped: item.equipped ?? false,
                   slot: item.slot ?? 0,
            characterId: characterId
        };
        if (item.petData) values.petData = JSON.stringify(item.petData);
        return Database.execute(
            builder.insert('items', values)
        );
    },

    fetchItems(characterId) {
        return Database.execute(
            builder.select('items', ['*'], 'characterId = ?', characterId)
        );
    },

    updateItemAmount(characterId, id, amount) {
        return Database.execute(
            builder.update('items', {
                amount: amount
            }, 'id = ? AND characterId = ?', id, characterId)
        );
    },

    updateItemEquipState(characterId, id, equipped, slot) {
        return Database.execute(
            builder.update('items', {
                equipped: equipped,
                    slot: slot
            }, 'id = ? AND characterId = ?', id, characterId)
        );
    },

    deleteItem(characterId, id) {
        return Database.execute(
            builder.delete('items', 'id = ? AND characterId = ?', id, characterId)
        )
    },

    deleteItems(characterId) {
        return Database.execute(
            builder.delete('items', 'characterId = ?', characterId)
        );
    },

    fetchWarehouseItems(characterId) {
        return Database.execute(
            builder.select('warehouse_items', ['*'], 'characterId = ?', characterId)
        ).then((rows) => rows.map(normalizeRowNumbers));
    },

    setWarehouseItem(characterId, item) {
        const values = {
            selfId: item.selfId,
            name: item.name ?? '',
            amount: item.amount ?? 1,
            characterId
        };
        if (item.petData) values.petData = JSON.stringify(item.petData);
        return Database.execute(
            builder.insert('warehouse_items', values)
        );
    },

    updateWarehouseItemAmount(characterId, id, amount) {
        return Database.execute(
            builder.update('warehouse_items', { amount }, 'id = ? AND characterId = ?', id, characterId)
        );
    },

    deleteWarehouseItem(characterId, id) {
        return Database.execute(
            builder.delete('warehouse_items', 'id = ? AND characterId = ?', id, characterId)
        );
    },

    transferInventoryToWarehouse(characterId, item) {
        return inTransaction(async () => {
            const inventory = await conn.query(
                'SELECT id, amount FROM items WHERE id = ? AND characterId = ? FOR UPDATE',
                [item.id, characterId]
            );
            const source = inventory[0];
            if (!source || Number(source.amount) < item.amount) throw new Error('inventory item changed');

            // Every warehouse transfer locks the inventory row first, then the
            // warehouse row. This avoids deposit/withdraw lock inversions.
            const existing = item.stackable ? await conn.query(
                'SELECT id, amount FROM warehouse_items WHERE characterId = ? AND selfId = ? FOR UPDATE',
                [characterId, item.selfId]
            ) : [];
            const target = existing[0];
            const warehouseAmount = (Number(target?.amount) || 0) + item.amount;
            let warehouseId = target?.id;

            if (target) {
                await conn.query('UPDATE warehouse_items SET amount = ? WHERE id = ? AND characterId = ?', [warehouseAmount, warehouseId, characterId]);
            } else {
                const inserted = await conn.query(
                    'INSERT INTO warehouse_items (selfId, name, amount, petData, characterId) VALUES (?, ?, ?, ?, ?)',
                    [item.selfId, item.name || '', item.amount, petDataValue(item.petData), characterId]
                );
                warehouseId = Number(inserted.insertId);
            }

            const inventoryAmount = Number(source.amount) - item.amount;
            if (inventoryAmount === 0) {
                await conn.query('DELETE FROM items WHERE id = ? AND characterId = ?', [item.id, characterId]);
            } else {
                await conn.query('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [inventoryAmount, item.id, characterId]);
            }
            return { warehouseId, warehouseAmount, inventoryAmount };
        });
    },

    transferWarehouseToInventory(characterId, item) {
        return inTransaction(async () => {
            // Keep the same lock order as deposits: inventory first, warehouse second.
            const existing = item.stackable ? await conn.query(
                'SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? FOR UPDATE',
                [characterId, item.selfId]
            ) : [];
            const target = existing[0];
            const warehouse = await conn.query(
                'SELECT id, amount, petData FROM warehouse_items WHERE id = ? AND characterId = ? FOR UPDATE',
                [item.id, characterId]
            );
            const source = warehouse[0];
            if (!source || Number(source.amount) < item.amount) throw new Error('warehouse item changed');

            const inventoryAmount = (Number(target?.amount) || 0) + item.amount;
            let inventoryId = target?.id;
            if (target) {
                await conn.query('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [inventoryAmount, inventoryId, characterId]);
            } else {
                const inserted = await conn.query(
                    'INSERT INTO items (selfId, name, amount, equipped, slot, petData, characterId) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [item.selfId, item.name || '', item.amount, false, 0, source.petData, characterId]
                );
                inventoryId = Number(inserted.insertId);
            }

            const warehouseAmount = Number(source.amount) - item.amount;
            if (warehouseAmount === 0) {
                await conn.query('DELETE FROM warehouse_items WHERE id = ? AND characterId = ?', [item.id, characterId]);
            } else {
                await conn.query('UPDATE warehouse_items SET amount = ? WHERE id = ? AND characterId = ?', [warehouseAmount, item.id, characterId]);
            }
            return { inventoryId, inventoryAmount, warehouseAmount, petData: source.petData };
        });
    },

    fetchCharacterQuests(characterId) {
        return Database.execute(
            builder.select('character_quests', ['*'], 'characterId = ?', characterId)
        ).then((rows) => rows.map(normalizeRowNumbers));
    },

    setCharacterQuest(characterId, questId, state, variables) {
        return Database.execute([
            `INSERT INTO character_quests (characterId, questId, state, variables)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE state = VALUES(state), variables = VALUES(variables)`,
            [characterId, questId, state, JSON.stringify(variables || {})]
        ]);
    },

    deleteCharacterQuest(characterId, questId) {
        return Database.execute(
            builder.delete('character_quests', 'characterId = ? AND questId = ?', characterId, questId)
        );
    },

    fetchCharacterRecipes(characterId) {
        return Database.execute([
            'SELECT recipeId, type FROM character_recipes WHERE characterId = ?',
            [characterId]
        ]).then((rows) => rows.map(normalizeRowNumbers));
    },

    setCharacterRecipe(characterId, recipeId, type) {
        return Database.execute([
            'INSERT INTO character_recipes (characterId, recipeId, type) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE recipeId = VALUES(recipeId)',
            [characterId, recipeId, type]
        ]);
    },

    craftInventoryItems(characterId, { materials, product, mp }) {
        return inTransaction(async () => {
            const sources = [];
            for (const material of [...materials].sort((left, right) => Number(left.id) - Number(right.id))) {
                const rows = await conn.query(
                    'SELECT id, selfId, amount FROM items WHERE id = ? AND characterId = ? FOR UPDATE',
                    [material.id, characterId]
                );
                const source = rows[0];
                if (!source || Number(source.selfId) !== Number(material.selfId) || Number(source.amount) < Number(material.amount)) {
                    throw new Error('craft material changed');
                }
                sources.push({ id: Number(source.id), amount: Number(source.amount) - Number(material.amount) });
            }

            const targets = product?.stackable ? await conn.query(
                'SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? FOR UPDATE',
                [characterId, product.selfId]
            ) : [];
            const target = targets[0];
            const productAmount = (Number(target?.amount) || 0) + Number(product?.amount || 0);
            let productId = Number(target?.id) || 0;

            for (const source of sources) {
                if (source.amount === 0) {
                    await conn.query('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, characterId]);
                } else {
                    await conn.query('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [source.amount, source.id, characterId]);
                }
            }

            if (target) {
                await conn.query('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [productAmount, productId, characterId]);
            } else if (product) {
                const inserted = await conn.query(
                    'INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, ?, ?, ?)',
                    [product.selfId, product.name || '', product.amount, false, product.slot || 0, characterId]
                );
                productId = Number(inserted.insertId);
            }

            await conn.query('UPDATE characters SET mp = ? WHERE id = ?', [mp, characterId]);
            return { sources, product: product ? { id: productId, amount: productAmount } : null };
        });
    },

    crystallizeInventoryItem(characterId, { sourceId, sourceSelfId, crystalId, crystalName, crystalAmount }) {
        return inTransaction(async () => {
            const source = (await conn.query('SELECT id, selfId, amount, equipped FROM items WHERE id = ? AND characterId = ? FOR UPDATE', [sourceId, characterId]))[0];
            if (!source || Number(source.selfId) !== Number(sourceSelfId) || Number(source.amount) !== 1 || Number(source.equipped) !== 0) throw new Error('crystallize source changed');
            const existing = (await conn.query('SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? FOR UPDATE', [characterId, crystalId]))[0];
            const amount = (Number(existing?.amount) || 0) + crystalAmount;
            let id = Number(existing?.id) || 0;
            await conn.query('DELETE FROM items WHERE id = ? AND characterId = ?', [sourceId, characterId]);
            if (existing) await conn.query('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [amount, id, characterId]);
            else { const inserted = await conn.query('INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, ?, ?, ?)', [crystalId, crystalName || '', crystalAmount, false, 0, characterId]); id = Number(inserted.insertId); }
            return { crystalId, id, amount };
        });
    },

    craftForCustomer(crafterId, customerId, { materials, product, crafterMp, price, adena }) {
        return inTransaction(async () => {
            const sources = [];
            for (const material of [...materials].sort((left, right) => Number(left.id) - Number(right.id))) {
                const rows = await conn.query(
                    'SELECT id, selfId, amount FROM items WHERE id = ? AND characterId = ? FOR UPDATE',
                    [material.id, customerId]
                );
                const source = rows[0];
                if (!source || Number(source.selfId) !== Number(material.selfId) || Number(source.amount) < Number(material.amount)) {
                    throw new Error('customer craft material changed');
                }
                sources.push({ id: Number(source.id), amount: Number(source.amount) - Number(material.amount) });
            }

            const fee = Number(price) || 0;
            let customerAdena = null;
            let crafterAdena = null;
            if (fee > 0) {
                customerAdena = (await conn.query(
                    'SELECT id, amount FROM items WHERE characterId = ? AND selfId = 57 FOR UPDATE', [customerId]
                ))[0];
                if (!customerAdena || Number(customerAdena.amount) < fee) throw new Error('customer adena changed');
                crafterAdena = (await conn.query(
                    'SELECT id, amount FROM items WHERE characterId = ? AND selfId = 57 FOR UPDATE', [crafterId]
                ))[0];
            }

            const targets = product?.stackable ? await conn.query(
                'SELECT id, amount FROM items WHERE characterId = ? AND selfId = ? FOR UPDATE',
                [customerId, product.selfId]
            ) : [];
            const target = targets[0];
            const productAmount = (Number(target?.amount) || 0) + Number(product?.amount || 0);
            let productId = Number(target?.id) || 0;

            for (const source of sources) {
                if (source.amount === 0) {
                    await conn.query('DELETE FROM items WHERE id = ? AND characterId = ?', [source.id, customerId]);
                } else {
                    await conn.query('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [source.amount, source.id, customerId]);
                }
            }

            if (target) {
                await conn.query('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [productAmount, productId, customerId]);
            } else if (product) {
                const inserted = await conn.query(
                    'INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, ?, ?, ?)',
                    [product.selfId, product.name || '', product.amount, false, product.slot || 0, customerId]
                );
                productId = Number(inserted.insertId);
            }

            if (fee > 0) {
                await conn.query('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [
                    Number(customerAdena.amount) - fee, customerAdena.id, customerId
                ]);
                if (crafterAdena) {
                    await conn.query('UPDATE items SET amount = ? WHERE id = ? AND characterId = ?', [
                        Number(crafterAdena.amount) + fee, crafterAdena.id, crafterId
                    ]);
                } else {
                    const inserted = await conn.query(
                        'INSERT INTO items (selfId, name, amount, equipped, slot, characterId) VALUES (?, ?, ?, ?, ?, ?)',
                        [57, adena?.name || 'Adena', fee, false, 0, crafterId]
                    );
                    crafterAdena = { id: Number(inserted.insertId), amount: 0 };
                }
            }

            await conn.query('UPDATE characters SET mp = ? WHERE id = ?', [crafterMp, crafterId]);
            return {
                sources,
                product: product ? { id: productId, amount: productAmount } : null,
                customerAdena: fee > 0 ? { id: Number(customerAdena.id), amount: Number(customerAdena.amount) - fee } : null,
                crafterAdena: fee > 0 ? { id: Number(crafterAdena.id), amount: Number(crafterAdena.amount) + fee } : null
            };
        });
    },

    updateItemPetData(characterId, id, petData) {
        return Database.execute(
            builder.update('items', {
                petData: JSON.stringify(petData || {})
            }, 'id = ? AND characterId = ?', id, characterId)
        );
    },

    fetchClans() {
        return Database.execute(
            builder.select('clans', ['*'])
        );
    },

    createClanCrest(clanId, kind, data) {
        return Database.execute([
            'INSERT INTO clan_crests (clanId, kind, data) VALUES (?, ?, ?)',
            [clanId, kind, data]
        ]);
    },

    fetchClanCrest(id) {
        return Database.execute(
            builder.selectOne('clan_crests', ['*'], 'id = ? LIMIT 1', id)
        );
    },

    createClan(data) {
        return Database.execute(
            builder.insert('clans', {
                name: data.name,
                leaderId: data.leaderId
            })
        );
    },

    updateClanCrest(id, crestId) {
        return Database.execute(
            builder.update('clans', {
                crestId: crestId
            }, 'id = ? LIMIT 1', id)
        );
    },

    updateClanLevel(id, level) {
        return Database.execute(
            builder.update('clans', {
                level: level
            }, 'id = ? LIMIT 1', id)
        );
    },

    updateCharacterClan(id, clanId, clanPrivileges, clanJoinExpiryTime, clanCreateExpiryTime) {
        return Database.execute(
            builder.update('characters', {
                clanId: clanId,
                clanPrivileges: clanPrivileges,
                clanJoinExpiryTime: clanJoinExpiryTime,
                clanCreateExpiryTime: clanCreateExpiryTime
            }, 'id = ? LIMIT 1', id)
        );
    },

    updateCharacterClanPrivileges(id, clanPrivileges) {
        return Database.execute(
            builder.update('characters', {
                clanPrivileges: clanPrivileges
            }, 'id = ? LIMIT 1', id)
        );
    },

    deleteGearItems(characterId) {
        return Database.execute(
            builder.delete('items', 'characterId = ? AND selfId != 57', characterId)
        );
    },

    setShortcut(characterId, shortcut) {
        return Database.execute(
            builder.insert('shortcuts', {
                         id: shortcut.id,
                       kind: shortcut.kind,
                       slot: shortcut.slot,
                    unknown: shortcut.unknown,
                characterId: characterId
            })
        );
    },

    fetchShortcuts(characterId) {
        return Database.execute(
            builder.select('shortcuts', ['*'], 'characterId = ?', characterId)
        );
    },

    deleteShortcut(characterId, slot) {
        return Database.execute(
            builder.delete('shortcuts', 'slot = ? AND characterId = ?', slot, characterId)
        )
    },

    deleteShortcuts(characterId) {
        return Database.execute(
            builder.delete('shortcuts', 'characterId = ?', characterId)
        );
    },

    setMacro(characterId, macro) {
        return Database.execute([
            `INSERT INTO macros (characterId, id, icon, name, descr, acronym, commands)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE icon = VALUES(icon), name = VALUES(name), descr = VALUES(descr),
                 acronym = VALUES(acronym), commands = VALUES(commands)`,
            [characterId, macro.id, macro.icon, macro.name, macro.descr, macro.acronym, JSON.stringify(macro.commands)]
        ]);
    },

    fetchMacros(characterId) {
        return Database.execute(
            builder.select('macros', ['*'], 'characterId = ?', characterId)
        ).then((rows) => rows.map((row) => ({
            ...normalizeRowNumbers(row),
            commands: (() => {
                try { return JSON.parse(row.commands); }
                catch (_) { return []; }
            })()
        })));
    },

    deleteMacro(characterId, macroId) {
        return Database.execute(
            builder.delete('macros', 'characterId = ? AND id = ?', characterId, macroId)
        );
    },

    deleteMacros(characterId) {
        return Database.execute(
            builder.delete('macros', 'characterId = ?', characterId)
        );
    },

    deleteMacroShortcuts(characterId, macroId) {
        return Database.execute(
            builder.delete('shortcuts', 'characterId = ? AND kind = 4 AND id = ?', characterId, macroId)
        );
    },

    updateCharacterLocation(id, coords) {
        return Database.execute(
            builder.update('characters', {
                locX: coords.locX,
                locY: coords.locY,
                locZ: coords.locZ,
                head: coords.head ?? -1,
            }, 'id = ? LIMIT 1', id)
        );
    },

    updateCharacterExperience(id, level, exp, sp) {
        return Database.execute(
            builder.update('characters', {
                level: level,
                  exp: exp,
                   sp: sp
            }, 'id = ? LIMIT 1', id)
        );
    },

    updateCharacterVitals(id, hp, maxHp, mp, maxMp) {
        return Database.execute(
            builder.update('characters', {
                   hp: hp,
                maxHp: maxHp,
                   mp: mp,
                maxMp: maxMp,
            }, 'id = ? LIMIT 1', id)
        );
    },

    updateCharacterStatus(id, { hp, mp, cp, effects }) {
        return Database.execute(
            builder.update('characters', {
                hp,
                mp,
                cp,
                effects
            }, 'id = ? LIMIT 1', id)
        );
    },

    updateCharacterPvpPkKarma(id, pvp, pk, karma) {
        return Database.execute(
            builder.update('characters', {
                  pvp: pvp,
                   pk: pk,
                karma: karma
            }, 'id = ? LIMIT 1', id)
        );
    },

    updateCharacterClassId(id, classId) {
        return Database.execute(
            builder.update('characters', {
                classId: classId
            }, 'id = ? LIMIT 1', id)
        );
    }
};

module.exports = Database;
