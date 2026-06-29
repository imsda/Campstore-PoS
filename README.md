# Camp Store POS

Local-first point of sale web app for the Iowa-Missouri Conference camp store. The clerk workflow is optimized for fast camper lookup, cart entry, balance preview, checkout, local transaction logging, and queued Google Sheets sync.

## Features

- Login-first access pattern with signed HTTP-only session cookies.
- Local SQLite users with hashed passwords and roles: `OWNER`, `ADMIN`, and `CLERK`.
- Clerk POS screen with searchable campers and items, touch-friendly cart, quantity controls, current balance, and new balance preview.
- CafeScanner-style layout: light gray background, centered cards, compact top nav, and blue primary actions.
- Admin/backend control screen for dashboard stats, status, settings, imports, sync, diagnostics, recent transactions, and user management.
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

Open `http://localhost:3077`. Unauthenticated users are sent to the login screen. After login, clerks go to the Clerk POS page and owners/admins can use `http://localhost:3077/admin.html`.

## Default owner setup

Set these environment variables before running `npm run setup` or starting the app for the first time:

```bash
DEFAULT_OWNER_USERNAME=admin
DEFAULT_OWNER_PASSWORD=change-me-now
DEFAULT_OWNER_DISPLAY_NAME=Administrator
SESSION_SECRET=change-me-to-a-long-random-secret
```

`npm run setup` initializes the SQLite database, applies migrations, creates the `users` table when needed, and seeds the default `OWNER` user from these values only when no users exist yet. Passwords are stored as salted `scrypt` hashes in SQLite, never as plain text. The setup output prints the seeded username, but never prints the password.

For first login, open `http://localhost:3077` after setup and sign in with `DEFAULT_OWNER_USERNAME` and `DEFAULT_OWNER_PASSWORD`. No manual SQL is required. After the first login, immediately change the default password or create named owner/admin/clerk users and stop using the bootstrap password.

## Roles and access

- `OWNER`: full access to Clerk POS, admin/backend controls, settings, import/sync, diagnostics, transactions, and user management.
- `ADMIN`: access to Clerk POS and admin/backend controls, including settings, import/sync, diagnostics, and transactions.
- `CLERK`: access only to the Clerk POS sale workflow.

All POS data API endpoints require a valid login. Admin APIs additionally require `OWNER` or `ADMIN`; user-management APIs require `OWNER`.

## Creating and changing users

### In the app

1. Sign in as an `OWNER`.
2. Open **Dashboard → User Management**.
3. Enter username, display name, role, and a temporary password.
4. Select **Create user**.

### From the command line

Run these commands from the application directory on the server. They use the configured `.env` database path and application password hashing, so no manual SQL is required.

```bash
npm run users:list
npm run users:create -- username password "Display Name" CLERK
npm run users:create -- admin1 temporary-password "Store Admin" ADMIN
npm run users:password -- username newPassword
```

Roles are `OWNER`, `ADMIN`, and `CLERK`; `users:create` defaults to `CLERK` when the role is omitted. Keep `SESSION_SECRET` stable across restarts so existing sessions remain valid; change it when you intentionally want to invalidate all sessions.

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

Recommended CafeScanner-style update flow:

```bash
git pull
npm install --omit=dev
npm run setup
sudo systemctl restart campstore-pos
```

The same flow is available as a script:

```bash
SERVICE_NAME=campstore-pos ./scripts/update-app.sh
# or, for non-systemd hosts:
RESTART_CMD="pm2 restart campstore-pos" ./scripts/update-app.sh
```

Deployment notes:

- Set `DEFAULT_OWNER_USERNAME`, `DEFAULT_OWNER_PASSWORD`, and `DEFAULT_OWNER_DISPLAY_NAME` before the first run.
- Set a strong `SESSION_SECRET` in production.
- Set `COOKIE_SECURE=true` when serving only over HTTPS.
- Keep the SQLite database and `backups/` directory on persistent storage.
- Set `APP_VERSION` in the environment during deployment if you want a release name; otherwise the app reports the current git commit when available.

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

- `Invalid username or password`: verify the user exists and is active in SQLite, or recreate an owner with the default owner environment variables on a fresh database.
- `Authentication required`: sign in again; sessions expire after 12 hours.
- `Google Sheets credentials are not configured`: check `.env` values and restart the service.
- Pending transactions remain after sync: inspect Admin status events and transaction errors.
- Incorrect camper balance in Sheets: local transactions are authoritative; run Push pending transactions, then verify the camper row in `Campers / Balances`.
- Import caution: importing does not intentionally overwrite local unsynced transaction logs. Perform pending sync before a new operating day import when possible.
