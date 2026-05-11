# BabyTrack

A full-featured newborn activity tracker PWA with sleep-window alerts, charts, CSV/JSON export, multi-baby support, and optional Supabase partner sync.

**No build step. No Node.js. Just static files on GitHub Pages.**

---

## Features

- **Activity logging**: Sleep (with location), feeding (breast L/R, bottle, solids), diapers, notes
- **Sleep-window tracking**: configurable wake windows by age, live countdown, overtired alerts
- **Dashboard**: awake timer with progress bar, recent activity strip
- **History**: filterable log list grouped by day, tap to edit/delete
- **Charts**: daily sleep totals and activity counts (7/14/30 day views)
- **CSV/JSON export**: one-tap download for Excel or full backup/restore
- **Multi-baby**: switch between babies, each with their own sleep guide
- **Partner sync** (optional): connect to a free Supabase project so two phones share the same logs
- **PWA**: installable on iPhone home screen, works offline

---

## Quick Start

### 1. Clone & deploy to GitHub Pages

```bash
git clone https://github.com/<your-username>/babytrack.git
cd babytrack
git push origin main
```

Then in your GitHub repo: **Settings → Pages → Source: Deploy from branch → main → /(root) → Save**.

Your app will be live at `https://<your-username>.github.io/babytrack/`.

### 2. Install on iPhone

1. Open the URL in **Safari** (not Chrome)
2. Tap the **Share** button (square with arrow)
3. Tap **Add to Home Screen**
4. Launch from the home screen icon

### 3. First use

1. The app will prompt you to add a baby (name + date of birth)
2. A default sleep guide (wake windows by age) is auto-created
3. Start logging! Tap the quick-add buttons on the dashboard

---

## Partner Sync (Optional)

To share logs between two phones:

### Set up Supabase (free tier, 5 minutes)

1. Go to [supabase.com](https://supabase.com) and create a free project
2. Open **SQL Editor** in the Supabase dashboard
3. Paste the contents of `supabase-schema.sql` and click **Run**
4. Go to **Settings → API** and copy:
   - **Project URL** (e.g. `https://xyz.supabase.co`)
   - **anon public key** (starts with `eyJ...`)

### Connect in BabyTrack

1. Open **Settings → Partner Sync**
2. Paste the URL and anon key
3. Click **Connect** — a Household ID is auto-generated
4. Share this Household ID with your partner
5. Your partner enters the same URL, key, and Household ID on their phone
6. Click **Sync Now** on both devices

Logs will sync on demand. Real-time sync happens automatically when both devices have the app open.

---

## File Structure

```
babytrack/
├── index.html              ← Entry point
├── app.js                  ← Full Preact app (all UI + logic)
├── styles.css              ← Tailwind + custom styles
├── manifest.webmanifest    ← PWA manifest
├── service-worker.js       ← Offline caching + notifications
├── supabase-schema.sql     ← Supabase DB setup (optional)
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI | Preact + HTM (via CDN, no build step) |
| Styling | Tailwind CSS (CDN) |
| Local DB | IndexedDB via Dexie.js |
| Charts | Chart.js |
| Sync | Supabase (optional) |
| Hosting | GitHub Pages (static, free) |

---

## Sleep Guide Defaults

| Age (weeks) | Wake window | Naps/day |
|---|---|---|
| 0–4 | 45 min | 4–6 |
| 4–8 | 75 min | 4–5 |
| 8–12 | 90 min | 3–4 |
| 12–16 | 105 min | 3–4 |
| 16–24 | 135 min | 2–3 |
| 24–36 | 150 min | 2–3 |
| 36–52 | 180 min | 1–2 |
| 52+ | 240 min | 1 |

Fully editable per baby in **Settings → Sleep Guide**.

---

## Data & Privacy

- All data lives in IndexedDB on your device by default
- No data leaves your phone unless you explicitly enable Supabase sync
- Export anytime as CSV (for Excel) or JSON (for backup/restore)
- If using Supabase, your data lives in your own Supabase project — you own it

---

## Known iOS Limitations

- **Background notifications**: iOS kills PWA service workers when the app is not in the foreground. The overtired alert works when the app is open. For background push, you'd need a server-side push notification service.
- **Storage eviction**: iOS may clear PWA data if the app hasn't been used in 7+ days. Installing to the home screen greatly reduces this risk. Export backups regularly.
- **Notification permission**: Must be requested from a user gesture (button tap) after the PWA is installed to the home screen.

---

## License

MIT — use it, modify it, share it.
