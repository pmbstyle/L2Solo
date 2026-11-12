const NpcAttacked = invoke('GameServer/Npc/Attacked');
const { killEffect } = require('../../World/KillEffect');

function receivedHit(session, actor, npc, hit, options = {}) {
    if (invoke('GameServer/Effects/EffectStore').hasDebuff(npc, 'petrification')) return;
    if (npc.state?.fetchDead?.()) return;
    invoke('GameServer/Progression/OverhitReward').capture(npc, actor, {
        skill: options.skill,
        damage: hit,
        timestamp: options.timestamp
    });
    invoke('GameServer/Pets/PetRuntime').recordDamage(npc, actor, hit);
    const questSession = actor.ownerSession || session;
    invoke('GameServer/Quest/QuestService').onAttack(questSession, npc, actor, hit).catch(error => utils.infoWarn('Quest', 'pet attack: %s', error.message));
    const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
    const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');

    invoke('GameServer/Bot/AI/BotMobCompetition').record(actor, npc);
    BotSocialMemory.recordCombatHelp(session, npc, `hit ${npc.fetchName()} for ${hit}`);

    const attackerLevel = Number(actor?.fetchLevel?.());
    const actingPlayerLevel = Number(session?.actor?.fetchLevel?.());
    const levels = [attackerLevel, actingPlayerLevel]
        .filter((level) => Number.isFinite(level) && level > 0);
    const dropState = npc.model ?? npc;
    if (npc.fetchIsRaidBoss?.() === true) {
        if (!(dropState.raidAttackers instanceof Set)) dropState.raidAttackers = new Set();
        const actorId = Number(actor?.fetchId?.() || 0);
        const playerId = Number(session?.actor?.fetchId?.() || 0);
        if (actorId) dropState.raidAttackers.add(actorId);
        if (playerId) dropState.raidAttackers.add(playerId);
    }
    if (levels.length > 0) {
        dropState.dropAttackerLevels ??= [];
        levels.forEach((level) => {
            if (!dropState.dropAttackerLevels.includes(level)) {
                dropState.dropAttackerLevels.push(level);
            }
        });
        // Lisvus starts with the killer's acting player, not the summon itself.
        dropState.dropLastAttackerLevel = actingPlayerLevel || attackerLevel;
    }

    if (options.wakeSleep !== false) {
        EffectRestrictions.wakeOnDamage(npc, session);
    }
    // Immortal town staff keep taking hits, but their HP floor stops at 1 so
    // the death pipeline below can only run for killable templates.
    npc.setHp(Math.max(npc.fetchImmortalMinHp?.() ?? 0, npc.fetchHp() - hit)); // HP bar would disappear if less than zero
    npc.broadcastVitals();

    if (npc.fetchHp() <= 0) {
        killEffect('kill.defeat_memory', () => invoke('GameServer/Social/CombatHelpMemory').recordDefeat(actor, npc));
        NpcAttacked(session, actor, npc, hit, options.npcAttacked);
        invoke(path.npc).die(session, actor, npc);
        return;
    }

    npc.automation.replenishVitals(npc);
    NpcAttacked(session, actor, npc, hit, options.npcAttacked);
}

module.exports = receivedHit;
