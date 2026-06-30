# Camp Store POS

Local-first point of sale web app for the Iowa-Missouri Conference camp store. The clerk workflow is optimized for fast camper lookup, cart entry, balance preview, checkout, local transaction logging, and queued Google Sheets sync.

## Features

- Login-first access pattern with signed HTTP-only session cookies.
- Local SQLite users with hashed passwords and roles: `OWNER`, `ADMIN`, and `CLERK`.
- Clerk POS screen with searchable campers, searchable items, category browsing, touch-friendly cart, quantity controls, current balance, and new balance preview.
- CafeScanner-style layout: light gray background, centered cards, compact top nav, and blue primary actions.
- Admin/backend control screen for dashboard stats, Google Sheets configuration, status, settings, imports, sync, diagnostics, recent transactions, and user management.
- SQLite live operational database with WAL enabled.
- Items are managed in-app from CSV uploads or manual Admin edits; local SQLite is the source of truth after import.
- Google Sheets import/sync for people/campers and balances:
  - `Campers / Balances` tab: column A `Child Name`, column B `Initial Balance`, column C `Current Balance`.
  - `Logs` tab receives transaction and balance-adjustment rows with timestamp, user, child, balances, totals/amounts, details, ID, and type.
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

## Items CSV workflow

Items are no longer imported from Google Sheets. Use **Admin → Items** to manage the item catalog. Clerks only see items marked active/enabled.

### CSV template

Download the template from **Admin → Items → Download CSV Template**. The template contains:

```csv
Cost,Item Name,Category,Active,SKU,Notes
1.50,Snack,Food,true,SNACK-001,Example item
```

Required columns:

- `Cost`
- `Item Name`
- `Category`

Optional columns:

- `Active`
- `SKU`
- `Notes`

### CSV import behavior

1. Open **Admin → Items**.
2. Paste a CSV into the import box or upload a `.csv` file.
3. Click **Preview CSV** to validate rows before applying.
4. Fix validation errors if reported.
5. Optionally check **Disable items not present in this CSV** when the CSV should be the full active catalog.
6. Click **Apply CSV Import**.

The importer skips blank rows, validates missing/invalid costs, missing item names, missing categories, and duplicate item names in the same category. Imports upsert by `Item Name + Category`; existing items are not deleted by default. The optional disable-missing checkbox hides omitted items without deleting historical transaction data.

Admins can also add items manually and edit item name, cost, category, active/enabled status, SKU, and notes from the Items table.

## People/Campers and Google Sheets workflow

People/campers can be managed directly in local SQLite and can also import from Google Sheets. Local SQLite remains the operational source during POS use. Unsynced local sales, balance adjustments, and manually-created people are not wiped by camper imports.

### Google Sheets setup from the Admin UI

Google Sheets can be configured after first setup without editing `.env`. Existing `.env` values are still used as fallback defaults until settings are saved in SQLite.

1. Sign in as an `OWNER` or `ADMIN`. `CLERK` users cannot open the admin configuration screen or call the settings/import/sync APIs.
2. Open **Admin → Settings**.
3. Paste the full **Google Sheet URL** from your browser address bar. A raw spreadsheet ID is also accepted.
4. Confirm or edit the tab names:
   - **Campers/Balances tab name** defaults to `Campers / Balances`.
   - **Logs tab name** defaults to `Logs`.
5. Paste or upload the full service account JSON key. The app auto-fills the service account email and private key from `client_email` and `private_key`.
6. Click **Save Google Settings**.
7. Click **Test Google Connection**. The test verifies that the spreadsheet opens, the configured Campers/Balances and Logs tabs exist, and the service account has edit access.

### Required People sheet columns

Create these tabs, or configure matching custom tab names in **Admin → Settings**:

- `Campers / Balances`
  - Column A: `Child Name`
  - Column B: `Initial Balance`
  - Column C: `Current Balance`
- `Logs`
  - Transaction and balance-adjustment logs are appended here during sync.

Rows begin on row 2. Blank rows are skipped. Duplicate camper names and invalid balances are reported as Admin UI errors.

### People management and audit behavior

Use **Admin → People** to search imported or manual people and view name, type (`Camper`, `Staff`, or `Other`), initial balance, current balance, source (`google` or `manual`), last imported/updated timestamp, active/enabled status, and notes. Admins can add a person without Google Sheets configured, edit manually-created and imported people, and disable a person without deleting them. Active people immediately appear in the Clerk POS search because both screens read from local SQLite.

To manually test a person from the UI:

1. Sign in as an `OWNER` or `ADMIN`.
2. Open **Admin → People**.
3. Fill in **Name**, **Type**, **Initial balance**, **Current balance**, **Active/enabled**, and optional **Notes**.
4. Click **Add Person**. The person is saved with `source: manual`, and a local audit log entry records timestamp, admin user, `manual_person_create`, name, initial balance, and current balance.
5. Open the Clerk page and search for the person by name. If active/enabled is checked, the person appears immediately.

For quick seed/testing from the command line, run:

```bash
npm run people:create -- "Test Camper" 25
```

An optional third argument sets the type (`Camper`, `Staff`, or `Other`):

```bash
npm run people:create -- "Test Staff" 10 Staff
```

Google imports upsert by case-insensitive name. Manual records use separate IDs and are not overwritten by unrelated Google rows; if a Google row intentionally matches a local person's name, the import updates that matching person and marks the source as `google`.

Manual balance changes must use the balance adjustment actions:

- **Add funds**
- **Subtract funds**
- **Set balance**

Each balance adjustment requires a reason and writes a local audit log entry with the admin, camper, action, previous balance, new balance, reason, and sync status.

### Import/sync workflow

Use **Admin → Import/Sync**:

- **Test Connection** validates credentials, configured tabs, and edit access.
- **Import People/Campers from Google Sheets** imports the configured Campers/Balances range `A2:C`.
- **Push Pending Transactions/Logs** appends unsynced local sales and balance adjustment logs to `Logs`, then updates camper current balances in `Campers / Balances`.
- **Sync Balances** runs the same pending sync operation for current balances and logs.

The dashboard shows Google Sheets status, last import time, last sync time, pending sync count, active people, active items, and daily sales metrics.

### Service account sharing instructions

1. In Google Cloud, create a service account and enable the Google Sheets API for the project.
2. Create/download a JSON key for the service account.
3. Open the Google Sheet, click **Share**, and share it with the service account `client_email` as **Editor**.
4. Paste or upload the full JSON into **Admin → Settings**.

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
- When internet returns, use Admin → Push Pending Transactions/Logs.

## Sheet validation notes

The people importer rejects duplicate child names and camper balance errors. The item CSV importer skips blank rows and reports missing Cost, invalid Cost, missing Item Name, missing Category, and duplicate item names within the same category. Avoid renaming Google people/log tabs or moving required people columns.

## Troubleshooting

- `Invalid username or password`: verify the user exists and is active in SQLite, or recreate an owner with the default owner environment variables on a fresh database.
- `Authentication required`: sign in again; sessions expire after 12 hours.
- `Google Sheets credentials are not configured`: open Admin → Configuration and save Spreadsheet ID, service account email, and private key; `.env` remains a fallback.
- Pending transactions remain after sync: inspect Admin status events and transaction errors.
- Incorrect camper balance in Sheets: local transactions are authoritative; run Push pending transactions, then verify the camper row in `Campers / Balances`.
- Import caution: importing does not intentionally overwrite local unsynced transaction logs. Perform pending sync before a new operating day import when possible.
