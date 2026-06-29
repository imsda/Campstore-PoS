# Camp Store POS

Local-first point of sale web app for the Iowa-Missouri Conference camp store. The clerk workflow is optimized for fast camper lookup, cart entry, balance preview, checkout, local transaction logging, and queued Google Sheets sync.

## Features

- Clerk POS screen with searchable campers and items, touch-friendly cart, quantity controls, current balance, and new balance preview.
- Admin/backend control screen for status, settings, imports, sync, diagnostics, and recent transactions.
- SQLite live operational database with WAL enabled.
- Google Sheets import/sync:
  - `Items` tab: column A `Cost`, column B `Item Name`.
  - `Campers / Balances` tab: column A `Child Name`, column B `Initial Balance`, column C `Current Balance`.
  - `Logs` tab receives transaction append rows with timestamp, clerk, child, balances, total, purchased items, transaction ID, and status.
- Offline queue: sales update local balances immediately and remain pending until sync succeeds.
- Duplicate-resistant sync through generated transaction IDs.
- Backup/restore scripts and environment validation.

## Quick start

```bash
cp .env.example .env
npm install
npm run setup
npm start
```

Open `http://localhost:3077` for the clerk screen and `http://localhost:3077/admin.html` for admin.

## Google Sheets setup

1. Create a Google Cloud service account and enable the Google Sheets API.
2. Share the spreadsheet with the service account email as an editor.
3. Create three tabs named exactly:
   - `Items`
   - `Campers / Balances`
   - `Logs`
4. Fill row 1 headers and put data beginning on row 2.
5. Configure `.env`:

```bash
GOOGLE_SPREADSHEET_ID=your_sheet_id
GOOGLE_SERVICE_ACCOUNT_EMAIL=service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Run `npm run validate:env`, then use Admin → Refresh/import from Google Sheets.

## Deployment/update approach

This app is a single Node/Express service serving static frontend files and API endpoints. A typical internal deployment can run it with systemd, PM2, Docker, or another existing IMSDA host process manager.

Recommended update flow:

```bash
git pull
npm install --omit=dev
npm run setup
npm start
```

Set `APP_VERSION` in the environment during deployment if you want a release name; otherwise the app reports the current git commit when available.

## Backup and restore

```bash
npm run backup
npm run restore -- backups/campstore-YYYY-MM-DD.sqlite
```

Back up before imports, before updates, and at the end of store days.

## Offline operation

- Complete sales normally while offline.
- The local SQLite database is the source of truth during store operation.
- Transactions with `sync_status` other than `synced` are pending.
- When internet returns, use Admin → Push pending transactions.

## Sheet validation notes

The importer warns about duplicate child names and rejects invalid money values. Blank item/camper rows are skipped. Avoid renaming tabs or moving required columns.

## Troubleshooting

- `Google Sheets credentials are not configured`: check `.env` values and restart the service.
- Pending transactions remain after sync: inspect Admin status events and transaction errors.
- Incorrect camper balance in Sheets: local transactions are authoritative; run Push pending transactions, then verify the camper row in `Campers / Balances`.
- Import caution: importing does not intentionally overwrite local unsynced transaction logs. Perform pending sync before a new operating day import when possible.
