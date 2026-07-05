const ServerResponse = invoke('GameServer/Network/Response');
const NpcModel       = invoke('GameServer/Model/Npc');
const Automation     = invoke('GameServer/Automation');
const ConsoleText    = invoke('GameServer/ConsoleText');
const SpeckMath      = invoke('GameServer/SpeckMath');
const Formulas       = invoke('GameServer/Formulas');
const GeodataEngine  = invoke('GameServer/Geodata/GeodataEngine');
const Attack         = invoke('GameServer/Actor/Attack');
const ManorData      = invoke('GameServer/Manor/ManorData');
const AttackHelper   = new Attack();

class Npc extends NpcModel {
    constructor(id, data) {
        // Parent inheritance
        super(data);

        // NOTE: Do NOT snap spawn Z to geodata here.
        // Coordinates in spawns.json are already correct (taken from authentic L2J data).
        // Applying GeodataEngine.getHeight() overwrites them with inaccurate geodata values
        // causing NPCs to spawn under terrain in Dion, Gludio, Dark Elf Village, etc.

        // Local
        this.automation = new Automation();
        this.automation.setRevHp(this.fetchRevHp());
        this.automation.setRevMp(this.fetchRevMp());

        this.setId(id);
        this.fillupVitals();

        // User preferences
        const optn = options.default.General;

        if (optn.showMonsterLevel) {
            this.showLevelTitle();
        }

        // TODO: Move this into actual GameServer timer
        this.timer = {
            combat: undefined
        };
    }

    destructor(session) {
        this.automation.stopReplenish();
        this.abortCombatState(session);
    }

    showLevelTitle() {
        if (this.fetchAttackable() && this.fetchTitle() === '') {
            this.setTitle('Lv ' + this.fetchLevel() + (this.fetchHostile() ? ' @' : ''));
        }
    }

    enterCombatState(session, actor) {
        if (this.state.fetchCombats()) {
            return;
        }

        this.setDestId(actor.fetchId());
        this.state.setCombats(true);

        this.setStateRun(true);
        this.setStateAttack(true);
        session.dataSendToMeAndOthers(ServerResponse.walkAndRun(this.fetchId(), this.fetchStateRun()), this);
        session.dataSendToMeAndOthers(ServerResponse.autoAttackStart(this.fetchId()), this);

        setTimeout(() => {
            const coords = {
                locX: 0,
                locY: 0,
                locZ: 0,
            };

            this.timer.combat = setInterval(() => {
                if (new SpeckMath.Point(this.fetchLocX(), this.fetchLocY()).distance(new SpeckMath.Point(actor.fetchLocX(), actor.fetchLocY())) >= 1500) {
                    this.abortCombatState(session); // Actor is out of reach
                    return;
                }

                if (this.state.isBlocked()) {
                    return;
                }

                const newDstX = actor.fetchLocX();
                const newDstY = actor.fetchLocY();
                const newDstZ = actor.fetchLocZ();

                if (this.state.inMotion()) {
                    if (coords.locX !== newDstX || coords.locY !== newDstY) {
                        this.setLocXYZ(new SpeckMath.Point3D(this.fetchLocX(), this.fetchLocY(), this.fetchLocZ()).midPoint(new SpeckMath.Point3D(coords.locX, coords.locY, coords.locZ), this.automation.fetchDistanceRatio() * 1.3).toCoords()); // TODO: Another hack to catch-up

                        this.automation.abortAll(this);
                    }
                    return;
                }

                coords.locX = newDstX;
                coords.locY = newDstY;
                coords.locZ = newDstZ;

                const attackRange = this.fetchCombatAttackRange(actor);

                this.automation.scheduleAction(session, this, actor, attackRange, () => {
                    this.setLocXYZ(this.fetchCombatStopCoords(actor, attackRange));

                    if (this.isTargetInAttackRange(actor, attackRange)) {
                        session.dataSendToMeAndOthers(
                            ServerResponse.stopMove(this.fetchId(), {
                                locX: this.fetchLocX(),
                                locY: this.fetchLocY(),
                                locZ: this.fetchLocZ(),
                                head: this.fetchHead(),
                            }), this
                        );

                        this.meleeHit(session, this, actor);
                    }
                });

            }, 100);

        }, 1000);
    }

    fetchCombatAttackRange(actor) {
        return Math.max(
            0,
            Number(this.fetchAtkRadius()) || 0,
            Number(actor?.fetchRadius?.()) || 0
        );
    }

    fetchCombatStopCoords(actor, attackRange = this.fetchCombatAttackRange(actor)) {
        return this.automation.actionStopCoords(this, actor, attackRange);
    }

    isTargetInAttackRange(actor, attackRange = this.fetchCombatAttackRange(actor)) {
        const distance = new SpeckMath.Point3D(this.fetchLocX(), this.fetchLocY(), this.fetchLocZ()).distance(
            new SpeckMath.Point3D(actor.fetchLocX(), actor.fetchLocY(), actor.fetchLocZ())
        );
        return distance <= attackRange + 1;
    }

