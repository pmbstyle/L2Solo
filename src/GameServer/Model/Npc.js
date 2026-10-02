const CreatureModel = invoke('GameServer/Model/Creature');
const Formulas      = invoke('GameServer/Formulas');

class NpcModel extends CreatureModel {

    // Set

    setStateRun(data) {
        this.model.stateRun = data;
    }

    setStateAttack(data) {
        this.model.stateAttack = data;
    }

    setStateDead(data) {
        this.model.stateDead = data;
    }

    setStateInvisible(data) {
        this.model.stateInvisible = data;
    }

    // Get

    fetchSelfId() {
        return this.model.selfId;
    }

    fetchKind() {
        return this.model.kind;
    }

    fetchIsRaidBoss() {
        return this.model.raidBoss === true;
    }

    fetchAiType() {
        const value = this.model.ai
            ?? this.model.AI
            ?? this.model.aiType
            ?? this.model.template?.ai
            ?? this.model.template?.AI
            ?? this.model.template?.aiType;
        if (value === undefined || value === null) return null;

        const normalized = String(value).trim().toLowerCase();
        if (['corpse', 'healer'].includes(normalized)) return 'balanced';
        return ['fighter', 'mage', 'balanced', 'archer'].includes(normalized)
            ? normalized
            : null;
    }

    fetchHostile() {
        return this.model.hostile;
    }

    fetchAtkRadius() {
        return this.model.atkRadius;
    }

    fetchRevHp() {
        return this.model.revHp;
    }

    fetchRevMp() {
        return this.model.revMp;
    }

    fetchCorpseTime() {
        return this.model.corpseTime;
    }

    fetchWeapon() {
        return this.model.weapon;
    }

    fetchShield() {
        return this.model.shield;
    }

    fetchArmor() {
        return this.model.armor;
    }

    fetchClanName() {
        return this.model.clanName ?? this.model.clan?.clanName ?? '';
    }

    fetchClanHelpRadius() {
        return this.model.helpRadius ?? this.model.clan?.helpRadius ?? 0;
    }

    fetchUndead() {
        return this.model.undead === true;
    }

    fetchRace() {
        return this.model.race || '';
    }

    fetchOwnerId() {
        return this.model.ownerId ?? 0;
    }

    fetchOwnerName() {
        return this.model.ownerName ?? '';
    }

    fetchSummonSkillId() {
        return this.model.summonSkillId ?? 0;
    }

    fetchIsSummon() {
        return this.model.isSummon === true || this.model.kind === 'Summon';
    }

    fetchIsPet() {
        return this.model.isPet === true;
    }

    fetchPetControlItemObjectId() {
        return this.model.petControlItemObjectId ?? 0;
    }

    fetchPetFoodCategories() {
        return this.model.petFoodCategories || [];
    }

    fetchRewardExp() {
        return this.model.exp;
    }

    fetchRewardSp() {
        return this.model.sp;
    }

    fetchStateRun() {
        return this.model.stateRun;
    }

    fetchStateAttack() {
        return this.model.stateAttack;
    }

    fetchStateDead() {
        return this.model.stateDead;
    }

    fetchStateInvisible() {
        return this.model.stateInvisible;
    }

    // Abstract

    fetchDispSelfId() {
        return (this.model.displayId ?? this.fetchSelfId()) + 1000000;
    }

    fetchAttackable() {
        return ['Monster', 'Boss'].includes(this.model.kind);
    }

    // The C4 sources never run a damage pipeline for ordinary L2NpcInstance /
    // L2FolkInstance NPCs: only L2Attackable templates carry reduceHp/die
    // semantics, so town staff are immortal by construction. This project
    // routes every spawned NPC through Npc/Generics/ReceivedHit so town
    // guards can fight back, which leaves shopkeepers, warehouse keepers, and
    // other town staff killable unless the source rule is restated here.
    // Monsters, Bosses, summons/pets, and the town guards that engage them
    // stay killable.
    fetchIsKillable() {
        // NPC models without a template kind are lightweight/test doubles;
        // only real templates are subject to the immortality rule.
        const kind = String(this.model.kind || '');
        if (!kind) return true;
        if (['Monster', 'Boss', 'Summon'].includes(kind)) return true;
        if (this.fetchAttackable() || this.fetchIsSummon() || this.fetchIsPet()) return true;
        return invoke('GameServer/Npc/TownGuard').isTownGuard(this);
    }

    // Immortal town staff keep taking hits, but their HP floor stops at 1 so
    // the death pipeline can never run for them.
    fetchImmortalMinHp() {
        return this.fetchIsKillable() ? 0 : 1;
    }

    fetchAcquiredExp() {
        return Formulas.calcAcquiredExp(this.fetchLevel(), this.fetchRewardExp());
    }
}

module.exports = NpcModel;
