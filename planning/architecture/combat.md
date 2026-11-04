# Combat, skills, actors

Checked at 39e43408 (2026-11-04).

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
- **Item-skill casts** (scrolls, resurrection items, pet summon, drain soul, sow): `Backpack.castItemSkill` on the
  caster's `attack.queueTimer`, so whatever cancels a cast cancels it and it never lands on another character; the item
  is spent at cast start (Lisvus); writes go under the bag owner (`Backpack.ownerId`). A hit breaks only a magic cast
  (`Attack.tryBreakCast`, C4). Open tails: debt.md theme 9.
- **Damage sinks:** player `Actor/Generics/ReceivedHit` (transfer pain, CP shield, HP, PvP/PK tally, karma) → `Die`
  (PK drop `PkDeathDrop`, death EXP `DeathExperience.applyDeathPenalty`); revive `Revive` / `RestartPoint` at
  `Formulas.respawnHp` (70 %); NPC `Npc/Generics/ReceivedHit` (overhit, hate, minions, social aggro) → `Die` → `NpcDied`
  (EXP/SP, quests, sweep); drops `World/Generics/NpcRewards`.
- **Monster:** `Npc/Npc.js` hate (`NpcHate`, shared with cold), own `meleeHit`/`hit`, skill choice `NpcCombatChoice`
  (shared), aggro `NpcAggro` + `NpcAggroRange`, `SocialAggro`, `SpoilSweep`.
- **Skills:** `C4SkillRules` (per-skill semantics, hot and cold), `C4SkillEffects.execute` (hot effects, one long
  `skillType` chain), `ChargeLifecycle`, `ToggleSkills`, `CubicControl`, `SkillReuse` (persistence only).
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
| A skill rank's base numbers (hit time, reuse, cast type, MP, power, duration) | `Model/Skill` fetchers (C4SkillRules over the data row); cold records copy them (`ColdCombatProfile.skillRecord`) |
| Is a skill magic (cast speed, spiritshot, cast break, MP and land rate; also picks the damage formula, debt.md 17) | `Skill.fetchSpell` (a `C4SkillRules` `isMagic` over the data `spell` flag), hot and cold (the record copies it, `ColdCombatProfile.actionShot` reads it) |
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
  Mastery; cold `BackgroundResolver.spendSkill` uses the record's base reuse (no multipliers); `RaidHealingEstimate` copies the hot rule;
  NPC `NpcCombatChoice.reuseMs` = max(1000, raw). Cold casters cast less often.
- **CMB-2 MP cost differs.** Hot `Attack.skillMpCost` (dance cost, consume multipliers); cold the record's base `skill.mp`; partial
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
  (`ColdMobAction`) and cold servitors (`ColdSummonProfile`) do. C4 check below: +0..10 % for every attacker.
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
- **CMB-15 local patches:** skill 84 in `finalizeSkillResult`, skills 109/121 in HEAL_PERCENT, weapon 5606 in
  `C4WeaponSA`, duck-type guard in `Npc.hit` for stale aggro entries (crashed the process).
- **CMB-16 dead:** `Attack.physicalRaceModifier` test only (`test_melee_dd_class_skills`). (`Formulas.calcMagicSuccess`
  is live through `Formulas.calcSpoilSuccess`, hot `SpoilSweep` and cold `ColdKillRewards`; `HitRules` uses
  `calcMagicSuccessRate`.)
