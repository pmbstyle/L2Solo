const ServerResponse = invoke('GameServer/Network/Response');
const BackpackModel  = invoke('GameServer/Model/Backpack');
const SkillModel     = invoke('GameServer/Model/Skill');
const Item           = invoke('GameServer/Item/Item');
const DataCache      = invoke('GameServer/DataCache');
const ConsoleText    = invoke('GameServer/ConsoleText');
const World          = invoke('GameServer/World/World');
const Database       = invoke('Database');
const ShotStock      = invoke('GameServer/Inventory/ShotStock');
const SkillEffects   = invoke('GameServer/Skills/C4SkillEffects');
const C4ItemSkills   = invoke('GameServer/Items/C4ItemSkills');
const C4ExtractableItems = invoke('GameServer/Items/C4ExtractableItems');
const C4EnchantScrolls = invoke('GameServer/Items/C4EnchantScrolls');
const C4EquipmentItemSkills = invoke('GameServer/Items/C4EquipmentItemSkills');
const C4UtilityItems = invoke('GameServer/Items/C4UtilityItems');
const C4SkillRules   = invoke('GameServer/Skills/C4SkillRules');
const ManorData      = invoke('GameServer/Manor/ManorData');
const SpeckMath      = invoke('GameServer/SpeckMath');

