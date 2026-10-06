'use strict';
// C4/Lisvus L2Attackable.calculateExpAndSp, default exponent configuration:
// core/java/net/sf/l2j/gameserver/model/L2Attackable.java:1743-1749.
// https://github.com/realratchet/L2JLisvus/blob/master/core/java/net/sf/l2j/gameserver/model/L2Attackable.java
function gapFactor(gap) {
    const difference = Number(gap);
    return difference > 5 ? (5 / 6) ** (difference - 5) : 1;
}
function rewards(exp, sp, killerLevel, npcLevel) {
    const factor = gapFactor(Number(killerLevel) - Number(npcLevel));
    return { exp: Math.max(0, Number(exp) || 0) * factor, sp: Math.max(0, Number(sp) || 0) * factor };
}
module.exports = { gapFactor, rewards };
