// Combat labels, roles and completion timestamps belong to the encounter that
// produced them: a new episode starts clean.
function begin(previous, episode) {
    if (previous?.key === episode.key) return { ...previous, ...episode };
    return { ...episode };
}
module.exports = { begin };
