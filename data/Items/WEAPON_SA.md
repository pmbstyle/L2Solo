# C4 weapon special abilities

The runtime covers 352 ordinary weapon SA variants (including old client IDs) and 91 C–S dual-sword templates. Dual bonuses require +4. Hero weapons are outside this Soul Crystal catalog; their existing equipment passives remain separate.

`weapon_sa.json` stores passive links, inline modifiers, conditions and proc definitions. `Weapons/c4_sa_catalog.json` adds 340 templates absent from the existing catalogs. Generate both with:

```sh
python3 scripts/generate-c4-weapon-sa.py /path/to/l2j-lisvus
```

Source: [Lisvus C4 datapack](https://gitlab.com/TheDnR/l2j-lisvus/-/tree/fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975) layout from the Lisvus checkout at revision `fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975`, `datapack/data/stats/items` and `datapack/data/stats/skills`. The generator needs that checkout only; gameplay and tests use committed JSON. Existing `C4EquipmentItemSkills` supplies the sourced passive-skill tables. Inline modifiers override duplicate passive modifiers, so S-grade Haste and PvP bonuses do not double-stack.

Weapon critical rate from XML is multiplied by ten for this runtime's per-mille representation. The existing pole-SA and S-grade supplements are corrected to the same units; equipping an SA must not accidentally multiply a weapon's base critical rate by ten. Bow templates retain the server's existing 700-base-range policy. Explicit pole range and angle, Light's reduced weight, and shot/MP/reuse values are preserved. The generator imports missing IDs without overriding existing templates.

The integration audit also aligns 77 existing base weapon templates with the
pinned C4 values. This fixes legacy accuracy offsets, the attack values of
Akat Long Bow, Soul Bow and Sword of Miracles, critical-rate units of Berserker
Blade, Basalt Battlehammer and Dragon Hunter Axe, and nine bows' base MP costs.
Installation must not change these base values; bonuses belong to the SA effect.

## Combat behavior

- Passive bonuses enter normal stat calculation. HP-dependent risk effects update on either side of 60% HP, including cached evasion, critical rate and attack speed. Back Blow remains directional.
- Critical procs execute at normal-attack impact, after a landed critical, on each actually hit target. Skills and misses do not trigger them. Switching weapons during the swing prevents the old weapon's proc.
- Magic procs execute after a completed magical cast on its actual recipients, matching harmful/support magic. A resisted main spell can still roll its SA, following Lisvus `L2Weapon.getSkillOnCastEffects`; cancelled casts and toggles cannot. Procs use the existing resist, stacking, expiry, control and DoT engines.
- Proc chance is distinct from the effect resistance check. Procs do not inherit or consume soulshot/spiritshot bonuses, do not consume extra mana/items, and do not recursively trigger another weapon proc.
- HP Drain restores 3% of actual melee HP damage. Critical Drain restores a flat amount capped by actual HP lost and missing HP. Neither heals from overkill or damage absorbed by CP. Drain cannot revive an attacker killed by reflected damage.
- Critical Anger adds 248 to the critical damage attack term and costs 12 HP at impact. It requires HP above 12 and cannot kill or revive its owner.
- Cheap Shot rolls once per normal bow attack. Miser rolls once when consuming Soulshots. Quick Recovery modifies bow reuse. Magic Power increases spell mana cost as well as M.Atk. PvP damage modifiers apply to player/bot targets, not NPCs.

## Source corrections and remaining uncertainty

The general behaviors follow the [archived official SA list](https://legacy-lineage2.com/Knowledge/enhancements_3.html). C4 client item descriptions reproduced by L2Hub fill missing datapack entries:

| Item | Correction | Evidence |
| --- | --- | --- |
| 5600 Meteor Shower | Critical Bleed, 42%, bleed effect 7 (SA skill 3021 level 5) | [C4 description](https://l2hub.info/c4/items/meteor_shower_crt.bleed) |
| 5609 Carnage Bow | Critical Bleed, 35%, same bleed effect | [C4 description](https://l2hub.info/c4/items/carnium_bow_crt.bleed) |
| 5613 Soul Bow | Critical Poison, 18%, poison effect 7 (SA skill 3024 level 6) | [C4 description](https://l2hub.info/c4/items/soul_bow_crt.poison) |
| 7706 Stick of Eternity | Blessed Body level 3, 20% on support magic | Missing C4 link; [matching later client description](https://l2tools.org/interlude/items/stick-of-eternity-blessed-body-7706), compatibility mapping |
| 5606 Branch of the Mother Tree | Additional magic damage, power 8, 30% on harmful magic | [C4 description](https://l2hub.info/c4/items/worldtree%27s_branch_magicdamage) |
| 6584, 6591, 6598 | Continuous 3% melee HP Drain, replacing the incorrect critical-drain link | Official SA list above |
| 4681 Stormbringer | Critical Anger: 12 HP / 248 critical attack term | [C4 description](https://l2hub.info/c4/items/stormbringer_crt.anger) |
| 5604 Elysian | Critical Drain: 19 HP | [C4 description](https://l2hub.info/c4/items/elysian_crt.drain) |

The empty `3022` Critical Drain skill is implemented as flat healing on each landed critical, following item descriptions instead of the incomplete XML proc. Values are Chakram 6, Raid Sword/Sword of Limit 9, Great Pata 10, Dragon Slayer 11, Bellion Cestus 14, old Blood Tornado variant 16, Elysian 19. **The obsolete Blood Tornado 4807 value of 16 is a compatibility value, not independently verified C4 retail data.** Current Blood Tornado SA variants are 5620–5622.

**Magic Paralyze 3075/3079 has no effect body or duration in either available C4 source.** The implementation uses immediate paralysis for 15 seconds with the XML proc chance and resistance parameters. This is an explicit compatibility policy, not a verified retail C4 duration/staging. Replace it when authoritative C4 server data is available. The rest of the proc durations and tick powers come from the pinned XML.

## Installation and removal

`weapon_sa_exchanges.json` is generated by `scripts/generate-c4-sa-exchanges.py`
from the same pinned Lisvus revision. Source multisells are 1005, 81262510,
81262501, 81262509 and 80922001; all specify `maintainEnchantment="true"`.
The [official enhancement guide](https://legacy-lineage2.com/Knowledge/enhancements_3.html)
also states that SA does not alter weapon enchantment.

- Eight source-listed village blacksmiths offer 243 C/B-grade installations.
- Blacksmith of Mammon (8126, including the permanent Giran service) offers
  85 A/S-grade installations and 352 removals. His unsealing menu is retained.
- Black Marketeer of Mammon (8092) offers 298 sourced removal recipes, charging
  their exact Ancient Adena amounts. Mammon's own removal recipes are free.
- Installation consumes the exact color/stage Soul Crystal. C/B installations
  also consume their sourced gemstones. **Temporary policy:** Gemstone A/S
  (2133/2134) and Ancient Adena (5575) are excluded from installation costs;
  all 85 A/S installations currently require only the Soul Crystal. The preview
  and transaction use the same filtered costs; owned waived materials are not
  consumed. Original recipes remain in the catalog for later restoration.
  A higher-stage or differently colored crystal cannot substitute. Removal
  returns only the weapon, never the consumed materials, and retains its fees.
- The 1005 `isTaxIngredient` Adena amounts are **tax bases**, not fixed fees:
  Lisvus `L2Multisell.prepareEntry` multiplies them by the castle tax rate.
  This world currently has no castle-tax service, so these amounts yield zero
  Adena tax. Tax bases remain in the catalog for future tax integration.

The source has 36 installation entries outside this project's C4 catalog;
they are explicitly listed as excluded and cannot be produced. Four canonical
variants omitted from Mammon's removal list use the inverse of their exact
installation recipe (Carnage Bow Quick Recovery and three Shining Bows).
Twenty old client SA aliases can also be removed to the matching base weapon;
installation produces only the canonical variants in the source lists.
Knuckle Duster (4233), Shining Bow (6368) and Ancient Adena (5575) receive the
previously missing templates. Adding Ancient Adena as an item does not implement
the Seven Signs currency acquisition cycle.

The player unequips the weapon, chooses an option, reviews the exact resulting
weapon, enchantment and costs, then confirms. The server binds that confirmation
to the NPC, character and selected inventory object. It rechecks distance,
ownership, enchantment, equipment state, trade/combat state and materials at
commit time. Replays and concurrent confirmation clicks cannot repeat payment.
SQLite consumes materials and updates the weapon template in one transaction.
Its object id, enchantment and other persisted instance fields remain intact;
no intermediate +0 weapon is created. No extra inventory slot is needed.

`tests/test_weapon_sa_exchange.js` validates all 978 recipes and executes all
328 installation/removal round trips with +0/+3/+7/+16 weapons. It also checks
multiple identical weapons, exact costs, split stacks, rollback after payment,
replay, stale state, nearby NPC restrictions, dialog routing and inventory reload.
It compares base combat stats and resource costs for every installable pair.
A combined scenario accepts quest 350, claims and casts a green crystal through
five successful absorptions, installs Focus on a +7 Stormbringer, checks the
equipped stat bonus, reloads inventory and quest state from SQLite, and removes
the SA without losing enchantment or retaining its bonus.

## Remaining gameplay dependencies

- **A/S-grade material acquisition is not connected.** Gemstone C/B are sold
  by existing NPC shops, but Gemstone A (2133) and S (2134) have no implemented
  shop/drop source. Lisvus Merchant of Mammon multisell 81132501 sells them for
  30,000 and 100,000 Ancient Adena respectively. Neither that exchange nor the
  Seven Signs currency acquisition cycle is implemented. The temporary
  installation waiver above lets players install A/S abilities without those
  materials. Paid Black Marketeer removal still requires Ancient Adena;
  Blacksmith of Mammon's free removal remains available.
- Only 62 of 110 absorption targets currently have runtime templates; see
  `SOUL_CRYSTALS.md`. Existing encounters provide a route through stage 13,
  but the complete retail target roster is not present.
- The source uncertainties above remain: Magic Paralyze duration, obsolete
  Blood Tornado drain value, and the estimated 70% crystal-growth boss chance.
- A server restart and an actual client walkthrough remain unverified. An
  automated SQLite/inventory scenario does not establish live deployment.

## Effect validation

`tests/test_weapon_sa.js` checks every catalog item and every proc variant using the real effect engine, as well as queued melee/cast entry points, duplicate suppression, risk threshold transitions, +4 duals, resource consumption, HP drain, PvP scope and weapon switching. Run it through the normal test runner. Runtime deployment and a game-client walkthrough are separate validation steps; loading the new files requires a server restart.
