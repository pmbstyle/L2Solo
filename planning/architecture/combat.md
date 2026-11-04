# Combat, skills, actors

Checked at 199c3b19 (2026-11-04).

Survey of t106dev @ 9f27b7fa (2026-11-03). Line numbers drift; search by name.
Scope: `Actor`, `Skills`, `Effects`, `Combat`, `Npc`, `RaidBoss`, `Pets`, `Formulas.js`, `Karma.js`,
`PkDropPolicy.js`, cold fight in `Population/BackgroundResolver`.

## Mechanisms

- **Hit core (pure):** `Combat/HitRules.js` — two `CombatantView`s + context → `{damage, critical, shield}`; melee,
  physical/magic skill, `expected*` means; target modifier, skill power, level-fail roll, effect/blow land chance,
  lethal, absorb, reflect, DoT. Hot (`Attack`, `C4SkillEffects`), cold (`BackgroundResolver`, `ColdMobAction`,
  `ColdCombatProfile`), planners (`BotCombatUtility`, `BotTargetMatchup`, partly `OpportunisticRaidPolicy`, CMB-6).
- **`Formulas.js`:** C4 numbers — stats, timing (`attackTimes`, `calcSkillHitTime`), damage, rolls.
- **Hot runtime:** `Actor/Attack.js` — `meleeHit`, cast pipeline `remoteHit` → `landRemoteCast` →
  `applyRemoteCastEffect`, adapters `prepareMeleeHit`/`prepareNpcMeleeHit`/`prepareSkillDamage`, `hit()` dispatch.
- **Request gate:** `Actor/Generics/{AttackRequest,AttackExec,SkillRequest,SkillExec}` — alive, restrictions, queue,
  peace zone. Hot bots use it too.
- **Restricted target admission:** `Attack.validateSkillTarget` uses `isValidSkillTarget` for `corpse_player`
  and single-target `C4SkillRules.undeadOnly` skills. `SkillExec` calls it before planning an approach and
  `Attack.remoteHit` rechecks at cast start, before shots, reuse and MP payment. A living resurrection target or
  non-undead target of an undead-only skill receives C4 message 109 and ActionFailed even outside cast range or
  while rooted. Undead NPCs and summons are eligible. `corpse_ally` and skills with undead-aura metadata remain
  caster-centred; `isValidSkillTarget` filters living bystanders while preserving ordinary enemy eligibility.
  Direct effects retain their execution guard. Requiem's missing aura metadata remains CMB-29.
  Cost on main: one target predicate per rejected attempt, two per accepted restricted request (lookup and cast
  start), and one undead trait check per candidate of an undead aura. Other requests check only the target kind
  and existing semantic flag. No new per-tick work, per-bot state, DB writes or worker messages. Cold combat,
  its existing undead skill selection and measured tables are unchanged.
- **Item-skill casts** (scrolls, resurrection items, pet summon, drain soul, sow): `Backpack.castItemSkill` on the
  caster's `attack.queueTimer`, so whatever cancels a cast cancels it and it never lands on another character; the item
  is spent at cast start (Lisvus); writes go under the bag owner (`Backpack.ownerId`). A hit breaks only a magic cast
  (`Attack.tryBreakCast`, C4). Open tails: debt.md theme 9.
- **Damage sinks:** player `Actor/Generics/ReceivedHit` (transfer pain, CP shield, HP, PvP/PK tally, karma) → `Die`
  (PK drop `PkDeathDrop`, death EXP `DeathExperience.applyDeathPenalty`); revive `Revive` / `RestartPoint` at
  `Formulas.respawnHp` (70 %); NPC `Npc/Generics/ReceivedHit` (overhit, HP, `Npc/Attacked` reaction) → `Die` → `NpcDied`
  (EXP/SP, quests, sweep); drops `World/Generics/NpcRewards`.
- **Monster:** `Npc/Npc.js` hate (`NpcHate`, shared with cold), own `meleeHit`/`hit`, skill choice `NpcCombatChoice`
  (shared), aggro `NpcAggro` + `NpcAggroRange`, `SocialAggro`, `SpoilSweep`.
- **Skills:** `C4SkillRules` (per-skill semantics, hot and cold), `C4SkillEffects.execute` (hot effects, one long
  `skillType` chain), `ChargeLifecycle`, `ToggleSkills`, `CubicControl`, `SkillReuse` (persistence only).
