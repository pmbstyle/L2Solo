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

                        items.filter((ob) => ob.equipped === 1).forEach((item) => {
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
