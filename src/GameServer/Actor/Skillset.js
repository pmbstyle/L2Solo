const SkillModel = invoke('GameServer/Model/Skill');
const DataCache  = invoke('GameServer/DataCache');
const Database   = invoke('Database');
const CommonCraftSkills = invoke('GameServer/Crafting/CommonCraftSkills');

function definedLevel(skill, requestedLevel) {
    const levels = skill?.levels || [];
    return levels.find((entry) => Number(entry.level) === Number(requestedLevel))
        || levels.filter((entry) => Number(entry.level) <= Number(requestedLevel)).at(-1)
        || null;
}

class Skillset {
    constructor() {
        this.resetSkills();
    }

    resetSkills() {
        this.skills = [];
    }

    fetchSkills() {
        return this.skills;
    }

    fetchSkill(selfId) {
        return this.skills.find((ob) => ob.fetchSelfId() === selfId);
    }

    // Arena opponents are runtime-only actors. Populate their skillbook from
    // a caller-provided snapshot instead of querying/reconciling a synthetic
    // character id in SQLite.
    populateSnapshot(ownedSkills = []) {
        this.resetSkills();
        const skillLevel = (skill, requestedLevel) => skill?.levels?.find((entry) => (
            Number(entry.level) === Number(requestedLevel)
        )) || skill?.levels?.filter((entry) => Number(entry.level) <= Number(requestedLevel)).at(-1);

        (ownedSkills || []).forEach((ownedSkill) => {
            const row = ownedSkill?.model || ownedSkill;
            const definition = DataCache.skills?.find((skill) => Number(skill.selfId) === Number(row?.selfId));
            if (!definition) return;
            const level = skillLevel(definition, row.level);
            if (!level) return;
            this.skills.push(new SkillModel({
                ...utils.crushOb(definition),
                ...level,
                selfId: definition.selfId,
                name: row.name || definition.template?.name,
                passive: row.passive ?? definition.template?.passive ?? false
            }));
        });
        return this.skills;
    }

    populate(characterId, callback = () => {}) {
        // Start anew
        this.resetSkills();

        const skillLevelLookup = (skill, level, success) => {
            const item = definedLevel(skill, level);
            item ? success(item) : utils.infoWarn('GameServer', 'unknown Skill Id %d with Level %d', skill.selfId, level);
        };

        return Database.fetchSkills(characterId).then((ownedSkills) => {
            ownedSkills.forEach((ownedSkill) => {
                DataCache.fetchSkillFromSelfId(ownedSkill.selfId, (skill) => {
                    skillLevelLookup(skill, ownedSkill.level, (level) => {
                        delete skill.levels; this.skills.push(new SkillModel({
                            ...utils.crushOb(skill), ...level
                        }));
                    });
                });
            });

            callback();
            return this.skills;
        });
    }

    populateForActor(actor, callback = () => {}) {
        const characterId = actor.fetchId();
        return this.reconcileAutomaticSkills(characterId, actor.fetchLevel?.())
            .catch((error) => {
                utils.infoWarn('Datapack', 'failed to reconcile automatic skills for %d: %s', characterId, error.message || error);
            })
            .then(() => this.populate(characterId, callback));
    }

    reconcileAutomaticSkills(characterId, characterLevel) {
        return Database.fetchSkills(characterId).then((ownedSkills) => {
            const desiredSkills = CommonCraftSkills.automaticSkills(characterLevel);
            return Promise.all(desiredSkills.map(({ selfId, level }) => {
                const stored = ownedSkills.find((skill) => Number(skill.selfId) === selfId);
                if (Number(stored?.level) >= level) return undefined;

                const definition = DataCache.skills.find((skill) => skill.selfId === selfId);
                const resolved = definedLevel(definition, level);
                if (!definition || !resolved) {
                    utils.infoWarn('Datapack', 'automatic Skill SelfId %d Level %d is undefined', selfId, level);
                    return undefined;
                }

                return Database.setSkill({
                    selfId,
                    name: definition.template?.name || definition.name,
                    passive: definition.template?.passive ?? false,
                    level: resolved.level
                }, characterId);
            }));
        });
    }

    awardSkills(id, classId, level) {
        return new Promise((success) => {
            const createOrUpdateSkill = (skill) => {
                const skillDetails = DataCache.skills.find((item) => item.selfId === skill.selfId);
                if (!skillDetails) {
                    // A tree entry without a definition used to leave this promise pending forever.
                    // That is especially harmful during class transfer: the class is persisted before
                    // the client refresh packets are sent.
                    utils.infoWarn('Datapack', 'SkillTree ClassId %d references unknown Skill SelfId %d', classId, skill.selfId);
                    return Promise.resolve();
                }

                return new Promise((done) => {
                    const requested = skill.levels.filter((ob) => ob.pLevel <= level).pop();
                    const resolved = definedLevel(skillDetails, requested?.level);
                    if (!resolved) {
                        utils.infoWarn('GameServer', 'unknown Skill Id %d with Level %d', skill.selfId, requested?.level);
                        done();
                        return;
                    }

                    Database.fetchSkill(id, skill.selfId).then((ownedSkill) => {
                        const storedLevel = ownedSkill[0]?.level;

                        // The skill is present in DB, update its level
                        if (storedLevel) {
                            Database.updateSkillLevel(id, skill.selfId, resolved.level).then(() => {
                                done();
                            });
                        }
                        else {
                            // The skill is a new addition based on character's level
                            skill = {
                                ...utils.crushOb(skill),
                                passive: skillDetails.template?.passive ?? false,
                                level: resolved.level
                            };
                            Database.setSkill(skill, id).then(() => {
                                done();
                            });
                        }
                    });
                });
            };

            DataCache.fetchSkillTreeFromClassId(classId, (skillTree) => {
                const skills = skillTree.skills;
                const levelX = skills?.filter((ob) => ob.levels.find((ob) => ob.pLevel <= level)) ?? [];

                // Loop on skills that match character's current level
                levelX.reduce((previous, skill) => {
                    return previous.then(() => {
                        return createOrUpdateSkill(skill);
                    });
                }, Promise.resolve()).then(() => {
                    // Re-instantiate all character skills
                    this.populate(id, () => {
                        return success();
                    });
                });
            });
        });
    }
}

module.exports = Skillset;
