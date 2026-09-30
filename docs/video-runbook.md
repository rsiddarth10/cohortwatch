# Video runbook (30K preset)

Measured on a clean run (2026-10-01, run A): `docker compose down -v && SIM_SCALE=30000 SIM_SPEED=360 AUTO_REPAIRS=on docker compose up -d`.
Wall times count from the moment `up -d` returns. At 360× one wall-second is 6 sim-minutes, so a moment can pass in
seconds: **freeze the story with `npm run demo:pause`** while you talk, and `npm run demo:resume` to go on. Pausing
only stops the simulator producing new readings. The pipeline drains what is in flight and waits; nothing is lost.

`npm run demo:status` prints the sim time and which of these moments are ready right now, each with its URL.

| Wall time | Sim time | Moment ready | Where |
|---|---|---|---|
| ~0:30 | T0 | Stack healthy, board live | http://localhost:3000 (sign in `lead` / `lead-demo`) |
| **4:50** | T0+29 h | **S1 campaign open** (COOLING, KS-D1, urban, D-001; 15 vans) · a **runaway card** (D-032) | board → purple campaign card |
| 5:42 | T0+33 h | a pending agent proposal (another depot) · a runaway card **at D-001** | Agent & audit |
| **6:16** | T0+36.5 h | **3 at-risk sisters** on the S1 campaign page + the agent's **pending proposal** to book them into tomorrow's bays | campaign page; Agent & audit |
| 8:53 | T0+52 h | S1 at 16 vans; a new proposal for 2 sisters | |
| 9:47 → 11:20 | T0+58 → 67 h | repaired vans confirmed **FIXED** (1 → 14) | vehicle page of a repaired sister (green repair marker) |
| **13:50** | T0+82 h | the **bad repair NOT_FIXED** ("repair on … did not hold") back in the queue · a second runaway card at D-001 | board D-001; that van's page |

The at-risk window is short: at-risk sisters come and go every sim-hour (the first S1 proposal once lasted about 8 s).
**Pause at about 6:10** and check with `npm run demo:status` that "at-risk sisters visible" and "pending agent
proposal" are both ✅.

## The 5-minute story (clicks)

1. **Start** (before recording): `docker compose down -v && SIM_SCALE=30000 SIM_SPEED=360 AUTO_REPAIRS=on docker compose up -d`.
   Open http://localhost:3000, sign in as `lead` / `lead-demo`. Optional: `docker compose --profile observability up -d prometheus grafana`
   → http://localhost:3001 (the pipeline dashboard).
2. **~4:50, the outbreak.** On the board, the purple card "COOLING · KS-D1 · URBAN": click it. Show *Why we think it
   is one outbreak* (place, trend, firmware 4.2.1 before onset vs healthy sisters, "15 vans where 0.3 expected"),
   the members, "Looks like" past campaigns.
3. **~6:10, `npm run demo:pause`.** At-risk sisters appear on the campaign page (right column). Click one: its
   coolant is climbing out of **its own band** before any incident. Back on the campaign page, the agent's
   proposal → *evidence & dry run*.
4. **Agent & audit**: read the evidence (each line cited by id) and the dry run (which vans move, which drop to
   waiting). **Approve.** Go to the board: the sisters sit in tomorrow's bays with "booked by lead (approved agent
   proposal)". The audit trail at the bottom shows every view and the approval.
5. **The runaway**: the red card on the board → the van's page ("≈ N h to 110 °C", rank 1 in today's bays).
   `npm run demo:resume`.
6. **~11:30, fixes**: a repaired sister's page: green repair marker, FIXED. **~13:50**: the bad repair is NOT_FIXED
   and back in today's bays with "repair on … did not hold". The campaign stays open until every member is fixed.
7. **Viewer**: Sign out, sign in as `viewer` / `viewer-demo`: same board, no driver, only a coarse area, no buttons.

Numbers to quote are in [docs/evaluation.md](evaluation.md).
