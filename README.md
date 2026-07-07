# Korvix Signage

Cloud-managed digital signage for hospitality venues — pubs, clubs and hotels.
A single CMS controls every screen across every venue: dayparted menus and
promotions, live jackpot and POS data, fleet health monitoring, and one-click
emergency broadcast to every display.

Built to sit alongside Korvix connectivity as a recurring managed service:
one dashboard, many venues, players that keep running when the internet
doesn't.

## Quick start

Requires Node.js 22.5+ (uses the built-in SQLite driver). **No dependencies,
no build step.**

```bash
npm start          # or: node src/server.js
```

- Dashboard:    http://localhost:4700/admin/
- Player:       http://localhost:4700/player/
- Staff remote: http://localhost:4700/remote/ (via the tokenized link from Dashboard → Draws)

On first run an empty database is seeded with a full demo venue — **The
Korvix Tavern** — complete with zones (Entrance, Main Bar, Bistro, Gaming
Room, Sports Bar, Function Room), screens, content, dayparted schedules
(breakfast → lunch → happy hour → dinner → evening) and live data feeds.
Set `KORVIX_NO_DEMO=1` to start clean.

```bash
npm test           # end-to-end smoke tests (boots a real server)
```

### Try it in two browser tabs

1. Open the **player** in one tab — it shows a 6-character pairing code.
2. In the **dashboard** → Screens → pick a screen → *Pair device* → enter the
   code. The player flips to live content within a second.
3. Dashboard → Emergency → hit **EVACUATION** — every paired screen takes
   over instantly. Clear it and normal content resumes.

## How it works

```
┌─────────────┐   webhooks    ┌──────────────────┐    SSE + HTTPS    ┌──────────────┐
│ POS / gaming │ ────────────▶ │   Korvix CMS      │ ────────────────▶ │ Players       │
│ weather /    │               │  (this repo)      │   manifest pull   │ (any browser: │
│ sports feeds │               │  SQLite + Node    │ ◀──────────────── │  TV, Pi, box) │
└─────────────┘               └──────────────────┘    heartbeats      └──────────────┘
                                      ▲
                                      │ dashboard SPA
                                 venue managers / Korvix NOC
```

- **Manifest-driven players.** Each player periodically pulls a *manifest* —
  the single document describing what it should be doing right now (playlist,
  emergency state, live feed data). A Server-Sent Events channel nudges
  players to re-fetch the moment anything changes, so updates and emergency
  broadcasts land in under a second, while a missed event just degrades to
  the normal 60-second poll.
- **Offline resilience.** Players cache the last manifest in localStorage and
  media in the browser cache (uploads are served immutable), so screens keep
  playing through internet outages and reconnect automatically.
- **Scheduling (dayparting).** Schedules target a screen, a zone, or the whole
  venue — most specific wins, then priority, then latest start time. Windows
  can wrap past midnight (`21:00–02:00`). Times are evaluated in each venue's
  own timezone, so one CMS runs venues in Sydney and Perth correctly.
- **Health monitoring + offline alerts.** Players heartbeat every 30 s with
  what they're playing; a screen with no heartbeat for 90 s shows offline on
  the dashboard. Set `KORVIX_ALERT_WEBHOOK` and the CMS POSTs a JSON alert
  (with a Slack/Teams-compatible `text` field) once per outage, and again on
  recovery.
- **Proof of play.** Players log every item actually displayed; the Reports
  tab aggregates plays, minutes on screen and screens reached per content
  item and per screen for any date range, with CSV export — the evidence
  base for supplier campaigns and a cross-venue advertising network.
  Retention 90 days (`KORVIX_PLAYS_RETENTION_DAYS`).
- **Automatic weather.** Give a venue coordinates (Integrations tab) and the
  CMS refreshes its weather feed from Open-Meteo (free, no API key) every
  30 minutes.
- **Live preview.** Every paired screen has a 👁 Preview link in the dashboard
  that shows exactly what the screen is showing right now, without affecting
  its online status.
- **One-click backup.** Overview → *Download backup* streams a consistent
  SQLite snapshot of the whole CMS (`GET /api/backup`).
- **Raffle number draws.** Set up a draw with a ticket range (e.g. 1–200) and
  hit *Draw number*: targeted screens (whole venue or one zone) take over with
  a spinning number and reveal the winner. Draw again for "winner not
  present" — a number is never repeated within a draw. Clearing returns
  screens to scheduled content.
- **Staff remote app (`/remote/`).** An installable PWA so bar staff run
  draws from their phone with no dashboard access. From Dashboard → Draws,
  generate the staff link and send it to staff; opening it on Android
  (Chrome) or iPhone (Safari) offers *Add to Home Screen*, installing it as
  the **Korvix Draws** app — full-screen, own icon, no app store. It auths
  by a per-venue token; generating a new link instantly revokes every phone
  holding the old one.
- **Screen rotation.** Panels mounted sideways off a landscape-output player
  box are handled per screen: set 0/90/180/270° in the dashboard and the
  player rotates its whole output instantly.
