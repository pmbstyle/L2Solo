const ClassProgression = invoke('GameServer/ClassProgression');
const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const Database       = invoke('Database');

const Shared = {
    fetchClassInformation: (classId) => {
        return new Promise((success, fail) => {
            let model = ClassProgression.firstClassRow(DataCache.classTemplates, classId, 'strict');
            return model ? success(model) : fail();
        });
    },

    fetchCharacters(accountId) {
        // Every read failure rejects the returned Promise, so the caller's
        // catch (or the packet dispatch boundary) sees it.
        const createPaperdoll = (character) => {
            return Promise.all([
                Database.fetchItems(character.id, 'character_list'),
                Database.fetchCharacterRecipes(character.id)
            ]).then(([items, recipes]) => {
                character.items = items;
                character.dwarvenRecipes = recipes.filter((recipe) => recipe.type === 'dwarven');
                character.commonRecipes = recipes.filter((recipe) => recipe.type === 'common');
                character.paperdoll = utils.tupleAlloc(15 + 1, {});

                // Keep one persistent item per paperdoll slot. Earlier versions could
                // leave an old weapon equipped in the DB, making it reappear after the
                // visible weapon was removed. Prefer the newest record and repair losers.
                const equippedBySlot = new Map();
                const repaired = [];
                items.filter((item) => item.equipped === 1).forEach((item) => {
                    const current = equippedBySlot.get(item.slot);
                    if (!current || Number(item.id) > Number(current.id)) {
                        if (current) {
                            current.equipped = 0;
                            repaired.push(current);
                        }
                        equippedBySlot.set(item.slot, item);
                    }
                    else {
                        item.equipped = 0;
                        repaired.push(item);
                    }
                });

                // Slot 14 is a two-handed weapon in the C4
                // paperdoll. Older starter-bot rows could retain a
                // shield in slot 8 as well, which grants impossible
                // shield stats and renders an invalid character.
                if (equippedBySlot.has(14) && equippedBySlot.has(8)) {
                    const shield = equippedBySlot.get(8);
                    shield.equipped = 0;
                    repaired.push(shield);
                    equippedBySlot.delete(8);
                }

                Promise.all(repaired.map((item) => Database.updateItemEquipState(character.id, item.id, false, item.slot)))
                    .catch((error) => utils.infoWarn('Character', 'failed to repair equipment state for %s: %s', character.name, error.message));

                [...equippedBySlot.values()].forEach((item) => {
                    if (item.slot === 15) { // FB Armor, stupid implementation
                        character.paperdoll[10] = { id: item.id, selfId: item.selfId };
                    }

                    character.paperdoll[item.slot] = { id: item.id, selfId: item.selfId };
                });
            });
        };

        // The read starts synchronously, as before; a synchronous throw from
        // it rejects instead of escaping to the caller.
        return new Promise((resolve) => resolve(Database.fetchCharacters(accountId))).then((characters) => {
            return characters.reduce((previous, character) => {
                return previous.then(() => {
                    return createPaperdoll(character);
                });
            }, Promise.resolve()).then(() => characters);
        });
    },

    enterCharacterHall(session, characters) {
        invoke('GameServer/World/World').retireUserActor(session, session.actor);
        session.actor = null;
        session.characterSelection = (session.characterSelection || 0) + 1;
        session.characterHall = true;
        session.characterLeaving = false;
        session.worldEntryActor = null;
        session.knownNpcIds?.clear();
        session.knownCharacterActors?.clear();
        session.dataSendToMe(
            ServerResponse.charSelectInfo(characters)
        );
    }
};

module.exports = Shared;
