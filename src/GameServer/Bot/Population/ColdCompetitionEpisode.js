// Only cross-episode restrictions survive a new decision. Combat labels,
// roles and completion timestamps belong to the encounter that produced them.
function begin(previous, episode) {
    if (previous?.key === episode.key) return { ...previous, ...episode };
    return { ...(previous?.conflictUntil ? { conflictUntil: previous.conflictUntil } : {}),
        ...(previous?.avoid ? { avoid: previous.avoid } : {}), ...episode };
}
module.exports = { begin };
