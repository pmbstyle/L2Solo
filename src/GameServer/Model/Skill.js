class SkillModel {
    constructor(data) {
        this.model = data;
        this.semantic = invoke('GameServer/Skills/C4SkillRules').resolve(data);
    }

    // Set

    setCalculatedHitTime(data) {
        this.model.calculatedHitTime = data;
    }

    // Get

    fetchSelfId() {
        return this.model.selfId;
    }

    fetchLevel() {
        return this.model.level;
    }

    fetchName() {
        return this.model.name;
    }

    fetchPassive() {
        return this.model.passive;
    }

    fetchSpell() {
        return this.model.spell === true;
    }

    fetchDistance() {
        return this.model.distance;
    }

    fetchConsumedHp() {
        return this.model.hp;
    }

    fetchConsumedMp() {
        return this.model.mp;
    }

    fetchHitTime() {
        return this.model.hitTime;
    }

    fetchCalculatedHitTime() {
        return this.model.calculatedHitTime ?? this.fetchHitTime();
    }

    fetchReuseTime() {
        return this.model.reuse;
    }

    fetchPower() {
        return this.model.power;
    }

    fetchTeleportCoords() {
        if (
            Number.isFinite(Number(this.model.locX)) &&
            Number.isFinite(Number(this.model.locY)) &&
            Number.isFinite(Number(this.model.locZ))
        ) {
            return {
                locX: Number(this.model.locX),
                locY: Number(this.model.locY),
                locZ: Number(this.model.locZ)
            };
        }
        return null;
    }

    fetchItemConsumeId() {
        return this.model.itemId;
    }

    fetchItemConsumeCount() {
        return this.model.itemCount ?? 0;
    }

    fetchOngoingItemConsumeCount() {
        return this.model.itemCountOT ?? 0;
    }

    fetchSummonNpcId() {
        return this.model.npcId;
    }

    fetchSummonTotalLifeTime() {
        return this.model.totalLifeTime ?? 0;
    }

    fetchSummonIsCubic() {
        return this.model.isCubic === true;
    }

    fetchBuffTime() {
        return this.model.buff;
    }

    fetchSemantic() {
        return this.semantic;
    }

    fetchSkillType() {
        return this.semantic.skillType;
    }

    fetchTargetKind() {
        return this.semantic.target;
    }

    fetchSsBoost() {
        return this.semantic.ssBoost;
    }
}

module.exports = SkillModel;