const FISHING_ROD_GRADES = {
    6529: 'none',
    6530: 'D',
    6531: 'C',
    6532: 'B',
    6533: 'A',
    6534: 'S',
    7560: 'none'
};

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
        const cost = this.fetchShotCost('soulshot');
        if (cost > 0 && found && found.fetchAmount() >= cost) {
            this.deleteItem(session, found.fetchId(), cost, () => {
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
        const cost = this.fetchShotCost('spiritshot');
        if (cost > 0 && found && found.fetchAmount() >= cost) {
            this.deleteItem(session, found.fetchId(), cost, () => {
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
                    const cost = this.fetchShotCost('soulshot');
                    if (cost <= 0 || item.fetchAmount() < cost) {
                        return;
                    }
                    this.deleteItem(session, id, cost, () => {
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
                    const cost = this.fetchShotCost('spiritshot');
                    if (cost <= 0 || item.fetchAmount() < cost) {
                        return;
                    }
                    this.deleteItem(session, id, cost, () => {
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
                const utilityItem = C4UtilityItems.resolve(item.fetchSelfId());
                if (utilityItem && this.useUtilityItem(session, item, utilityItem)) {
                    return;
                }

                const extractableItem = C4ExtractableItems.resolve(item.fetchSelfId());
                if (extractableItem && this.useExtractableItem(session, id, extractableItem)) {
                    return;
                }

                const enchantScroll = C4EnchantScrolls.resolve(item.fetchSelfId());
                if (enchantScroll && this.useEnchantScrollItem(session, item, enchantScroll)) {
                    return;
                }

                const itemSkill = C4ItemSkills.resolve(item.fetchSelfId());
                if (itemSkill && this.useSkillItem(session, id, itemSkill)) {
                    return;
                }

                utils.infoWarn('GameServer', 'unhandled item action');
            }
        });
    }

    useExtractableItem(session, id, extractableItem) {
        const products = C4ExtractableItems.rollProducts(extractableItem);
        this.deleteItem(session, id, 1, () => {
            products.forEach((item) => {
                World.purchaseItem(session, item.selfId, item.amount);
            });
        });
        return true;
    }

    useEnchantScrollItem(session, item, enchantScroll) {
        if (session.actor.state.fetchCasts()) {
            return true;
        }

        session.activeEnchantItem = {
            itemId: item.fetchId(),
            selfId: item.fetchSelfId(),
            enchantScroll
        };
        session.dataSendToMe(ServerResponse.chooseInventoryItem(item.fetchSelfId()));
        return true;
    }

    useUtilityItem(session, item, utilityItem) {
        switch (utilityItem.handler) {
            case 'WorldMap':
                session.dataSendToMe(ServerResponse.showMap(item.fetchSelfId()));
                return true;
            case 'Calculator':
                session.dataSendToMe(ServerResponse.showCalculator(item.fetchSelfId()));
                return true;
            case 'RollingDice':
                session.dataSendToMeAndOthers(
                    ServerResponse.dice(session.actor, item.fetchSelfId(), this.rollDiceNumber()),
                    session.actor
                );
                return true;
            case 'Book':
                session.dataSendToMe(ServerResponse.npcHtml(0, this.fetchBookHtml(item.fetchSelfId())));
                session.dataSendToMe(ServerResponse.actionFailed());
                return true;
            case 'SevenSignsRecord':
                session.dataSendToMe(ServerResponse.ssqStatus());
                return true;
            case 'SpecialXMas':
                session.dataSendToMe(ServerResponse.showXMasSeal(item.fetchSelfId()));
                return true;
            default:
                return false;
        }
    }

    rollDiceNumber() {
        return Math.floor(Math.random() * 6) + 1;
    }

    fetchBookHtml(selfId) {
        const filename = `data/html/help/${selfId}.htm`;
        const htmlPath = this.fetchBookHelpPath(selfId);
        if (!htmlPath) {
            return `<html><body>My Text is missing:<br>${filename}</body></html>`;
        }
        return utils.parseRawFile(htmlPath);
    }

    fetchBookHelpPath(selfId) {
        const candidates = [
            `data/html/help/${selfId}.htm`,
            `data/Html/help/${selfId}.htm`,
            `tmp/vendor/l2j-lisvus/datapack/data/html/help/${selfId}.htm`
        ];
        return candidates.find((filename) => utils.fileExists(filename));
    }

    useSkillItem(session, id, itemSkill) {
        const skill = this.buildItemSkill(itemSkill);
        if (!skill) {
            return false;
        }

        if (skill.fetchTargetKind() === 'corpse_player') {
            return this.useResurrectionItem(session, id, itemSkill, skill);
        }

        if (itemSkill.handler === 'FishShots') {
            return this.useFishShotItem(session, id, itemSkill, skill);
        }

        if (skill.fetchSkillType() === C4SkillRules.DRAIN_SOUL) {
            return this.useDrainSoulItem(session, id, itemSkill, skill);
        }

        if (skill.fetchSkillType() === C4SkillRules.SOW) {
            return this.useSowingItem(session, id, itemSkill, skill);
        }

        if (skill.fetchSkillType() === C4SkillRules.HARVEST) {
            return this.useHarvestingItem(session, id, itemSkill, skill);
        }

        if (skill.fetchSkillType() === C4SkillRules.CLEANSE && skill.fetchTargetKind() !== 'self') {
            return this.useTargetedCleanseItem(session, id, itemSkill, skill);
        }

        if (skill.fetchTargetKind() !== 'self') {
            return false;
        }

        if (session.actor.state.fetchCasts()) {
            return true;
        }

        const castTime = skill.fetchHitTime() || 0;
        session.actor.state.setCasts(true);
        session.dataSendToMeAndOthers(ServerResponse.skillStarted(session.actor, session.actor.fetchId(), skill), session.actor);
        if (castTime > 0) {
            session.dataSendToMe(ServerResponse.skillDurationBar(castTime));
        }

        const apply = () => {
            session.actor.state.setCasts(false);
            if (session.actor.isDead()) {
                return;
            }

            if (itemSkill.teleport === 'town' || itemSkill.teleport === 'skillCoords') {
                const coords = skill.fetchTeleportCoords?.() || { locX: -84318, locY: 244579, locZ: -3730 }; // Talking Island Town
                this.deleteItem(session, id, 1, () => {
                    const TeleportTo = invoke('GameServer/Actor/Generics/TeleportTo');
                    TeleportTo(session, session.actor, coords);
                });
                return;
            }

            if (itemSkill.consume) {
                this.deleteItem(session, id, 1, () => {
                    this.applySelfItemSkill(session, skill);
                });
                return;
            }

            this.applySelfItemSkill(session, skill);
        };

        if (castTime > 0) {
            setTimeout(apply, castTime);
        } else {
            apply();
        }

        return true;
    }

    useFishShotItem(session, id, itemSkill, skill) {
        const weapon = this.fetchEquippedWeapon();
        if (!this.isFishingRod(weapon)) {
            return true;
        }

        if (weapon.model?.chargedFishShot || weapon.chargedFishShot) {
            return true;
        }

        if (this.normalizeGrade(this.fetchFishingRodGrade(weapon)) !== this.normalizeGrade(itemSkill.grade)) {
            return true;
        }

        this.deleteItem(session, id, 1, () => {
            if (weapon.model) {
                weapon.model.chargedFishShot = true;
            }
            weapon.chargedFishShot = true;
            session.dataSendToMeAndOthers(ServerResponse.skillStarted(session.actor, session.actor.fetchId(), skill), session.actor);
        });
        return true;
    }

    isFishingRod(item) {
        if (!item) {
            return false;
        }
        if (FISHING_ROD_GRADES[Number(item.fetchSelfId?.())]) {
            return true;
        }
        return String(item.fetchKind?.() || '').toLowerCase().includes('fishingrod');
    }

    fetchFishingRodGrade(item) {
        return FISHING_ROD_GRADES[Number(item.fetchSelfId?.())] || item.fetchRank?.() || 'none';
    }

    normalizeGrade(grade) {
        const value = String(grade || 'none').trim();
        if (!value || value === '0' || value.toLowerCase() === 'none') {
            return 'none';
        }
        return value.toUpperCase();
    }

    useSowingItem(session, id, itemSkill, skill) {
        const item = this.fetchItemRaw(id);
        const seedId = item?.fetchSelfId?.();
        const target = this.fetchSelectedNpcTarget(session);
        if (!seedId || !this.canSowTarget(session.actor, target, skill, seedId)) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return true;
        }

        if (session.actor.state.fetchCasts()) {
            return true;
        }

        const mpCost = Number(skill.fetchConsumedMp()) || 0;
        if (!this.canSpendSkillMp(session.actor, mpCost)) {
            return true;
        }

        this.setManorSeedPending(target, seedId, session.actor);
        return this.castTargetedItemSkill(session, target, skill, () => {
            if (session.actor.isDead()) {
                this.clearManorSeedPending(target, session.actor, seedId);
                return;
            }
            if (!this.canSowTarget(session.actor, target, skill, seedId, { allowPending: true })) {
                this.clearManorSeedPending(target, session.actor, seedId);
                return;
            }
            if (!this.spendSkillMp(session.actor, mpCost)) {
                this.clearManorSeedPending(target, session.actor, seedId);
                return;
            }

            this.deleteItem(session, id, 1, () => {
                if (ManorData.sowSuccessChance(seedId, session.actor.fetchLevel?.(), target.fetchLevel?.()) >= Math.random() * 99) {
                    this.setManorSeeded(target);
                } else {
                    this.clearManorSeedPending(target, session.actor, seedId);
                }
            });
        });
    }

    useHarvestingItem(session, id, itemSkill, skill) {
        const target = this.fetchSelectedNpcTarget(session);
        if (!this.canHarvestTarget(session.actor, target, skill)) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return true;
        }

        if (session.actor.state.fetchCasts()) {
            return true;
        }

        const mpCost = Number(skill.fetchConsumedMp()) || 0;
        if (!this.canSpendSkillMp(session.actor, mpCost)) {
            return true;
        }

        return this.castTargetedItemSkill(session, target, skill, () => {
            if (session.actor.isDead() || !this.canHarvestTarget(session.actor, target, skill)) {
                return;
            }
            if (!this.spendSkillMp(session.actor, mpCost)) {
                return;
            }
            if (ManorData.harvestSuccessChance(session.actor.fetchLevel?.(), target.fetchLevel?.()) < Math.random() * 99) {
                return;
            }

            this.takeManorHarvest(target).forEach((item) => {
                World.purchaseItem(session, item.selfId, item.amount);
            });
        });
    }

    useTargetedCleanseItem(session, id, itemSkill, skill) {
        const target = this.fetchSelectedPlayableTarget(session);
        if (!this.canCleanseTarget(session.actor, target, skill)) {
            session.dataSendToMe(ServerResponse.actionFailed());
            return true;
        }

        if (session.actor.state.fetchCasts()) {
            return true;
        }

        return this.castTargetedItemSkill(session, target, skill, () => {
            if (session.actor.isDead() || !this.canCleanseTarget(session.actor, target, skill)) {
                return;
            }

            this.deleteItem(session, id, 1, () => {
                SkillEffects.execute(session, session.actor, target, skill, {
                    magicSkill: skill.fetchSpell(),
                    rng: () => Math.random(),
                    attack: { clearLoadedShot() {} }
                });
            });
        });
    }

    castTargetedItemSkill(session, target, skill, apply) {
        const castTime = skill.fetchHitTime() || 0;
        session.actor.state.setCasts(true);
        session.dataSendToMeAndOthers(ServerResponse.skillStarted(session.actor, target.fetchId(), skill), session.actor);
        if (castTime > 0) {
            session.dataSendToMe(ServerResponse.skillDurationBar(castTime));
        }

        const finish = () => {
            session.actor.state.setCasts(false);
            apply();
        };

        if (castTime > 0) {
            setTimeout(finish, castTime);
        } else {
            finish();
        }

        return true;
    }

    canSowTarget(actor, target, skill, seedId, options = {}) {
        if (!ManorData.seedById(seedId)) {
            return false;
        }
        if (!target || target === actor || target.fetchAttackable?.() !== true || target.isDead?.() || target.state?.fetchDead?.() === true) {
            return false;
        }
        if (target.fetchKind?.() === 'Boss') {
            return false;
        }
        if (this.isManorSeeded(target)) {
            return false;
        }
        if (!options.allowPending && this.fetchManorSeedId(target)) {
            return false;
        }
        if (options.allowPending && !this.isOwnPendingManorSeed(actor, target, seedId)) {
            return false;
        }
        return this.isInSkillRange(actor, target, skill);
    }

    canHarvestTarget(actor, target, skill) {
        if (!target || target === actor || target.fetchAttackable?.() !== true || !target.isDead?.()) {
            return false;
        }
        if (!this.isManorSeeded(target)) {
            return false;
        }
        const seederId = this.fetchManorSeederId(target);
        if (seederId && seederId !== Number(actor.fetchId?.())) {
            return false;
        }
        return this.isInSkillRange(actor, target, skill);
    }

    canCleanseTarget(actor, target, skill) {
        if (!target || target.state?.fetchDead?.() === true || target.isDead?.()) {
            return false;
        }
        return this.isInSkillRange(actor, target, skill);
    }

    isInSkillRange(actor, target, skill) {
        if (
            typeof actor.fetchLocX !== 'function' ||
            typeof actor.fetchLocY !== 'function' ||
            typeof actor.fetchLocZ !== 'function' ||
            typeof target.fetchLocX !== 'function' ||
            typeof target.fetchLocY !== 'function' ||
            typeof target.fetchLocZ !== 'function'
        ) {
            return true;
        }

        const distance = new SpeckMath.Point3D(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ()).distance(
            new SpeckMath.Point3D(target.fetchLocX(), target.fetchLocY(), target.fetchLocZ())
        );
        const range = Number(skill.fetchSemantic().castRange ?? skill.fetchDistance()) || 0;
        return range <= 0 || distance <= range;
    }

    canSpendSkillMp(actor, mpCost) {
        return mpCost <= 0 || typeof actor.fetchMp !== 'function' || actor.fetchMp() >= mpCost;
    }

    spendSkillMp(actor, mpCost) {
        if (!this.canSpendSkillMp(actor, mpCost)) {
            return false;
        }
        if (mpCost > 0 && typeof actor.fetchMp === 'function' && typeof actor.setMp === 'function') {
            actor.setMp(Math.max(0, actor.fetchMp() - mpCost));
            actor.statusUpdateVitals?.(actor);
        }
        return true;
    }

    setManorSeedPending(target, seedId, actor) {
        if (typeof target.setManorSeedPending === 'function') {
            return target.setManorSeedPending(seedId, actor);
        }
        target.model = target.model || {};
        target.model.manor = {
            seedId,
            seeder: actor,
            seederId: Number(actor?.fetchId?.()) || 0,
            seeded: false,
            harvestItems: []
        };
        return true;
    }

    clearManorSeedPending(target, actor, seedId) {
        if (typeof target.clearManorSeedPending === 'function') {
            return target.clearManorSeedPending(seedId, actor);
        }
        if (this.isOwnPendingManorSeed(actor, target, seedId)) {
            target.model.manor = undefined;
        }
    }

    setManorSeeded(target) {
        if (typeof target.setManorSeeded === 'function') {
            return target.setManorSeeded();
        }
        target.model = target.model || {};
        if (!target.model.manor?.seedId) {
            return false;
        }
        target.model.manor.seeded = true;
        target.model.manor.harvestItems = ManorData.harvestItems(target.model.manor.seedId, target.fetchLevel?.(), target);
        return true;
    }

    isManorSeeded(target) {
        return target.isManorSeeded?.() === true || target.model?.manor?.seeded === true;
    }

    fetchManorSeedId(target) {
        return Number(target.fetchManorSeedId?.() || target.model?.manor?.seedId) || 0;
    }

    fetchManorSeederId(target) {
        return Number(target.fetchManorSeederId?.() || target.model?.manor?.seederId) || 0;
    }

    isOwnPendingManorSeed(actor, target, seedId) {
        const manor = target.model?.manor;
        return !!manor && manor.seeded !== true && Number(manor.seedId) === Number(seedId) && Number(manor.seederId) === Number(actor.fetchId?.());
    }

    takeManorHarvest(target) {
        if (typeof target.takeManorHarvest === 'function') {
            return target.takeManorHarvest();
        }
        const items = target.model?.manor?.harvestItems || [];
        if (target.model?.manor) {
            target.model.manor.harvestItems = [];
        }
        return items;
    }

    useDrainSoulItem(session, id, itemSkill, skill) {
        const target = this.fetchSelectedNpcTarget(session);
        if (!this.canDrainSoulTarget(session.actor, target, skill)) {
            return true;
        }

        if (session.actor.state.fetchCasts()) {
            return true;
        }

        const mpCost = Number(skill.fetchConsumedMp()) || 0;
        if (typeof session.actor.fetchMp === 'function' && session.actor.fetchMp() < mpCost) {
            return true;
        }

        const castTime = skill.fetchHitTime() || 0;
        session.actor.state.setCasts(true);
        session.dataSendToMeAndOthers(ServerResponse.skillStarted(session.actor, target.fetchId(), skill), session.actor);
        if (castTime > 0) {
            session.dataSendToMe(ServerResponse.skillDurationBar(castTime));
        }

        const apply = () => {
            session.actor.state.setCasts(false);
            if (session.actor.isDead()) {
                return;
            }
            if (!this.canDrainSoulTarget(session.actor, target, skill)) {
                return;
            }

            if (mpCost > 0 && typeof session.actor.fetchMp === 'function' && typeof session.actor.setMp === 'function') {
                session.actor.setMp(Math.max(0, session.actor.fetchMp() - mpCost));
                session.actor.statusUpdateVitals?.(session.actor);
            }

            SkillEffects.execute(session, session.actor, target, skill, {
                magicSkill: skill.fetchSpell(),
                attack: { clearLoadedShot() {} }
            });
        };

        if (castTime > 0) {
            setTimeout(apply, castTime);
        } else {
            apply();
        }

        return true;
    }

    useResurrectionItem(session, id, itemSkill, skill) {
        const target = this.fetchSelectedPlayableTarget(session);
        if (!this.canResurrectTarget(session.actor, target, skill)) {
            return true;
        }

        if (session.actor.state.fetchCasts()) {
            return true;
        }

        const startCast = () => {
            const castTime = skill.fetchHitTime() || 0;
            session.actor.state.setCasts(true);
            session.dataSendToMeAndOthers(ServerResponse.skillStarted(session.actor, target.fetchId(), skill), session.actor);
            if (castTime > 0) {
                session.dataSendToMe(ServerResponse.skillDurationBar(castTime));
            }

            const apply = () => {
                session.actor.state.setCasts(false);
                if (session.actor.isDead()) {
                    return;
                }
                if (!this.canResurrectTarget(session.actor, target, skill)) {
                    return;
                }
                this.applyResurrection(target);
            };

            if (castTime > 0) {
                setTimeout(apply, castTime);
            } else {
                apply();
            }
        };

        if (itemSkill.consumeAtStart) {
            const consumeCount = skill.fetchSemantic().itemConsumeCount || itemSkill.consumeCount || 1;
            this.deleteItem(session, id, consumeCount, startCast);
        } else {
            startCast();
        }

        return true;
    }

    buildItemSkill(itemSkill) {
        const skillData = DataCache.skills.find((ob) => ob.selfId === itemSkill.skillId);
        if (!skillData) {
            return null;
        }

        const level = Number(itemSkill.level) || 1;
        const levelData = skillData.levels?.find((entry) => entry.level === level) || {};
        return new SkillModel({
            ...utils.crushOb(skillData),
            ...levelData,
            level
        });
    }

    applySelfItemSkill(session, skill) {
        SkillEffects.execute(session, session.actor, session.actor, skill, {
            magicSkill: skill.fetchSpell(),
            rng: () => Math.random(),
            attack: { clearLoadedShot() {} }
        });
    }

    fetchSelectedPlayableTarget(session) {
        const targetId = session.actor.fetchDestId?.();
        if (targetId === undefined || targetId === null) {
            return null;
        }

        const BotManager = invoke('GameServer/Bot/BotManager');
        const botSession = BotManager.findSessionById(Number(targetId));
        if (botSession?.actor) {
            return botSession.actor;
        }

        const userSession = (World.user?.sessions || []).find((ob) => Number(ob.actor?.fetchId?.()) === Number(targetId));
        return userSession?.actor || null;
    }

    fetchSelectedNpcTarget(session) {
        const targetId = session.actor.fetchDestId?.();
        if (targetId === undefined || targetId === null) {
            return null;
        }

        return (World.npc?.spawns || []).find((npc) => Number(npc.fetchId?.()) === Number(targetId)) || null;
    }

    canDrainSoulTarget(actor, target, skill) {
        if (!target || target === actor) {
            return false;
        }
        if (target.fetchAttackable?.() !== true) {
            return false;
        }
        if (target.isDead?.() || target.state?.fetchDead?.() === true) {
            return false;
        }

        const maxHp = Number(target.fetchMaxHp?.()) || 0;
        const hp = Number(target.fetchHp?.()) || 0;
        if (maxHp > 0 && hp > maxHp / 2) {
            return false;
        }

        if (
            typeof actor.fetchLocX === 'function' &&
            typeof actor.fetchLocY === 'function' &&
            typeof actor.fetchLocZ === 'function' &&
            typeof target.fetchLocX === 'function' &&
            typeof target.fetchLocY === 'function' &&
            typeof target.fetchLocZ === 'function'
        ) {
            const distance = new SpeckMath.Point3D(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ()).distance(
                new SpeckMath.Point3D(target.fetchLocX(), target.fetchLocY(), target.fetchLocZ())
            );
            const range = Number(skill.fetchSemantic().castRange ?? skill.fetchDistance()) || 0;
            if (range > 0 && distance > range) {
                return false;
            }
        }

        return true;
    }

    canResurrectTarget(actor, target, skill) {
        if (!target || target === actor) {
            return false;
        }

        if (target.state?.fetchDead?.() !== true) {
            return false;
        }

        const distance = new SpeckMath.Point3D(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ()).distance(
            new SpeckMath.Point3D(target.fetchLocX(), target.fetchLocY(), target.fetchLocZ())
        );
        const range = Number(skill.fetchSemantic().castRange ?? skill.fetchDistance()) || 0;
        return range <= 0 || distance <= range;
    }

    applyResurrection(target) {
        if (typeof target.revive === 'function') {
            target.revive();
            return;
        }

        const targetSession = target.session;
        if (targetSession) {
            invoke(path.actor).revive(targetSession, target);
        }
    }

    fetchShotCost(kind) {
        const weapon = this.fetchEquippedWeapon ? this.fetchEquippedWeapon() : null;
        const cost = kind === 'spiritshot'
            ? weapon?.fetchSpiritshot?.()
            : weapon?.fetchSoulshot?.();
        return Math.max(0, Number(cost) || 0);
    }

    syncEquipmentItemSkills(actor) {
        return C4EquipmentItemSkills.sync(actor, this.fetchItems());
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
