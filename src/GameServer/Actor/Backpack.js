const ServerResponse = invoke('GameServer/Network/Response');
const BackpackModel  = invoke('GameServer/Model/Backpack');
const SkillModel     = invoke('GameServer/Model/Skill');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');
const ConsoleText    = invoke('GameServer/ConsoleText');
const World          = invoke('GameServer/World/World');
const Database       = invoke('Database');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');

class Backpack extends BackpackModel {
    constructor(data) {
        // Parent inheritance
        super(data.paperdoll);

        data.items.forEach((item) => {
            this.insertItem(item.id, item.selfId, item);
        });
    }

    insertItem(id, selfId, item = {}) { // TODO: Price still 0 with admin shop
        DataCache.fetchItemFromSelfId(selfId, (itemDetails) => {
            if (item.slot) delete itemDetails.etc.slot; this.items.push(new Item(id, {
                ...item, ...utils.crushOb(itemDetails)
            }));
        });
    }

    deleteItem(session, id, amount, callback = () => {}) {
        if (session.actor.isDead()) {
            return;
        }

        this.fetchItem(id, (item) => {
            const total = item.fetchAmount() - amount;
            if (total > 0) {
                // Update memory state instantly
                item.setAmount(total);
                session.dataSendToMe(ServerResponse.itemsList(this.fetchItems()));
                callback(item.fetchSelfId());

                // Update database in the background
                Database.updateItemAmount(session.actor.fetchId(), item.fetchId(), total).catch((err) => {
                    utils.infoWarn('Database', 'Failed to update item amount: ' + err);
                });
            }
            else {
                // Update memory state instantly
                this.items = this.fetchItems().filter((ob) => ob.fetchId() !== id);
                session.dataSendToMe(ServerResponse.itemsList(this.fetchItems()));
                callback(item.fetchSelfId());

                // Update database in the background
                Database.deleteItem(session.actor.fetchId(), item.fetchId()).catch((err) => {
                    utils.infoWarn('Database', 'Failed to delete item: ' + err);
                });
            }
        });
    }

    consumeSoulshot(session, callback = () => {}) {
        if (session.actor.isDead()) {
            return callback(false);
        }

        const plan = ShotStock.planForActor(session.actor);
        if (plan.kind !== 'soulshot') {
            return callback(false);
        }

        const found = this.items.find(item => item.fetchSelfId() === plan.selfId);
        if (found) {
            this.deleteItem(session, found.fetchId(), 1, () => {
                callback(true);
            });
        } else {
            callback(false);
        }
    }

    consumeSpiritshot(session, callback = () => {}) {
        if (session.actor.isDead()) {
            return callback(false);
        }

        const plan = ShotStock.planForActor(session.actor);
        if (plan.kind !== 'spiritshot') {
            return callback(false);
        }

        const found = this.items.find(item => item.fetchSelfId() === plan.selfId);
        if (found) {
            this.deleteItem(session, found.fetchId(), 1, () => {
                callback(true);
            });
        } else {
            callback(false);
        }
    }

    dropItem(session, id, amount, locX, locY, locZ) {
        this.deleteItem(session, id, amount, (selfId) => {
            World.spawnItem(session, selfId, amount, {
                locX: locX,
                locY: locY,
                locZ: locZ,
            });
        });
    }

    updateAmount(id, amount) {
        this.fetchItem(id, (item) => { item.setAmount(amount); });
    }

