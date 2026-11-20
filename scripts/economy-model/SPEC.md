# Economy model: what a bot decides

This file states the rules of the model's decision layer: what a hunter ("main") and a crafter ("twin") decide in design mode. The snapshot (inputs.js), kit hours, the event engine, the ledger and its closures and today mode are not rebuilt from it. No new decision code without a row here.

How the rows read:
- Every normative row is a line of a table that starts with its id in backticks. spec-rows.js reads these lines; a person reads plain tables.
- A table with a `kind` column holds levers; a table with a `fact` column holds situations.
- status is one of: `planned`, `built`.
  - planned: no code follows the row yet as written; for a situation or a lever, rules/levers.js holds no id for it.
  - built: the code follows the row as written; a situation or a lever has its id in rules/levers.js; the test cell names the case that pins it (`<test file>: <case>`).
- tests/test_economy_model_spec.js holds the situation and lever rows marked built equal to the ids of rules/levers.js.
- A C4 source marked "not verified" is from memory and is checked on l2hub C4 or the Lisvus datapack before its row is built.

## 1. Form of the decision layer (the reason holes become visible)
| id | rule | status | test |
|---|---|---|---|
| `FORM.1` | A situation is a physical fact of one bot (held shots under the reserve, bag full, arrived in a town, a line of mine sold). No price, clock, board or another decision's answer inside it. | planned | — |
| `FORM.2` | For each situation the spec lists its levers in order. A lever is a pure function of the bot's own view: it returns an action, or "no" with a named reason. | planned | — |
| `FORM.3` | Levers are of two kinds. FREE levers cost no hunting time (a shout in trade chat, a whisper): every one that applies is taken. MOVE levers take the bot off its spot (a trip): at most one is taken, the first in order that returns an action; with none, the bot stays at its spot in the state the row names (hunting without shots). So a bot can shout WTB, keep hunting without shots and walk to a seller once one answers. | planned | — |
| `FORM.4` | The run counts, per situation and lever: taken, and refused by reason. This is the lever report; a lever that never fires, or a situation that ends in "hunt without" most of the time, is a printed line, not a discovery. | planned | — |
| `FORM.5` | No situation may have "wait" as its only lever unless the row states why a C4 player would also wait. | planned | — |
| `FORM.6` | One test holds the code's situation and lever list equal to this file's rows. | built | test_economy_model_spec.js: a row or a lever on one side only fails with its id |

