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
- **Playable poison chances:** `C4SkillRules` separates Mobius C4's base chances from legacy poison strength:
  Poison Blade Dance 84, Corpse Plague 103 and Poisonous Cloud 1167 use 35%; Venom 1095 and Curse: Poison 1168
  use 70%; Seal of Poison 1209 uses 60%. Ordinary Poison 129 already uses 70%. Each carries its source magic
  levels and level dependence 1; `HitRules.effectLandChance` remains the shared formula owner for hot and cold.
  This explicitly selects Mobius's chance over Lisvus's 1..8 values. Damage, duration and existing resistance
  modifiers are unchanged. Cost on main/worker: for 103/1095/1168 the existing chance calculation adds one addition
  and one division for the restored magic level; no extra rolls, scans, per-bot state, DB writes or worker messages.
  More landed hot effects use the existing effect/DoT timers and ticks. Cold still excludes standalone debuffs (CMB-28).
- **NPC attack reaction:** hot `Npc/Attacked` owns hate and the leader/minion + clan assistance notification for
  `ReceivedHit` and `C4SkillEffects`. A dying minion calls its leader before removal; a dying leader calls nobody.
  `C4SkillRules.provokesNpc` owns cast engagement for enemy-targeted skills and corpse-targeted area skills
  (hate removal/reduction and dagger blows excluded). A corpse selects the area centre; the existing living,
  attackable-target gate in `C4SkillEffects.execute` excludes it from the reaction. Corpse Plague's living victims
  receive engagement at impact even when their poison is resisted, before any damage tick.
  `C4SkillEffects.execute` calls the reaction before the success roll, including a resisted debuff. Its result's
  `npcAttacked` flag crosses the native/proc/cubic HP-hit boundary so damage credits its hate without calling
  assistance twice. `Attack.beginRemoteCast` sends the player's use message;
  `C4SkillEffects.execute` sends failure to the caster for a resisted spell/effect, independently of HP damage.
  Target-side magic resistance remains separate. `Response/ConsoleText` encodes a skill name as id + level.
  Cost on main: one semantic predicate and one hate update per hostile cast/target, the existing group's minion
  walk and one indexed clan-neighbour query (only with clan/help radius), one use packet per player cast and one
  failure packet per resisted target. The subsequent HP hit only adds damage hate; no duplicate assistance walk,
  global world scan, DB write, worker message, per-bot state or per-tick work is added.
  Corpse-area casts add one target-kind comparison and one existing area-set lookup per recipient, then the same
  hate/assistance reaction as other hostile casts. Enemy-targeted casts short-circuit before that work. The shared
  predicate stays pure; the cold fight's damage-only engagement remains CMB-28.
- **Effects:** `EffectStore` (authoritative), `EffectStats`, `EffectTicker`, `EffectRestrictions`; `BuffCatalog` legacy.
  Hot NPC control uses `Npc.interruptCombatActions`: it cancels the current swing/path request and sends
  AutoAttackStop, preserving combat intention, target and every hate entry. The existing combat loop waits on
  restrictions; expiry, damage wake-up and cleanse all release it without a separate resumption path.
  `Npc.startCombatActions` restores client attack state on the next admitted swing/cast. Sleep, stun, paralysis
  and fear share this lifecycle; player stance cancellation stays in `EffectRestrictions.interruptOnApply`.
  Interrupted chase retries start afresh after control. A hate wipe, invalid target, leash or ordinary attack
  timeout can still end the fight. Main cost: one attack-state check per existing 100 ms combat step, one guard
  per swing/cast, and 10 restriction polls/s per controlled NPC instead of losing its loop. Controlled steps
  return before target/hate scans, distance allocations or pathfinding; no new timers, per-bot fields, DB writes
  or worker messages. Cold fight rules and measured tables are unaffected (runtime interruption only).
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
- **CMB-15 local patches:** skills 109/121 in HEAL_PERCENT, weapon 5606 in
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
- **CMB-28 cold skill engagement hate is missing.** `BackgroundResolver.addHate` credits damage only; a resisted
  nuke gives no owner hate in a pet fight, while hot hostile casts add one before their success roll. Cold currently
  resolves secondary debuffs only on damaging turns; standalone debuff effects are not resolved there. Route cold cast
  engagement through `C4SkillRules.provokesNpc` when this cold fight rule is aligned (changes the measured fights).