- **NPC attack reaction:** hot `Npc/Attacked` owns hate and the leader/minion + clan assistance notification for
  `ReceivedHit` and `C4SkillEffects`. A dying minion calls its leader before removal; a dying leader calls nobody.
  `C4SkillRules.provokesNpc` owns cast engagement (hate removal/reduction and dagger blows excluded).
  `C4SkillEffects.execute` calls the reaction before the success roll, including a resisted debuff. Its result's
  `npcAttacked` flag crosses the native/proc/cubic HP-hit boundary so damage credits its hate without calling
  assistance twice. `Attack.beginRemoteCast` sends the player's use message;
  `C4SkillEffects.execute` sends failure to the caster for a resisted spell/effect, independently of HP damage.
  Target-side magic resistance remains separate. `Response/ConsoleText` encodes a skill name as id + level.
  Cost on main: one semantic predicate and one hate update per hostile cast/target, the existing group's minion
  walk and one indexed clan-neighbour query (only with clan/help radius), one use packet per player cast and one
  failure packet per resisted target. The subsequent HP hit only adds damage hate; no duplicate assistance walk,
  global world scan, DB write, worker message, per-bot state or per-tick work is added.
- **Effects:** `EffectStore` (authoritative), `EffectStats`, `EffectTicker`, `EffectRestrictions`; `BuffCatalog` legacy.
- **Stats:** hot `CalculateStats`, cold `ColdCombatProfile.powerTerms/formulaPower` — both call `Formulas` but assemble
  separately.
- **Summons/pets:** servitors are `Npc` with own loop `SummonControl.attackTick` (hit from `Attack.prepareNpcMeleeHit`);
  C4 pets `Pets/PetRuntime` (`isPet` and `isSummon`); cold models servitors only (`ColdSummonProfile`).
- **Raid:** `RaidBossBalance` (0.75 at load), `RaidCurse` (hot only).
- **PvP/karma:** `PvpRules` (pure; C4 flag rule, kill outcome and tally, CP shield) hot and cold; hot runtime
  `Actor/PvpFlag` (`attack` at swing start / offensive skill landing, `mark`) and `ReceivedHit.creditKill` (a
  character's death, and a summon's/pet's from `Npc/Generics/Die`); `Karma.pkKillKarma` (only through
  `PvpRules.tallyAfterKill`); `PkDropPolicy` hot (`PkDeathDrop`), cold (`Database` commit) and in
  `EconomicValuation`'s expected loss: C4, a PK drops from 5 PKs on, one karma roll (`pkDeathDropChance` 0.7), then
  each item on its own chance (bag 50 %, worn armour 40 %, weapon 10 %), up to 10. Death washes karma by the EXP
  lost (`DeathExperience.karmaLost`, hot and cold).
- **Cold fight (worker):** `BackgroundResolver.resolveFight` (solo), `resolvePartyFight` (party/raid), shared
  `coldBotTurn`/`attackDamage`; mob `ColdMobAction`; PvP `ColdPvpResolver`; rewards `ColdKillRewards` →
  `BackgroundDropResolver`; death `DeathExperience.applyColdDeath` (called by `BotLifeState.prepareResolve` and
  `ColdPvpResolver`); town restart in `BackgroundResolver` at `Formulas.respawnHp`. The spot table and the hunt tables
  measure this fight offline (`resolveSolo`, `resolveFight`; [tables.md](tables.md)): a change here goes stale in them
  until a rebuild (tables.md "When to rebuild").

**Shared hot and cold:** HitRules, Formulas, C4SkillRules, NpcCombatChoice, NpcHate, NpcAggroRange,
ProgressionRates, MobExperience, OverhitReward, DeathExperience, PkDropPolicy, Karma.pkKillKarma, PvpRules,
`Formulas.respawnHp`, timing.
**Not shared:** stat assembly, skill reuse, MP cost, summon template lookup, charge multiplier. **Hot only:** cast
break (magic casts only), transfer pain, grade penalty, raid curse, petrification, position.
Parity tests: `test_cold_combat_parity`, `test_combat_core`, `test_cold_hot_rules`, `test_hot_cold_progression_parity`.

## Canonical owners

