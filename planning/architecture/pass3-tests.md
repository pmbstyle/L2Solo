# Third pass: test suite audit (2026-11-03, t106dev)

Checked at 516f6ef9 (2026-11-03).

1249 test files; per-file CI durations from the last green run 41214661352 (2026-10-31, 12 shards): 1216 files,
4037 s of test time, 265-439 s per shard; the slowest file 60 s (limit 180 s).

| Category | Files |
|---|---|
| Behaviour tests | ≈975 (78 %) |
| … with some internal asserts (trim lines, keep file) | ≈85 |
| Mostly internals | ≈150 (12 %) → ≈36 delete (pinned elsewhere), ≈60 rewrite later |
| Pin dead/dormant code | 5 dead, 3 dormant (POP-17) |
| Duplicate groups | ≈14 |
| Known red | 7 in notRunTests + 7 listed as live |

## Biggest cost: idle tails (≈1078 s, ~27 % of CI test time)

- **303 files idle 3.0-3.3 s after their asserts** (920 s): `DatabaseCheckpointCoordinator.stop()` races the final
  checkpoint against `setTimeout(…, 3000)` that is never cleared or unref'd (confirmed on one file). **Fixed 94b5c3f4.**
- **12 cold-worker files idle exactly 10 s** (119 s): `ColdSimulationCoordinator.stop()` (~2305-2318) races against
  `wait(10000)` six times and never clears those timers (by reading). **Fixed 6e521123.**
- `test_skill_semantics.js`: asserts finish at 0.7 s, then 30 s idle on 3 ref'd timeouts (source not found).
A 2-3 line fix in `src` saves ~1000 s of CI and as much laptop time; server shutdown also 3 s faster.

## First deletion batch (safe: behaviour pinned elsewhere or code dead) — 21 files, ~65 s CI

test_static_gear_worker, test_gear_plan_memo, test_gear_plan_selection_sections, test_economy_basics_dependencies,
test_craft_station_catalog, test_craft_material_party_events, test_bot_afk_listing_failure, test_market_lot_policy,
test_n79_price_prior, test_spot_index, test_spot_matchup_memo, test_species_verdict_at_read,
test_walkback_catalog_cache, test_quest_cure_fever_items, test_bot_tool_pending_audit, test_bot_wtb_recovery_floor,
test_bot_wtb_cached_survival_floor, test_persona_party_copies, test_cold_message_pages, test_task4_arrival_step (red),
test_pk_profiles. Plus unused tests/fixtures/following_tick_pins.json, tests/helpers/sourceAssessmentReference.js,
and dead-path one-liners: test_afk_trade_database ~205 (`matchAfkTradeShops`), test_bot_gear ~15
(`ensureCharacterGear`), test_bot_market_town_routing ~203, test_hot_board_review ~73, test_bot_economy_thresholds
~107 and test_bot_market_listing_policy ~72 (`listingFloor`), the E45 block of test_board_trip_suspects.
Where each behaviour is pinned instead was checked per file at the survey (not kept here).

Second batch after a check: test_clan_invite_priority (move 2 cases first), test_party_composition_topk_equivalence,
test_clan_simulation_slice0, test_cold_store_release, test_cold_worker_pressure, test_meeting_survival_transport,
test_spot_income_band_cache, test_cold_orphan_party_reconcile (keep its start-up half).
With their code deletions: social graph tests (PER-4), world actor publication/grid tests (WOR-5), pk_* tests (POP-17).

## Other wins

- Stop whole-file re-runs: test_pvp_encounter_handoff runs 4× per suite (spawned/required by expiry, extension,
  revenge_handoff); test_cold_ordinary_competition re-spawns test_cold_pvp and test_cold_competition_actions (~30 s).
- Merge the 7 cold_*_admission files (same preamble and matrix, 79 s CI) into one behaviour file.
- Respawn 70 % HP pinned in 7 files: keep restart_point_revive (hot) and bot_background_respawn (cold).
- Table-driven merges: c4_* zone files (71 files, 193 s), profession route stubs (33 files, 203 s).
- Trim test_cold_simulation_kernel and test_economy_context (most churn; mostly scheduler/cache mechanics).

## Known red: verdicts

fix: test_beginner_shot_policy (drop `usePolicy` asserts), test_cold_armor_set_effects (hard-coded castSpd),
test_npc_purchase_consumers (l.118, counters l.74/86), test_task4_b5_hot_cold_same; trim: test_finite_market_income,
test_gear_intermediate_candidates, test_task4_survival_tranche (keep part 1), test_aggregate_production_demand;
delete: test_task4_arrival_step; split/triage: test_party_companion_rest_follow (3612 lines, ~1050 never run past
l.2557). Not triaged: test_producer_preparation, test_wish_purchase_supply, test_bot_equipment_transition_recovery,
test_bot_hunting_visibility.