- **Integrations.** External systems (BEPOZ/SwiftPOS/H&L, gaming controllers,
  weather, sports fixtures) POST JSON to per-venue webhook endpoints. Payloads
  are delivered to players inside the manifest, where *widgets* (jackpot
  display, specials board, weather panel, fixtures list) render them live.

## Content types

| Type     | What it is                                                        |
|----------|-------------------------------------------------------------------|
| `image`  | Full-screen image, by URL or uploaded file                         |
| `video`  | Full-screen muted video; advances when it ends                     |
| `url`    | Any live web page in a sandboxed iframe                            |
| `html`   | An inline HTML slide stored in the CMS (no assets needed)          |
| `widget` | Built-in live-data renderer: `jackpot`, `menu`, `weather`, `sports`, `birthdays`, `happyhour`, `welcome` |

## API sketch

All endpoints are JSON. Player and integration endpoints are open (players
authenticate by unguessable device key); set `KORVIX_ADMIN_TOKEN` to require
`Authorization: Bearer <token>` on everything else.

```
# Fleet
GET  /api/venues                          venues + zones + screen status
POST /api/venues                          { name, timezone, address }
POST /api/venues/:id/zones                { name }
POST /api/venues/:id/screens              { name, zone_id, orientation }
POST /api/screens/:id/pair                { pairing_code }  claim a player device
PATCH /api/screens/:id                    { name?, zone_id?, orientation?, rotation? (0|90|180|270) }
GET  /api/health/overview                 online/offline counts per venue
GET  /api/events                          activity log
GET  /api/venues/:id/reports/plays?from&to  proof-of-play report (per media + per screen)
GET  /api/backup                          download a SQLite snapshot (?token= allowed here)

# Content
POST /api/upload?name=promo.mp4           raw body upload -> { url }
POST /api/venues/:id/media                { name, type, src|content, duration_seconds }
POST /api/venues/:id/playlists            { name }
POST /api/playlists/:id/items             { media_id }
POST /api/venues/:id/schedules            { playlist_id, zone_id?, screen_id?,
                                            days_of_week, start_time, end_time, priority }

# Emergency broadcast
POST /api/emergencies                     { venue_id|null, level, title, message }
POST /api/emergencies/:id/clear

# Raffle number draws
POST /api/venues/:id/draws                { name, range_start, range_end, zone_id? }
POST /api/draws/:id/draw                  spin: picks an undrawn number, screens take over
POST /api/draws/:id/clear                 return screens to scheduled content
GET  /api/venues/:id/draws                draw history with drawn numbers

# Staff remote (phone app; token-authed, no admin login)
POST /api/venues/:id/remote-token         generate/rotate the staff link (rotation revokes old)
GET  /api/remote/:token                   venue, zones and draws for the app
POST /api/remote/:token/draws             create a draw from the phone
POST /api/remote/:token/draws/:id/draw    spin from the phone
POST /api/remote/:token/draws/:id/clear   clear screens from the phone

# Player protocol
POST /api/player/hello                    { device_key? } -> paired | pending+code
GET  /api/player/:key/manifest            everything the screen should show now
POST /api/player/:key/heartbeat           { player_info }
GET  /api/player/:key/events              SSE: refresh / paired / unpaired

# Integration webhooks (POS, gaming, weather, sports, membership, custom)
POST /api/integrations/:venueId/:source   arbitrary JSON payload -> live widgets
GET  /api/integrations/:venueId           current feeds
```

## Configuration

| Env var              | Default             | Purpose                              |
|----------------------|---------------------|--------------------------------------|
| `PORT`               | `4700`              | HTTP port                            |
| `HOST`               | `0.0.0.0`           | Bind address                         |
| `KORVIX_DATA_DIR`    | `./data`            | Database + uploaded media            |
| `KORVIX_ADMIN_TOKEN` | *(unset = open)*    | Bearer token for the admin API       |
| `KORVIX_NO_DEMO`     | *(unset)*           | `1` skips demo venue seeding         |
| `KORVIX_ALERT_WEBHOOK` | *(unset = off)*   | URL POSTed screen offline/recovery alerts (Slack/Teams/any JSON) |
| `KORVIX_OFFLINE_MS`  | `90000`             | Silence before a screen counts as offline |
| `KORVIX_PLAYS_RETENTION_DAYS` | `90`       | Proof-of-play retention              |

## Player hardware

Anything with a modern browser in kiosk mode: smart TV browsers, Raspberry Pi
(Chromium `--kiosk http://cms/player/`), Android boxes, Intel NUCs behind LED
walls. Portrait screens are supported per-screen via the orientation setting.

## Roadmap

- Multi-tenant auth (per-venue operator logins, Korvix NOC super-admin)
- Native BEPOZ/SwiftPOS pollers (today they push to the generic webhooks)
- Player packaging for Raspberry Pi / Android with watchdog + auto-update
- Screen layout zones (split-screen: menu + ticker + promo)
- Cross-venue advertising campaigns (one asset scheduled into many venues,
  consolidated proof-of-play invoice reports)
