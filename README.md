# Urvara AI

**Every Farm. Every Resource. In Sync.**

Urvara is a voice-first platform for farm owners and the farmers who work across their farms. It brings together weather, soil readings, crop reports, machines, people and stock, plans the work, and replans when something changes. Each replan shows what changed, why, and what needs the owner's approval.

Built by **Laal Kabutar** for Hackoween 2026. Every farm, farmer, reading and score in this repo is **synthetic demo data**.

![Architecture](docs/architecture.png)

## 🚀 Quick Start

```bash
npm install
npm run dev          # http://localhost:3000
```

No credentials are needed. Without Firebase config the app runs in **DEMO DATA** mode: the synthetic scenario is stored in your browser, and a gold `DEMO DATA` badge shows on every screen.

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build && npm start` | Production build |
| `npm test` | Domain tests (scenario consistency, replanning, risk, Rupee Score, intent, accounts) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |
| `npm run check` | All three |
| `npm run seed:firestore` | Seed Firestore + Auth with the demo scenario (needs a service account) |
| `npm run test:n8n` | Validate n8n webhook integration |

## 👥 Demo Accounts

Every seeded account has its own login ID and password, listed in [DEMO_CREDENTIALS.md](DEMO_CREDENTIALS.md).

- **Farmer Portal** (`/login`): 8 farmers. Ramesh Pawar (`URV-F-0001`, Hindi, tomato, Dindori) is the best one to demo.
- **Owner Portal** (`/login/owner`, linked under the farmer sign-in box): Anjali Deshpande (`URV-O-0001`). 6 farms in Nashik district.

**Tip:** Open the Owner Portal and the Farmer Portal in two tabs. Changes sync between tabs instantly.

---

## 🗺️ Judging Walkthrough (approx. 3 minutes)

1. **Owner → Overview.** Read *Needs your attention*, the weather outlook and the shared-machine board.
2. **Forecast flip (Journey B).** Click *Simulate rain*. Urvara checks every upcoming task against the new forecast and drafts a replan:
   - sprays and fertiliser move ahead of the storm;
   - drip irrigation moves after it;
   - wheat sowing in Sinnar stays put.
   The board shows ghost (current) and gold (proposed) slots. Click *Approve plan*.
3. **Machine breakdown (Journey C).** Click *Break the sprayer*. Boom sprayer S-1's bookings move to S-2 where it is free. The onion thrips spray can't be covered before its deadline, so it is flagged. Open that task and choose *Extend deadline 1 day and replan*.
4. **Farmer conversation and report (Journey A).** Sign in as Ramesh, tap **बोलें / Speak**, and talk to Urvara: speak, type, or tap a demo sample. Urvara replies aloud and the conversation continues. Say “टमाटर की पत्तियों पर पीले धब्बे हैं” and Urvara offers to send it to the owner; correct the details if needed and tap **मालिक को भेजें**. Back in **Owner → Crop Health**, the report is *unverified*, nearby fields are scored with reasons, and you can create a scouting task.
5. **Rupee Score (Journey D).** Go to **Owner → Performance & Rupee Score**, choose Tomato · Kharif 2026 → Sunita Jadhav. The breakdown shows the records behind each component. Excuse a late task with a note: the score is recomputed and a new version with the reason is added to the history.
6. **New farmer (Journey E).** Go to **Owner → Farmers → Add farmer**. Assign fields and copy the code, then sign in with it. The new farmer only sees their own fields. Assign them a task in Operations and complete it from the farmer side.
7. **Reset.** *Settings & demo → Reset demo scenario* replays the story from the start.

---

## 🤖 Technical Architecture & Integrations

### n8n Webhook Integration (Farm Events)
Urvara utilizes an n8n workflow to handle "Farm Events"—external triggers (like weather changes or machine failures) that require complex decision-making.

**The Pipeline:**
`Event Trigger` $\rightarrow$ `n8n Webhook` $\rightarrow$ `AI Decision Engine` $\rightarrow$ `Validation` $\rightarrow$ `Persistence (Data Table)` $\rightarrow$ `Response`

- **Endpoint:** `https://atharv2008.app.n8n.cloud/webhook/urvara-farm-event`
- **Logic:** Uses an AI-driven engine to evaluate the impact of the event on the current schedule.
- **Persistence:** Every valid decision is saved to the `n8n_data_table` for audit and approval tracking.
- **Testing:** Run `npm run test:n8n` to validate the contract against various scenarios (Heavy Rain, Heatwave, Resource Conflicts).

### Feature Status Matrix

| Area | Status | Note |
|---|---|---|
| Two portals, role-aware routing | Working | |
| Seeded scenario, reset, demo clock | Working | Fixed at Wed 28 Oct 2026, 08:00 IST |
| Weather-driven replanning | Working | Rules: wash-off, drift, runoff, waterlogging |
| Machine breakdown | Working | 1 h travel buffer between farms |
| Task create/assign | Working | Live constraint checks |
| Farmer accounts | Working | Salted SHA-256 (demo) / Firebase Auth (live) |
| Farmer voice report | Working | **Sarvam AI STT** (`saaras:v3`) |
| Spoken reply | Working | **Ollama Cloud** (`gemma4:31b`) $\rightarrow$ **Sarvam AI TTS** (`bulbul:v3`) |
| Intent extraction | Working | Rule-based + Farmer confirmation |
| Farmer Q&A | Working | Grounded in field/weather/task records |
| Crop-risk scouting | Working | Explainable rules (not diagnosis) |
| Rupee Score | Working | Crop-specific breakdown & history |
| Soil readings | Simulated | Moisture probe simulated; others manual |
| Weather | Seeded | Demo forecast; Live API adapter TBD |
| Firestore + Auth | Ready | Adapter & seed script written |

---

## ⚙️ Configuration

### Environment Variables
Copy `.env.example` to `.env.local`.

- **`NEXT_PUBLIC_FIREBASE_*`**: Firebase web config. Leave empty for **DEMO DATA** mode.
- **`NEXT_PUBLIC_URVARA_DATA_MODE=demo`**: Forces demo mode.
- **`FIREBASE_SERVICE_ACCOUNT_KEY`**: Server-only JSON for `/api/farmers` and seeding.
- **`SARVAM_API_KEY`**: Powers STT/TTS. Leave empty for browser speech recognition.
- **`OLLAMA_API_KEY`**: Powers the farmer assistant (`gemma4:31b`).

### Using Firebase
1. Create Firebase project $\rightarrow$ Enable Auth $\rightarrow$ Create Firestore.
2. Deploy rules: `npx firebase-tools deploy --only firestore:rules`.
3. Seed data: `FIREBASE_SERVICE_ACCOUNT_KEY="$(cat service-account.json)" npm run seed:firestore`.
4. Fill `NEXT_PUBLIC_FIREBASE_*` and restart.

---

## 📦 Project Layout

```
src/app/            routes: (auth)/login, (auth)/login/owner, owner/*, farmer/*, api/farmers
src/components/     ui/ primitives · owner/ · farmer/
src/services/       domain logic: scheduler, replanner, resources, risk, rupeeScore, intent, assistant, soil, alerts, analytics
src/repositories/   DataRepository: LocalDemoRepository, FirestoreRepository
src/data/           deterministic seed + crop metadata
src/lib/            firebase init, time (IST demo clock), credentials, i18n
tests/              node:test suites run with tsx
docs/               decisions.md, architecture.png
```

## 📜 License
MIT, see [LICENSE](LICENSE).