- **CMB-29 Requiem is missing its aura shape.** Lisvus skill 1049 is `TARGET_AURA_UNDEAD`, but
  `C4SkillRules` preserves only `undeadOnly`, not `sourceTarget` or `radius`. Native requests still select a single
  enemy; its execution-only semantic test does not pin caster-centred casting or nearby aggro removal.
- **CMB-30 NPC and weapon poison chances still differ from the native player rules.** NPC skills
  4035/4036/4182/4198 use Lisvus's strength as chance instead of Mobius's 70/35/90/90; Toxic Smoke 4259 is 80 here
  vs 35 there, and 4649 is 100 vs 35. Choose the remaining data source before changing world difficulty.
  `C4WeaponSA.procSkill` overlays generated `data/Items/weapon_sa.json` semantics on the same skill: Magic Poison's 1168
  level 6 still has base chance 7 after its independent 6-8% trigger roll. The generator duplicates the skill
  chance owner (`generate-c4-weapon-sa.py`); align that ownership before migrating the weapon proc.

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
| Cast feedback / engagement | Hex, Power Break, Corpse Plague and other hostile casts | Lisvus `doCast`: use message 46 with skill id + level; `Continuous`: failure 158 to caster, no separate success acknowledgement. `callSkill` → attacked event → one hate and leader/minion assistance before success roll, except hate removal/reduction and blows. Mobius also provokes on resist but uses failure message 139 | Hot `Attack` / `C4SkillEffects` follow Lisvus; `Npc/Attacked` owns the shared hit/cast reaction, including group and clan assistance. `C4SkillRules.provokesNpc` includes corpse-targeted area casts; living attackable victims react at impact even on resist, while the corpse anchor is excluded | Hot OK. Cold damage-only hate remains CMB-28 |
| Playable poison chances | Skills 84,103,1095,1167,1168,1209 | Lisvus uses poison strength tables 1..8 as base chances. Mobius C4 separates `abnormalLevel` from `activateRate`: 35/35/70/35/70/60 respectively. Both sources agree on these skills' magic levels | Native casts through `C4SkillRules` use Mobius's base chances and the shared source magic levels, keeping existing damage and timing; the shared land formula still applies level, shots and resistance modifiers. Ordinary Poison 129 already has base chance 70 | Explicit choice of Mobius for playable poison base chances. NPC poison discrepancies and the weapon-proc override remain CMB-30 |
| Resurrection target | Skill 1016 | Lisvus `L2Skill.getTargetList`, `TARGET_CORPSE_PLAYER`: a living target gets `INCORRECT_TARGET` (109), no cast. Mobius C4 also rejects living targets but its resurrection condition sends 113 | `SkillExec` and `Attack.remoteHit` call `Attack.validateSkillTarget` before approach and again at cast start; it uses `isValidSkillTarget` and sends 109 + ActionFailed. Dead targets remain eligible | Follows Lisvus |
| Undead-only target | Disrupt Undead 1031 and other `TARGET_UNDEAD` skills | Lisvus `L2Skill.getTargetList` requires a living undead NPC or summon, sends `INCORRECT_TARGET` (109) for a non-undead NPC, and cancels before cast start and MP payment. `TARGET_AURA_UNDEAD` instead filters its victims and can cast without any. Mobius C4 uses a target-race condition and message 113 for Disrupt Undead | `Attack.validateSkillTarget` rejects non-undead single targets before approach and cast start; `isValidSkillTarget` admits undead NPCs/summons and filters undead auras. Refusal sends 109 + ActionFailed, preserves MP/reuse and provokes nobody | Follows Lisvus |
| NPC control / hate retention | Sleep (1069), stun, paralysis and fear | Lisvus `startSleeping` aborts attacks/casts; `L2CharacterAI.onEvtSleeping` stops movement and client auto-attack without changing attack intention or hate. `stopSleeping` sends `EVT_THINK`. Mobius C4 `AttackableAI.onActionThink` also waits while all skills are disabled | `EffectRestrictions.interruptOnApply` cancels NPC actions through `Npc.interruptCombatActions`, retaining the existing combat loop and hate. It resumes against the highest valid hate after restrictions end; no auto-aggro or new hit is required | Follows Lisvus's retained intention; existing 100 ms loop supplies the think event |

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