- **CMB-17 cold rewards copy:** `BackgroundDropResolver.progressionForFight` inlines `level*level*mod` instead of
  `Formulas.calcAcquiredExp`. (Cold drops do apply deep blue; a party passes its highest
  member's level as `killerLevel`, slightly broader than C4, C4 check below.)
- **CMB-18 raid gap `+8/+7` literal** in `OpportunisticRaidPolicy` instead of `RaidCurse.RAID_LEVEL_MAX_DIFFERENCE`.
- **CMB-19 peace zone checked in the request layer twice and in cold separately;** skills do not use the client-view
  rule of weapon hits.
- **CMB-21 C4 flags for support are missing.** Lisvus `callSkill` flags a player who casts a non-offensive skill on a
  flagged or karma character, or on a monster (except summon/feed/unlock); here only offensive actions flag.
- **CMB-22 `BotPvpThreats.character` maps any NPC with an owner to its owner**, a quest monster too (`QuestService`
  spawns with `ownerId`): its attacks are remembered as the owner's aggression. `PvpRules.isPlayable` gates the flag and
  the kill tally, not that memory.
- **CMB-24 pet revival is not C4 doRevive.** `PetRuntime.revive` and `SummonControl.revivePet` (which calls it, then
  sets HP/MP again) give full HP and MP; Lisvus pets revive at 70 % HP like players (`Formulas.respawnHp`).
- **CMB-25 resurrection's EXP restore does not wash karma** (Lisvus `restoreExp` -> `addExp` does).
- **CMB-20 hot-only rules with no cold counterpart** (may be intended): cast break, transfer pain, petrification,
  grade penalty, raid curse, position, C4 pets.

## C4 check (2026-11-03)

Read from source: Lisvus `gitlab.com/TheDnR/l2j-lisvus` @ fdc7e33 (the revision the project uses) and L2J Mobius
master 245bc80a `L2J_Mobius_C4_ScionsOfDestiny`. Mobius "C4" carries later-chronicle code (it says "Interlude
adjustment", "H5 Damage Formula"); where they differ, **Lisvus is taken as C4**.

| # | Rule | C4 | Project now | Verdict |
|---|---|---|---|---|
| CMB-1 | Skill reuse | `L2Character.doCast`: reuse × m/pReuseRate × 333/MAtkSpd or PAtkSpd; Skill Mastery (players) → 100 ms. NPCs: same formula, no Mastery, no floor | Hot player `Actor.markSkillReuse` matches. NPC `NpcCombatChoice.reuseMs` = max(1000, raw); pets raw reuse, cold the Skill model's base reuse (`ColdCombatProfile.skillRecord`), no speed scaling | Player OK. NPC 1000 ms floor is ours, not C4. One shared reuse function (Mastery as a flag) for player, NPC, pet, cold |
| CMB-2 | MP cost | `CharStat.getMpConsume/getMpInitialConsume`: initial part paid at cast start (lost on interrupt), rest at hit; dance + n × nextDanceCost; consume-rate stats | Hot formula matches but pays all at landing (interrupt loses nothing). Cold the record's base `skill.mp` (the Skill model's) | Hot: split initial/rest (needs per-level `mpInitialConsume` from the Lisvus datapack). Cold: use the shared function |
| CMB-4 | PvP flag | `updatePvPStatus`: attacker flagged only if target karma == 0; at swing start, hit or miss; summon flags owner; Lisvus 40 s / 20 s | `PvpRules.flagsAttacker`, hot `PvpFlag.attack` at swing start (hit or miss) and offensive skill landing (Lisvus `callSkill`), summon/pet flags owner; cold same rule. 15 s | OK. 15 s is ours |
| CMB-4 | PvP kill | `onKillUpdatePvPKarma`: flagged target + killer without karma → PvP+1; war → PvP+1; karma target → PvP+1 (`AwardPKKillPVPPoint=True`); white → PK+1 + karma 240 × max(1,pk/2) × max(1,lvl ratio) ≤ 10000; killing a summon gives karma, no PK | `PvpRules.killOutcome` + `tallyAfterKill`, hot `ReceivedHit.creditKill` (also a summon's/pet's death), cold resolver + commit | OK |
| CMB-4 | CP | `PcStatus.reduceHp`: transfer pain, then CP absorbs when attacker is playable (player, summon, pet), then HP | `PvpRules.shieldDamage` after transfer pain, playable = character, summon or pet (`PvpRules.isPlayable`) | OK |
| CMB-7 | Monster melee spread | Lisvus `calcPhysDam`: +0..10 % for every attacker | Hot NPC and hot servitor (`Attack.prepareNpcMeleeHit`): no spread; player ±pAtkRnd % (Mobius shape); cold mobs ±30 %, cold servitors ±template pAtkRnd | One rule in HitRules for all attackers (Lisvus +0..10 %); player rule differs from Lisvus too |
| CMB-20 | Grade penalty | skill 4267 level 1: ×0.22 to atk/cast speed, evasion, EXP/SP, run speed, regen | `C4GradePenalty` matches (hot only) | OK. Cold only matters if cold bots can wear over-grade gear (unchecked) |
| CMB-3 | Servitor attack | No overrides: `L2Character.onHitTimer` — reflect, absorb, cast/attack break, owner flag, target CP | `SummonControl.attackTick` calls `receivedHit` directly: no cast break, reflect, arena check (owner flag and CP applied) | **Not C4:** route the servitor swing through `Attack.hit` with `Formulas` timing |
| CMB-17 | Deep blue | Drops: highest level of all attackers (raid: skip > raid+8); EXP: (5/6)^(diff−5) over 5, highest rewarded member in range | `ProgressionRates.deepBlueRule`, `MobExperience.gapFactor` match | OK. Cold party counts a member who never hit (slightly broader) |

Not verified: retail itself (code + shipped settings used); Mobius pinned 6bc10d28 vs master; whether a healer joins
`_attackByList`; source of NPC `pAtkRnd` = 30 in `data/Npcs`; whether cold bots equip over-grade gear.

## Open questions

1. CMB-1/2: base reuse and MP (no multipliers) in cold — simplification or gap? One function for hot, cold and estimates? (C4 check:
   gap; one shared reuse and MP function, the NPC 1000 ms floor is ours.)
2. CMB-7: does a C4 monster hit have weapon spread? (C4 check: yes, Lisvus +0..10 % for every attacker.)
3. CMB-3: should a servitor swing go through `Attack.hit`? (C4 check: yes, C4 has no servitor override.)
4. CMB-20: grade penalty, transfer pain, cast break absent in cold — by design?
5. Do cold bots fight with C4 pets, or servitors only by design?
6. CMB-9: can `BuffCatalog`/`activeBuffs` go, or do packets need them? (Stats still read them, CMB-9.)
7. CMB-12: should combat events reach AI/economy through a hook?
8. CMB-11: merge cold solo and party fights?
- **CMB-26 not pinned by a test:** a cold bot that PKs and dies in the same cold fight has its death wash capped by
  the karma after the fight's kills (`DeathExperience.applyColdDeath` + the cold commit); no three-fighter test covers
  it.
