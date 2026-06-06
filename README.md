# Block Website — Chrome Extension

Block websites using wildcard hostname patterns (e.g. `*.google.*`), with daily cumulative emergency access and a scheduled auto-stop time.

## Features

- **Wildcard patterns** — `*` matches one dot-separated hostname segment (`*.google.*` blocks `mail.google.com`, etc.)
- **Emergency access** — Set minutes of allowed browsing per day before starting; time is cumulative across visits
- **Scheduled stop** — Pick a date/time when blocking automatically ends
- **Live edits** — Add or remove blocked patterns while a session is active

## Install (unpacked)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder (`blockwebsite`)

## Usage

1. Open the extension popup
2. Add patterns (e.g. `*.google.*`, `*.reddit.com`)
3. Set **emergency minutes per day** (locked once blocking starts)
4. Choose **stop blocking at** date/time
5. Click **Start blocking**

When you visit a blocked site, you’ll see a block page. Use **Emergency access** to browse for your remaining daily allowance.

## Permissions

- `declarativeNetRequest` — redirect blocked pages
- `storage` — save settings and daily emergency usage
- `alarms` — auto-stop and emergency timers
- `tabs` — emergency session tracking
