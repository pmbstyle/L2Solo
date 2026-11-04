# C4 check: combat rules (2026-11-03)

Checked at 199c3b19 (2026-11-04).

Read from source: Lisvus `gitlab.com/TheDnR/l2j-lisvus` @ fdc7e33 (the revision the project uses) and L2J Mobius
master 245bc80a `L2J_Mobius_C4_ScionsOfDestiny`. Mobius "C4" carries later-chronicle code (it says "Interlude
adjustment", "H5 Damage Formula"); where they differ, **Lisvus is taken as C4**.

| # | Rule | C4 | Project now | Verdict |
|---|---|---|---|---|
| CMB-1 | Skill reuse | `L2Character.doCast`: reuse × m/pReuseRate × 333/MAtkSpd or PAtkSpd; Skill Mastery (players) → 100 ms. NPCs: same formula, no Mastery, no floor | Hot player `Actor.markSkillReuse` matches. NPC `NpcCombatChoice.reuseMs` = max(1000, raw); pets and cold raw reuse, no speed scaling | Player OK. NPC 1000 ms floor is ours, not C4. One shared reuse function (Mastery as a flag) for player, NPC, pet, cold |
| CMB-2 | MP cost | `CharStat.getMpConsume/getMpInitialConsume`: initial part paid at cast start (lost on interrupt), rest at hit; dance + n × nextDanceCost; consume-rate stats | Hot formula matches but pays all at landing (interrupt loses nothing). Cold raw `skill.mp` | Hot: split initial/rest (needs per-level `mpInitialConsume` from the Lisvus datapack). Cold: use the shared function |
| CMB-4 | PvP flag | `updatePvPStatus`: attacker flagged only if target karma == 0; at swing start, hit or miss; summon flags owner; Lisvus 40 s / 20 s | `PvpRules.flagsAttacker`, hot `PvpFlag.attack` at swing start (hit or miss) and offensive skill landing (Lisvus `callSkill`), summon/pet flags owner; cold same rule. 15 s | OK. 15 s is ours |
| CMB-4 | PvP kill | `onKillUpdatePvPKarma`: flagged target + killer without karma → PvP+1; war → PvP+1; karma target → PvP+1 (`AwardPKKillPVPPoint=True`); white → PK+1 + karma 240 × max(1,pk/2) × max(1,lvl ratio) ≤ 10000; killing a summon gives karma, no PK | `PvpRules.killOutcome` + `tallyAfterKill`, hot `ReceivedHit.creditKill` (also a summon's/pet's death), cold resolver + commit | OK |
| CMB-4 | CP | `PcStatus.reduceHp`: transfer pain, then CP absorbs when attacker is playable (player, summon, pet), then HP | `PvpRules.shieldDamage` after transfer pain, playable = character, summon or pet (`PvpRules.isPlayable`) | OK |
| CMB-7 | Monster melee spread | Lisvus `calcPhysDam`: +0..10 % for every attacker | Hot NPC and hot servitor (`Attack.prepareNpcMeleeHit`): no spread; player ±pAtkRnd % (Mobius shape); cold mobs ±30 %, cold servitors ±template pAtkRnd | One rule in HitRules for all attackers (Lisvus +0..10 %); player rule differs from Lisvus too |
| CMB-20 | Grade penalty | skill 4267 level 1: ×0.22 to atk/cast speed, evasion, EXP/SP, run speed, regen | `C4GradePenalty` matches (hot only) | OK. Cold only matters if cold bots can wear over-grade gear (unchecked) |
| CMB-3 | Servitor attack | No overrides: `L2Character.onHitTimer` — reflect, absorb, cast/attack break, owner flag, target CP | `SummonControl.attackTick` calls `receivedHit` directly: no cast break, reflect, arena check (owner flag and CP applied) | **Not C4:** route the servitor swing through `Attack.hit` with `Formulas` timing |
| CMB-17 | Deep blue | Drops: highest level of all attackers (raid: skip > raid+8); EXP: (5/6)^(diff−5) over 5, highest rewarded member in range | `ProgressionRates.deepBlueRule`, `MobExperience.gapFactor` match | OK. Cold party counts a member who never hit (slightly broader) |
| Cast feedback / engagement | Hex, Power Break and other hostile casts | Lisvus `doCast`: use message 46 with skill id + level; `Continuous`: failure 158 to caster, no separate success acknowledgement. `callSkill` → attacked event → one hate and leader/minion assistance before success roll, except hate removal/reduction and blows. Mobius also provokes on resist but uses failure message 139 | Hot `Attack` / `C4SkillEffects` follow Lisvus; `Npc/Attacked` owns the shared hit/cast reaction, including group and clan assistance | Hot OK. Cold damage-only hate remains CMB-28 |
| Resurrection target | Skill 1016 | Lisvus `L2Skill.getTargetList`, `TARGET_CORPSE_PLAYER`: a living target gets `INCORRECT_TARGET` (109), no cast. Mobius C4 also rejects living targets but its resurrection condition sends 113 | `SkillExec` and `Attack.remoteHit` call `Attack.validateResurrectionTarget` before approach and again at cast start; it uses `isValidSkillTarget` and sends 109 + ActionFailed. Dead targets remain eligible | Follows Lisvus |

Not verified: retail itself (code + shipped settings used); Mobius pinned 6bc10d28 vs master; whether a healer joins
`_attackByList`; source of NPC `pAtkRnd` = 30 in `data/Npcs`; whether cold bots equip over-grade gear.
