// Run the full physical hot/cold handoff matrix with independent revenge attribution.
process.argv.push('--revenge');
require('./test_pvp_encounter_handoff');
