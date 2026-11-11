const StarterItemCatalog = invoke('GameServer/Knowledge/StarterItemCatalog');
const ClassProgression = invoke('GameServer/ClassProgression');
const ServerResponse = invoke('GameServer/Network/Response');
const Shared         = invoke('GameServer/Network/Shared');
const DataCache      = invoke('GameServer/DataCache');
const ReceivePacket  = invoke('Packet/Receive');
const Database       = invoke('Database');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');

function createNewChar(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet
        .readS()  // Name
        .readD()  // Race
        .readD()  // Sex
        .readD()  // Class ID
        .readD()  // Int (constant 0?)
        .readD()  // Str (constant 0?)
        .readD()  // Con (constant 0?)
        .readD()  // Men (constant 0?)
        .readD()  // Dex (constant 0?)
        .readD()  // Wit (constant 0?)
        .readD()  // Hair
        .readD()  // Hair Color
        .readD(); // Face

    return consume(session, {
             name: packet.data[ 0],
             race: packet.data[ 1],
              sex: packet.data[ 2],
          classId: packet.data[ 3],
             hair: packet.data[10],
        hairColor: packet.data[11],
             face: packet.data[12],
    });
}

function consume(session, data) {
    return Database.fetchCharacterName(data.name).then((rows) => {
        if (rows[0]) {
            return session.dataSendToMe(
                ServerResponse.charCreateFail(0x02)
            );
        }

        return Shared.fetchClassInformation(data.classId).then((classInfo) => {
            const spawns = fetchSpawnPoints(data.classId);
            const coords = spawns[utils.randomNumber(utils.size(spawns))];

            data = {
                ...data, ...classInfo.vitals, ...coords
            };

            return Database.createCharacter(session.accountId, data).then((packet) => {
                // Success is reported once the starter kit is written; a
                // failed write reaches the catch below instead.
                const charId = Number(packet.insertId);
                return Promise.all([
                    awardBaseSkills   (charId, data.classId),
                    awardBaseGear     (charId, data.classId),
                    awardBaseShots    (charId, data.classId),
                    awardBaseShortcuts(charId, data.classId)
                ]);
            }).then(() => {
                session.dataSendToMe(
                    ServerResponse.charCreateSuccess()
                );

                return Shared.fetchCharacters(session.accountId).then((characters) => {
                    Shared.enterCharacterHall(session, characters);
                });
            });
        });
    }).catch((error) => {
        // A rejected promise nobody handles takes the whole server down. The
        // client only ever sees a failed creation.
        utils.infoWarn('Character', 'failed to create %s: %s', data.name, error.message);

        session.dataSendToMe(
            ServerResponse.charCreateFail(0x00)
        );
    });
}

function fetchSpawnPoints(classId) {
    return ClassProgression.firstClassRow(DataCache.newbieSpawns, classId, 'strict')?.spawns;
}

function awardBaseSkills(id, classId) {
    const writes = [];
    DataCache.fetchSkillTreeFromClassId(classId, (skillTree) => {
        const skills = skillTree.skills;
        const level1 = skills?.filter((ob) => ob.levels.find((ob) => ob.pLevel === 1)) ?? [];

        level1.forEach((skill) => {
            skill.levels = skill.levels.filter((ob) => ob.pLevel === 1);
            DataCache.fetchSkillFromSelfId(skill.selfId, (skillDetails) => {
                skill = { ...utils.crushOb(skill), passive: skillDetails.template?.passive ?? false };
                writes.push(Database.setSkill(skill, id));
            });
        });
    });
    return Promise.all(writes);
}

function awardBaseGear(id, classId) {
    return Promise.all(StarterItemCatalog.starterRows(DataCache.newbieItems, classId, DataCache.items)
        .map((row) => Database.setItem(id, row)));
}

function awardBaseShots(id, classId) {
    return ShotStock.ensureCharacterStock(id, { classId, targetAmount: ShotStock.DEFAULT_TARGET_AMOUNT })
        .catch((err) => utils.infoWarn('Character', 'failed to award starter shots: %s', err.message));
}

function awardBaseShortcuts(id, classId) {
    const shortcuts = ClassProgression.firstClassRow(DataCache.newbieShortcuts, classId, 'strict')?.shortcuts ?? [];
    return Promise.all(shortcuts.map((shortcut) => Database.setShortcut(id, shortcut)));
}

module.exports = createNewChar;