## 1a. A bot's time
| id | rule | status | test |
|---|---|---|---|
| `TIME.1` | At any moment a bot is in exactly ONE state: hunting at its spot; on the way (walk or gatekeeper hop, hours from the route); in town (the visit's time); resting or dead time the hunt cycle already holds. | planned | — |
| `TIME.2` | The hunt credits only hunting hours. | planned | — |
| `TIME.3` | The run prints hours per state per band. | planned | — |
| `TIME.4` | Shot coverage = shots fired over shots wanted in HUNTING hours. | planned | — |
| `TIME.5` | The cost of a trip is its hours on the way and in town (lost hunt), printed beside it. | planned | — |

## 2. What a bot knows (one rule for shots, gear, materials)
| id | knowledge | how it is gained | how it ends | status | test |
|---|---|---|---|---|---|
| `KNOW.PRIOR` | Prior: which towns are the trade towns of a grade; NPC lists and prices; gatekeeper fares; walking hours | given at start (a C4 player reads a guide) | never | planned | — |
| `KNOW.SEEN` | Seen: the sellers and buyers standing in a town (who, item, price, units) | the bot stands in that town (hot: runs through the market; cold: the visit's time) | replaced whole at its next visit to that town; one row ends when a whisper to that seller gets "sold" or no answer | planned | — |
| `KNOW.HEARD` | Heard: trade chat (WTS and WTB shouts) | a shout made in the bot's region while the bot is in that region | as a seen row | planned | — |
| `KNOW.TWIN` | Own twin: its stock, seat, lines | always (same player) | never | planned | — |
| `KNOW.UNSEEN` | Not known: any line in a town it has not visited and has not heard. The live books of all towns are not read. | never gained without a visit or a shout heard | as a seen row, at the visit or the shout | planned | — |

## 3. Hunter (a solo bot in an NPC world, build F step 1)
### 3.1 Situations (the facts of one bot; heard where it stands, by the catalog in design/catalog.js)
| id | fact | heard | wakes | status | test |
|---|---|---|---|---|---|
| `SIT.BORN` | a new character enters the world and stands in its first town | at once | supply | built | test_economy_model_design.js: a fresh bot that runs out of shots walks to its spot's town, sells its drop, buys toward its target, walks back |
| `SIT.OUT` | the shots it fires run out while it hunts (held becomes 0) | at its next stop: at once while hunting, in town; on arrival from the road | supply | built | test_economy_model_design.js: Out of shots while hunting is heard at once |
| `SIT.BAG` | its bag reaches the game's full rule (slots or weight, worn kit and shots counted) and was not full before | at its next stop, as OUT | supply | built | test_economy_model_design.js: Its bag full with shots held |
| `SIT.TOWN` | it arrives in a town (a trip's end, a birth or a respawn) | at once | supply | built | test_economy_model_design.js: a stock run out on the road waits and is heard on arrival in one chain with the town fact |
| `SIT.DIED` | it dies | at once | nothing: the respawn town's arrival runs the town's decisions | built | test_economy_model_design.js: a death puts the bot in its respawn town where the town chain runs |

### 3.2 Levers (the supply decision: pure on the bot's own state, in the run's variant, table or formula)
| id | situation | kind | lever | condition | waking event | C4 source | status | test | counter |
|---|---|---|---|---|---|---|---|---|---|
| `LEV.BUY` | SIT.BORN, SIT.OUT, SIT.BAG, SIT.TOWN | move | In a town: buy the shots it fires up to its stock target (a full bag's use plus the reserve, ConsumableTarget) with its wallet; in the field: walk to the town of its held spot (the NPC that sells them) when money, a surplus to sell or a bare hour that pays say so | the town's NPC sells the shot; the wallet is money plus what the surplus sells for there | the facts of the situation column | not verified: a C4 player buys shots at the grocer and walks back | built | test_economy_model_design.js: a fresh bot that runs out of shots walks to its spot's town, sells its drop, buys toward its target, walks back | design counters |
| `LEV.SELL` | SIT.TOWN | free | In a town: sell the whole surplus (bag, the shots it does not fire and those above target) to the NPC at its buy price | something to spare | arrival in the town | not verified: a C4 player sells drops to the NPC | built | test_economy_model_design.js: Table in town with 0 adena and 40 drop | design counters |
| `LEV.STAY` | SIT.OUT, SIT.BAG | stay | Hunt on in the state it is in (without shots): no money, nothing to sell; stuck counts only where the bot kills nothing bare | no move lever taken | no move lever taken | not verified: hunts on without shots | built | test_economy_model_design.js: Out of shots with nothing to pay with, both variants stay for the same reason | stuckNoBareHour |

| id | rule | status | test |
|---|---|---|---|
| `H.SHOTS.WAY` | The way: gatekeeper if the purse covers it there and back with the purchase; else walk (hours); else sell the bag in the nearest town first. | planned | — |
| `H.SHOTS.HOLD_END` | A held deal ends at: the buyer's arrival (bought), its death, its trip changed, the seller's line withdrawn. No timer. | planned | — |

## 4. Crafter (twin)
### 4.1 What wakes it
| id | actor | fact | levers | status |
|---|---|---|---|---|
| `T.WAKE.1` | crafter | its main arrived | T.CRAFT.1 to T.CRAFT.4 in that order | planned |
| `T.WAKE.2` | crafter | a line of its sold | T.CRAFT.1 to T.CRAFT.4 in that order | planned |
| `T.WAKE.3` | crafter | a batch ended | T.CRAFT.1 to T.CRAFT.4 in that order | planned |
| `T.WAKE.4` | crafter | it hears a WTB in its region | T.CRAFT.1 to T.CRAFT.4 in that order | planned |
| `T.WAKE.5` | crafter | it receives a whisper in its region | T.CRAFT.1 to T.CRAFT.4 in that order | planned |
| `T.WAKE.6` | crafter | its shelf of a product is empty | T.CRAFT.1 to T.CRAFT.4 in that order | planned |

### 4.2 What to craft next
| id | situation | kind | lever | condition | waking event | C4 source | status | test | counter |
|---|---|---|---|---|---|---|---|---|---|
| `T.CRAFT.1` | T.WAKE.1-6 | not stated | What its own main needs | recipe, materials | a T.WAKE situation | none named | planned | — | lever report |
| `T.CRAFT.2` | T.WAKE.1-6 | not stated | What was asked: whispers held, then WTBs heard in its region at or above its cost | recipe, materials | a T.WAKE situation | none named | planned | — | lever report |
| `T.CRAFT.3` | T.WAKE.1-6 | not stated | What sold since its last batch, up to the shelf target | recipe, materials | a T.WAKE situation | none named | planned | — | lever report |
| `T.CRAFT.4` | T.WAKE.1-6 | not stated | Nothing: MP stays | no demand heard at or above cost | a T.WAKE situation | none named | planned | — | lever report |

### 4.3 Where it sits
| id | rule | status | test |
|---|---|---|---|
| `T.SEAT` | The trade town of its main product's grade (prior knowledge). It moves when its product changes grade. | planned | — |

### 4.4 Its price
| id | rule | status | test |
|---|---|---|---|
| `T.PRICE` | Ask: first price from cost; falls a step when a batch ended with the shelf unsold and no sale since; rises a step when the shelf emptied before the batch ended; never under cost. | planned | — |