    useItem(session, id) {
        this.fetchItem(id, (item) => {
            if (item.isWearable()) {
                this.equipGear(session, item);
            }
            else {
                if (ShotStock.SOULSHOT_IDS.includes(item.fetchSelfId())) {
                    if (session.actor.soulshotLoaded) {
                        return; // Already loaded
                    }
                    this.deleteItem(session, id, 1, () => {
                        session.actor.soulshotLoaded = true;
                        
                        // Play activation effect (Skill 2039)
                        session.dataSendToMeAndOthers(
                            ServerResponse.skillStarted(session.actor, session.actor.fetchId(), {
                                fetchSelfId: () => 2039,
                                fetchCalculatedHitTime: () => 0,
                                fetchReuseTime: () => 0
                            }), 
                            session.actor
                        );
                    });
                    return;
                }
                else
                if (ShotStock.SPIRITSHOT_IDS.includes(item.fetchSelfId())) {
                    if (session.actor.spiritshotLoaded) {
                        return; // Already loaded
                    }
                    this.deleteItem(session, id, 1, () => {
                        session.actor.spiritshotLoaded = true;

                        // Play activation effect (Skill 2047)
                        session.dataSendToMeAndOthers(
                            ServerResponse.skillStarted(session.actor, session.actor.fetchId(), {
                                fetchSelfId: () => 2047,
                                fetchCalculatedHitTime: () => 0,
                                fetchReuseTime: () => 0
                            }),
                            session.actor
                        );
                    });
                    return;
                }
                else
                if ([1665, 1863].includes(item.fetchSelfId())) { // TODO: This needs to be out of here...
                    session.dataSendToMe(
                        ServerResponse.showMap(item.fetchSelfId())
                    );
                    return;
                }
                else
                if (item.fetchSelfId() === 1061) {
                    const details = utils.crushOb(DataCache.skills.find((ob) => ob.selfId === 2032) ?? {});
                    session.dataSendToMeAndOthers(ServerResponse.skillStarted(session.actor, session.actor.fetchId(), new SkillModel(details)), session.actor);
                    return;
                }
                else
                if (item.fetchSelfId() === 736) {
                    const details = utils.crushOb(DataCache.skills.find((ob) => ob.selfId === 2013) ?? {});
                    const skill = new SkillModel(details);
                    const castTime = skill.fetchHitTime() || 20000;

                    if (session.actor.state.fetchCasts()) {
                        return;
                    }

                    session.actor.state.setCasts(true);
                    session.dataSendToMeAndOthers(ServerResponse.skillStarted(session.actor, session.actor.fetchId(), skill), session.actor);
                    session.dataSendToMe(ServerResponse.skillDurationBar(castTime));

                    setTimeout(() => {
                        session.actor.state.setCasts(false);
                        if (session.actor.isDead()) {
                            return;
                        }

                        const coords = { locX: -84318, locY: 244579, locZ: -3730 }; // Talking Island Town
                        this.deleteItem(session, id, 1, () => {
                            const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
                            TeleportTo(session, session.actor, coords);
                        });
                    }, castTime);
                    return;
                }

                utils.infoWarn('GameServer', 'unhandled item action');
            }
        });
    }

    equipGear(session, item) {
        if (session.actor.isDead()) {
            return;
        }

        const slot  = item.fetchSlot();
        const equip = this.equipment;

        if (slot === equip.weapon || slot === equip.shield) {
            this.unequipGear(session, equip.dual);
        }
        else // Unequip both hands
        if (slot === equip.dual) {
            this.unequipGear(session, equip.weapon);
            this.unequipGear(session, equip.shield);
        }
        else // Unequip one-piece armor
        if (slot === equip.chest || slot === equip.pants) {
            this.unequipGear(session, equip.armor);
        }
        else // Unequip top and bottom armor
        if (slot === equip.armor) {
            this.unequipGear(session, equip.chest);
            this.unequipGear(session, equip.pants);
        }
        else // Check if ear place is taken
        if (slot === equip.earr || slot === equip.earl) {
            if (this.paperdoll[equip.earr]?.id) {
                item.setSlot(equip.earl);
            }
        }
        else // Check if fin place is taken
        if (slot === equip.fr || slot === equip.fl) {
            if (this.paperdoll[equip.fr]?.id) {
                item.setSlot(equip.fl);
            }
        }

        const newSlot = item.fetchSlot();
        this.unequipGear(session, newSlot);
        this.equipPaperdoll(newSlot, item.fetchId(), item.fetchSelfId());
        item.setEquipped(true);

        ConsoleText.transmit(session, ConsoleText.caption.equipped, [
            { kind: ConsoleText.kind.item, value: item.fetchSelfId() }
        ]);

        // Recalculate
        invoke(path.actor).calculateStats(session, session.actor);
    }

    unequipGear(session, slot) {
        if (session.actor.isDead()) {
            return;
        }

        // Start a database timer to update equipped state
        this.updateDatabaseTimer(session.actor.fetchId());

        this.fetchItem(this.fetchPaperdollId(slot), (item) => {
            // Unequip from actor
            this.unequipPaperdoll(slot);
            item.setEquipped(false);

            ConsoleText.transmit(session, ConsoleText.caption.unequipped, [
                { kind: ConsoleText.kind.item, value: item.fetchSelfId() }
            ]);

            // Move item to the end (not official?)
            this.items = this.items.filter(ob => ob.fetchId() !== item?.fetchId());
            this.items.unshift(item);

            // Recalculate
            invoke(path.actor).calculateStats(session, session.actor);
        });
    }

    updateDatabaseTimer(characterId) {
        clearTimeout(this.dbTimer);
        this.dbTimer = setTimeout(() => {
            const wearables = this.items.filter((ob) => ob.isWearable()) ?? [];
            wearables.forEach((item) => {
                Database.updateItemEquipState(characterId, item.fetchId(), item.fetchEquipped(), item.fetchSlot());
            });
        }, 3000);
    }
}

module.exports = Backpack;