| Rule | Owner |
|---|---|
| Hit damage, crit, shield, target terms, lethal, absorb, reflect, DoT | `Combat/HitRules` |
| Formulas (stats, timing, rolls) | `Formulas` — damage formulas only via HitRules |
| Monster skill choice | `Npc/NpcCombatChoice` |
| Who a mob attacks | `Npc/NpcHate` |
| Aggro range | `Npc/NpcAggroRange` |
| Skill semantics | `Skills/C4SkillRules` |
| NPC attack reaction (hate + group/clan assistance) | hot `Npc/Attacked`, called by `ReceivedHit` and `C4SkillEffects` (`C4SkillRules.provokesNpc` for casts) |
| Item-skill cast (timer, spend, landing) | `Backpack.castItemSkill` (bots' own SoE `BotTownTravel.beginEscape` is still a parallel path, debt.md theme 9) |
| Cast break by damage | `Attack.tryBreakCast` (magic casts only) |
| Effects store / stat sums | `EffectStore` + `EffectStats` |
| Skill reuse | **none** — proposed `Skills/SkillReuse` (CMB-1) |
| MP cost | **none** — proposed in `Skills/` (CMB-2) |
| MP an offensive skill must leave (a solo healer keeps its heals' share) | `Bot/AI/BotClassPolicy.offensiveMpReserve`: the pick (`BotCombatUtility`, hot and cold) and the solo gate's damage budget (`BotTargetMatchup.spendableMp`) |
| Stat assembly | **none** (CMB-8) |
| PvP flag, PvP/PK classification and tally, CP shield | `PvpRules` (hot `PvpFlag.attack`, `ReceivedHit`; cold `ColdPvpResolver`, `Database` cold commit) |
| PK drop | `PkDropPolicy` (hot `PkDeathDrop`, cold `Database` commit, `EconomicValuation`) |
| Mob EXP/SP | `Progression/MobExperience` + `Formulas.calcAcquiredExp` |
| Death EXP and its karma wash | `Progression/DeathExperience` (`calculateLoss`, `karmaLost`) |
| Revive / restart HP | `Formulas.respawnHp` (pets not yet, CMB-24) |

## Debt

- **CMB-1 skill reuse differs hot vs cold.** Hot `Actor.markSkillReuse` applies reuse multipliers, speed, Skill
  Mastery; cold `BackgroundResolver.spendSkill` uses raw `skill.reuse`; `RaidHealingEstimate` copies the hot rule;
  NPC `NpcCombatChoice.reuseMs` = max(1000, raw). Cold casters cast less often.
- **CMB-2 MP cost differs.** Hot `Attack.skillMpCost` (dance cost, consume multipliers); cold raw `skill.mp`; partial
  copies in `SurvivalFloor.stateCastCosts`, `ColdCombatProfile.partyMusicMpCost`.
- **CMB-3 three swing loops, two damage paths.** `Attack.meleeHit`, `Npc.meleeHit`, `SummonControl.attackTick`
  (inline timing, calls sinks directly: no cast break, reflect; owner flag and CP do apply). A monster hitting a
  summon or pet: `Npc.hit` writes its HP and calls `die` (no ReceivedHit); hitting a player goes through
  `Actor ReceivedHit`; a confused mob hitting a mob writes HP directly.
- **CMB-5 charge multiplier `0.8 + 0.201*n` copied three times** (`C4SkillEffects`, `BackgroundResolver`,
  `BotCombatUtility`). Belongs in HitRules.
- **CMB-6 planner estimates bypass HitRules** (no target modifier, shield, crit), partly:
  `BotCombatUtility` skill pricing and `BotTargetMatchup` use `HitRules.expected*`, but `basicAttackDamageEstimate`
  is raw `Formulas.calcMeleeDamage`; `OpportunisticRaidPolicy` adds `HitRules.targetModifier` to raw
  `calcPhysicalDamage`/`calcMagicDamage`; `BotEmergencyFinisher`, `WishProviders`, `ClanRaidEstimate` are raw.
  Use `HitRules.expected*`.
- **CMB-7 hot NPC and hot servitor melee have no weapon spread** (`prepareNpcMeleeHit` passes no `pAtkRnd`); cold mobs
  (`ColdMobAction`) and cold servitors (`ColdSummonProfile`) do. C4 (c4-check): +0..10 % for every attacker.
- **CMB-8 stat assembly twice.** Hot `CalculateStats` rounds twice, runs `C4GradePenalty` and item skills; cold rounds
  once, no grade penalty.
- **CMB-9 half-migration: legacy buff markers.** `BuffCatalog.ALL_BUFFS`, `actor.activeBuffs` (written by
  `C4SkillEffects`, `CharacterStatus`), `CalculateStats.legacyBuff*` beside `EffectStore`. A comment
  (`BotSupportPlanner` ~495) says packets/UI only, but `legacyBuff*` still adds might/shield/haste/wind walk from
  `activeBuffs` when no EffectStore effect carries the stat; `ColdCombatProfile` and `BotBuffs` read `ALL_BUFFS`.
- **CMB-10 summon NPC lookup differs.** Hot covers six families; cold one family and invents stats when the template is
  missing.
- **CMB-11 cold solo and party fights are parallel loops** (`resolveFight`, `resolvePartyFight`), each with its own
  fallback mob literal (already different) and targeting.
- **CMB-12 combat core calls bot AI and economy.** `Attack.js` → BotMobCompetition, BotPartyChat, BotPvp*,
  PartyCompanionService…; `NpcDied` → EconomicValuation, KnowledgeLearning, BotAI…; `Die.js` → EconomyContext,
  EconomicValuation, BotLifeState. Layering.
- **CMB-13 two player-vs-NPC tests:** `fetchId() >= 2000000` vs presence of `fetchKind`.
- **CMB-27 `RaidCurse` scans the world per cast.** A non-offensive skill reads `raidBossesAttackedBy` for each target,
  a filter over every `World.npc.spawns`, and `combatLevel` of a summon scans every session (perf; their throws
  are counted, `raid.curse_lookup`). `World/RaidEntityIndex` already holds the bosses.
- **CMB-15 local patches:** skills 109/121 in HEAL_PERCENT, weapon 5606 in
  `C4WeaponSA`, duck-type guard in `Npc.hit` for stale aggro entries (crashed the process).
- **CMB-16 dead:** `Attack.physicalRaceModifier` test only (`test_melee_dd_class_skills`). (`Formulas.calcMagicSuccess`
  is live through `Formulas.calcSpoilSuccess`, hot `SpoilSweep` and cold `ColdKillRewards`; `HitRules` uses
  `calcMagicSuccessRate`.)
- **CMB-17 cold rewards copy:** `BackgroundDropResolver.progressionForFight` inlines `level*level*mod` instead of
  `Formulas.calcAcquiredExp`. (Cold drops do apply deep blue; a party passes its highest
  member's level as `killerLevel`, slightly broader than C4, c4-check.)
- **CMB-18 raid gap `+8/+7` literal** in `OpportunisticRaidPolicy` instead of `RaidCurse.RAID_LEVEL_MAX_DIFFERENCE`.
- **CMB-19 peace zone checked in the request layer twice and in cold separately;** skills do not use the client-view
  rule of weapon hits.
- **CMB-21 C4 flags for support are missing.** Lisvus `callSkill` flags a player who casts a non-offensive skill on a
  flagged or karma character, or on a monster (except summon/feed/unlock); here only offensive actions flag.
- **CMB-22 `BotPvpThreats.character` maps any NPC with an owner to its owner**, a quest monster too (`QuestService`
  spawns with `ownerId`): its attacks are remembered as the owner's aggression. `PvpRules.isPlayable` gates the flag and
  the kill tally, not that memory.
- **CMB-23 "rest until" 0.95 copied inline** in `RestingState` (twice) and `BackgroundResolver.resolveRest` beside
  `RestPolicy.THRESHOLDS.locked`, each with its own mana rule; `HotBackgroundParty` uses the RestPolicy line.
- **CMB-24 pet revival is not C4 doRevive.** `PetRuntime.revive` and `SummonControl.revivePet` (which calls it, then
  sets HP/MP again) give full HP and MP; Lisvus pets revive at 70 % HP like players (`Formulas.respawnHp`).
- **CMB-25 resurrection's EXP restore does not wash karma** (Lisvus `restoreExp` -> `addExp` does).
- **CMB-20 hot-only rules with no cold counterpart** (may be intended): cast break, transfer pain, petrification,
  grade penalty, raid curse, position, C4 pets.
- **CMB-28 cold skill engagement hate is missing.** `BackgroundResolver.addHate` credits damage only; a resisted
  nuke gives no owner hate in a pet fight, while hot hostile casts add one before their success roll. Cold currently
  resolves secondary debuffs only on damaging turns; standalone debuff effects are not resolved there. Route cold cast
  engagement through `C4SkillRules.provokesNpc` when this cold fight rule is aligned (changes the measured fights).
- **CMB-29 Requiem is missing its aura shape.** Lisvus skill 1049 is `TARGET_AURA_UNDEAD`, but
  `C4SkillRules` preserves only `undeadOnly`, not `sourceTarget` or `radius`. Native requests still select a single
  enemy; its execution-only semantic test does not pin caster-centred casting or nearby aggro removal.

## Open questions

1. CMB-1/2: raw reuse and MP in cold — simplification or gap? One function for hot, cold and estimates? (c4-check:
   gap; one shared reuse and MP function, the NPC 1000 ms floor is ours.)
2. CMB-7: does a C4 monster hit have weapon spread? (c4-check: yes, Lisvus +0..10 % for every attacker.)
3. CMB-3: should a servitor swing go through `Attack.hit`? (c4-check: yes, C4 has no servitor override.)
4. CMB-20: grade penalty, transfer pain, cast break absent in cold — by design?
5. Do cold bots fight with C4 pets, or servitors only by design?
6. CMB-9: can `BuffCatalog`/`activeBuffs` go, or do packets need them? (Stats still read them, CMB-9.)
7. CMB-12: should combat events reach AI/economy through a hook?
8. CMB-11: merge cold solo and party fights?
- **CMB-26 not pinned by a test:** a cold bot that PKs and dies in the same cold fight has its death wash capped by
  the karma after the fight's kills (`DeathExperience.applyColdDeath` + the cold commit); no three-fighter test covers
  it.
