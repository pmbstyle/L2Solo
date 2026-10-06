// Kept for callers of the old preparation interface. Every recipe ingredient
// now has to be owned or acquired on the normal purchase path.
function isSupplementalMaterial() { return false; }
module.exports = { isSupplementalMaterial };
