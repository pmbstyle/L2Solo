const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Expedition = require('../../Clan/ClanRaidExpedition');

function critical(value) {
    if (Expedition.helper(Expedition.memberMarker(value), value)) return false;
    const role = Roles.inferRole(value);
    return role === 'tank' || role === 'healer' || (role === 'buffer' && !Roles.isPartyMusicFighter(value));
}

function disposition(value, { previousDamageCasualties = 0, remainingHpRatio = 1 } = {}) {
    if (Expedition.helper(Expedition.memberMarker(value), value)) return 'continue';
    if (critical(value)) return 'fail_critical_role';
    return previousDamageCasualties === 0 || remainingHpRatio <= 0.5 ? 'continue' : 'fail_attrition';
}

module.exports = { critical, disposition };