    abortCombatState(session) {
        clearInterval(this.timer.combat);
        this.timer.combat = undefined;

        this.clearDestId();
        this.state.setCombatEnded();
        this.automation.abortAll(this);

        this.setStateRun(false);
        this.setStateAttack(false);
        session.dataSendToMeAndOthers(ServerResponse.walkAndRun(this.fetchId(), this.fetchStateRun()), this);
        session.dataSendToMeAndOthers(ServerResponse.autoAttackStop(this.fetchId()), this);
    }

    meleeHit(session, src, dst) {
        if (this.checkParticipants(session, src, dst)) {
            return;
        }

        const speed = Formulas.calcMeleeAtkTime(src.fetchCollectiveAtkSpd());
        const hitLanded = Formulas.calcHitChance(src, dst, Math.random, AttackHelper.positionContext(src, dst));
        const hit = AttackHelper.prepareNpcMeleeHit(src, dst, hitLanded);

        session.dataSendToMeAndOthers(ServerResponse.attack(src, dst.fetchId(), hit), this);
        src.state.setHits(true);

        setTimeout(() => {
            if (this.checkParticipants(session, src, dst)) {
                return;
            }

            if (hitLanded) {
                this.hit(session, dst, hit.damage);
            }

        }, speed * 0.644);

        setTimeout(() => {
            this.state.setHits(false);

        }, speed); // Until end of combat move
    }

    checkParticipants(session, src, dst) {
        if (src.state.fetchDead() || dst.state.fetchDead()) {
            this.abortCombatState(session);
            return true;
        }
        return false;
    }

    hit(session, actor, hit) {
        ConsoleText.transmit(session, ConsoleText.caption.monsterHit, [
            { kind: ConsoleText.kind.npc, value: this.fetchDispSelfId() }, { kind: ConsoleText.kind.number, value: hit }
        ]);

        if (actor?.session) {
            actor.session.incomingThreatId = this.fetchId();
            actor.session.incomingThreatAt = Date.now();
        }
        invoke(path.actor).receivedHit(session, actor, hit);
    }

    broadcastVitals() {
        invoke(path.npc).broadcastVitals(this);
    }

    addAbsorber(actor) {
        if (!actor?.fetchId) {
            return;
        }

        if (!this.soulCrystalAbsorbers) {
            this.soulCrystalAbsorbers = new Map();
        }

        const absorberId = Number(actor.fetchId());
        this.soulCrystalAbsorbers.set(absorberId, {
            actor,
            absorberId,
            absorbedHp: this.fetchHp()
        });
        this.soulCrystalAbsorbed = true;
    }

    isAbsorbed() {
        return this.soulCrystalAbsorbed === true;
    }

    fetchSoulCrystalAbsorber(actorOrId) {
        const absorberId = Number(
            typeof actorOrId?.fetchId === 'function'
                ? actorOrId.fetchId()
                : actorOrId
        );
        return this.soulCrystalAbsorbers?.get(absorberId) || null;
    }

    resetSoulCrystalAbsorbers() {
        this.soulCrystalAbsorbers?.clear();
        this.soulCrystalAbsorbed = false;
    }

    setManorSeedPending(seedId, seeder) {
        if (this.model.manor?.seeded) {
            return false;
        }

        this.model.manor = {
            seedId,
            seeder,
            seederId: Number(seeder?.fetchId?.()) || 0,
            seeded: false,
            harvestItems: []
        };
        return true;
    }

    clearManorSeedPending(seedId, seeder) {
        if (this.model.manor?.seeded) {
            return;
        }
        if (seedId && Number(this.model.manor?.seedId) !== Number(seedId)) {
            return;
        }
        if (seeder && Number(this.model.manor?.seederId) !== Number(seeder.fetchId?.())) {
            return;
        }
        this.model.manor = undefined;
    }

    setManorSeeded() {
        const manor = this.model.manor;
        if (!manor?.seedId || !manor?.seeder) {
            return false;
        }

        manor.seeded = true;
        manor.harvestItems = ManorData.harvestItems(manor.seedId, this.fetchLevel(), this);
        return true;
    }

    isManorSeeded() {
        return this.model.manor?.seeded === true;
    }

    fetchManorSeeder() {
        return this.model.manor?.seeder || null;
    }

    fetchManorSeederId() {
        return Number(this.model.manor?.seederId) || 0;
    }

    fetchManorSeedId() {
        return Number(this.model.manor?.seedId) || 0;
    }

    takeManorHarvest() {
        const items = this.model.manor?.harvestItems || [];
        if (this.model.manor) {
            this.model.manor.harvestItems = [];
        }
        return items;
    }
}

module.exports = Npc;
