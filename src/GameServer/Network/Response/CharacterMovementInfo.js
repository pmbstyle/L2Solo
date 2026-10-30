function movementInfo(actor) {
    const collectiveRun = Math.max(0, Number(actor.fetchCollectiveRunSpd?.()) || 0);
    const collectiveWalk = Math.max(0, Number(actor.fetchCollectiveWalkSpd?.()) || 0);
    const running = actor.state?.fetchWalkin?.() !== true;
    const baseRun = Math.max(0, Number(actor.fetchRunSpd?.()) || collectiveRun);
    const baseWalk = Math.max(0, Number(actor.fetchWalkSpd?.()) || collectiveWalk);
    const activeCollective = running ? collectiveRun : collectiveWalk;
    const activeBase = running ? baseRun : baseWalk;
    const ratio = activeBase > 0 && activeCollective > 0
        ? activeCollective / activeBase
        : 1;
    const multiplier = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    const run = Math.round(baseRun);
    const walk = Math.round(baseWalk);
    const swim = actor.fetchSwim?.();

    // C4 UserInfo and CharInfo both send template speeds plus a separate
    // multiplier for client movement and animation (as in L2J/Lisvus).
    return {
        run,
        walk,
        swimRun: swim ? Math.round(swim / multiplier) : run,
        swimWalk: swim ? Math.round(swim / multiplier) : walk,
        multiplier
    };
}

module.exports = movementInfo;
