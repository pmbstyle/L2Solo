const ServerResponse = invoke('GameServer/Network/Response');
const DataCache      = invoke('GameServer/DataCache');
const Database       = invoke('Database');

const Shared = {
    fetchClassInformation: (classId) => {
        return new Promise((success, fail) => {
            let model = DataCache.classTemplates.find(ob => ob.classId === classId);
            return model ? success(model) : fail();
        });
    },

    fetchCharacters(accountId) {
        return new Promise((success) => {
            const createPaperdoll = (character) => {
                return new Promise((done) => {
                    Promise.all([
                        Database.fetchItems(character.id),
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

                        Promise.all(repaired.map((item) => Database.updateItemEquipState(character.id, item.id, false, item.slot)))
                            .catch((error) => utils.infoWarn('Character', 'failed to repair equipment state for %s: %s', character.name, error.message));

                        [...equippedBySlot.values()].forEach((item) => {
                            if (item.slot === 15) { // FB Armor, stupid implementation
                                character.paperdoll[10] = { id: item.id, selfId: item.selfId };
                            }

                            character.paperdoll[item.slot] = { id: item.id, selfId: item.selfId };
                        });
                        done();
                    });
                });
            };

            Database.fetchCharacters(accountId).then((characters) => {
                characters.reduce((previous, character) => {
                    return previous.then(() => {
                        return createPaperdoll(character);
                    });
                }, Promise.resolve()).then(() => {
                    return success(characters);
                });
            });
        });
    },

    enterCharacterHall(session, characters) {
        session.dataSendToMe(
            ServerResponse.charSelectInfo(characters)
        );
    }
};

module.exports = Shared;
