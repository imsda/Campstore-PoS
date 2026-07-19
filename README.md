# Camp Store POS

Local-first point of sale web app for the Iowa-Missouri Conference camp store. The clerk workflow is optimized for fast camper lookup, cart entry, balance preview, checkout, local transaction logging, and queued Google Sheets sync. Local SQLite is always the operational database: every sale is immediately saved locally, and Google Sheets availability does not block store operation.

## Features

- Login-first access pattern with signed HTTP-only session cookies.
- Local SQLite users with hashed passwords and roles: `OWNER`, `ADMIN`, and `CLERK`.
- Clerk POS screen with a **cabin group selector** (tap a cabin to see just the kids in it), searchable campers, searchable items, category browsing, touch-friendly cart, quantity controls, current balance, and new balance preview. Optimized for phones/tablets.
- **Roster & balance reconciliation** from UltraCamp exports (Cabin Assignments and Store Deposits) or any generic `Cabin, Child Name, Balance` CSV, with a preview-before-apply report.
- **CSV exports** for people/balances, transactions, balance adjustments, and inventory — straight from local SQLite, so they work offline.
- **Inventory management**: optional per-item stock counts that decrement on each sale, low/out-of-stock indicators, quick restock, and a dashboard alert.
- CafeScanner-style layout: light gray background, centered cards, compact top nav, and blue primary actions.
- Admin/backend control screen for dashboard stats, Google Sheets configuration, status, settings, imports, sync, diagnostics, recent transactions, and user management.
- SQLite live operational database with WAL enabled.
- Items are managed in-app from CSV uploads or manual Admin edits; local SQLite is the source of truth after import.
- Google Sheets import/sync for people/campers and balances:
  - `Campers / Balances` tab: column A `Child Name`, column B `Initial Balance`, column C `Current Balance`.
  - `Logs` tab receives transaction and balance-adjustment rows with timestamp, user, child, balances, totals/amounts, details, ID, and type.
- Pending Google Sync queue: every sale updates local SQLite balances immediately and is only queued while it waits to upload to Google Sheets.
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

People/campers can be managed directly in local SQLite and can also import from Google Sheets. Local SQLite is always the operational database during POS use. Every sale is immediately saved locally, so the application continues functioning normally if Google Sheets is unavailable. Pending Google Sync only refers to transactions and balance adjustments waiting to upload to Google Sheets; it does not mean a sale is incomplete locally. Unsynced local sales, balance adjustments, and manually-created people are not wiped by camper imports.

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
- **Push Pending Google Sync Transactions/Logs** appends unsynced local sales and balance adjustment logs to `Logs`, then updates camper current balances in `Campers / Balances`.
- **Sync Balances** runs the same Pending Google Sync operation for current balances and logs.

The dashboard shows Google Sheets status, last import time, last sync time, Pending Google Sync count, active people, active items, and daily sales metrics.

### Service account sharing instructions

1. In Google Cloud, create a service account and enable the Google Sheets API for the project.
2. Create/download a JSON key for the service account.
3. Open the Google Sheet, click **Share**, and share it with the service account `client_email` as **Editor**.
4. Paste or upload the full JSON into **Admin → Settings**.

## Cabins (Clerk POS)

Every person can have a **cabin**. On the Clerk POS screen, a row of cabin chips appears above the camper search. Tapping a cabin filters the list to just the kids in that cabin (with a count on each chip); "All cabins" clears the filter, and typing in the search box searches across everyone regardless of cabin. This makes finding a camper on a phone fast — pick the cabin, tap the name. Cabins are populated by the reconciliation import below, or edited per person in **Admin → People**. Admin → People also has a cabin filter and a cabin column.

## Roster & balance reconciliation

Use **Admin → Reconcile** to load a roster and reconcile balances from a CSV. The file is auto-detected and you always see a **preview report** (new campers, cabin changes, balance changes, unchanged, and the net balance delta) before anything is written. Nothing is applied until you press **Apply Reconciliation**.

Supported files:

- **UltraCamp "Cabin Assignments" export** — detected by `facilityName` + `nameFirst`/`nameLast`. Sets each camper's cabin from `facilityName` and creates any campers not already present (with a $0 starting balance). Campers are matched by `idPerson` (stored as an external ID) first, then by name, so re-imports and the deposits file line up exactly and duplicates are avoided.
- **UltraCamp "Store Deposits" export** — detected by `amount` + name columns. A camper can have several deposit rows; the importer **sums all deposits per person** to get the total funded amount, and also reads the cabin from `facilityName`. Reconciling in this mode sets the camper's **initial balance** to the deposit total and moves the **current balance by the same delta**, so mid-week top-ups are added on top of the local balance without erasing purchases already recorded in the POS.
- **Generic CSV** — any file with a name column plus optional `Cabin` and `Balance` columns (download the template from **Admin → Reconcile → Download Template**). In this mode the `Balance` column is treated as the camper's target **current** balance and set directly.

Apply options (all on by default): **Update cabins**, **Reconcile balances**, and **Create new campers**. Every balance change is written as an audited balance adjustment (admin, camper, previous/new balance, reason) and queued for Google Sync, exactly like a manual adjustment. The dashboard shows a **Last reconcile** time.

## CSV exports

**Admin → Export** downloads a current snapshot straight from local SQLite (works even when Google Sheets is offline):

- **People & Balances** — name, type, cabin, initial/current balance, source, external ID, active, notes.
- **Transactions** — every sale with itemized details and sync status.
- **Balance Adjustments** — the full adjustment/reconciliation audit trail.
- **Inventory** — items with cost, category, and stock.

## Inventory management

Items can optionally track stock. In **Admin → Items**, the **Stock** column shows each item's count; leave it blank to leave an item untracked. Stock is color-coded (green in stock, amber low, red out) using `LOW_STOCK_THRESHOLD` (default `5`). Every sale automatically decrements the stock of tracked items. Use the **Restock** button (or edit the Stock field and **Save**) to add/remove units, and check **Show low/out of stock only** to focus on what needs reordering. The dashboard shows a **Low / out of stock** alert tile, and stock never blocks a sale (offline-first: the POS always completes the sale and lets stock go negative if needed).

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
- Every sale is immediately saved to the local SQLite database.
- Transactions with `sync_status` other than `synced` are Pending Google Sync entries waiting to upload to Google Sheets.
- The application continues functioning normally when Google Sheets is unavailable; balances and checkout use local SQLite.
- When internet returns or Google Sheets is configured, use Admin → Push Pending Google Sync Transactions/Logs.

## Sheet validation notes

The people importer rejects duplicate child names and camper balance errors. The item CSV importer skips blank rows and reports missing Cost, invalid Cost, missing Item Name, missing Category, and duplicate item names within the same category. Avoid renaming Google people/log tabs or moving required people columns.

## Troubleshooting

- `Invalid username or password`: verify the user exists and is active in SQLite, or recreate an owner with the default owner environment variables on a fresh database.
- `Authentication required`: sign in again; sessions expire after 12 hours.
- `Google Sheets credentials are not configured`: open Admin → Configuration and save Spreadsheet ID, service account email, and private key; `.env` remains a fallback.
- Pending Google Sync transactions remain after sync: inspect Admin status events and transaction errors.
- Incorrect camper balance in Sheets: local transactions are authoritative; run Push Pending Google Sync transactions, then verify the camper row in `Campers / Balances`.
- Import caution: importing does not intentionally overwrite local unsynced transaction logs. Perform Pending Google Sync before a new operating day import when possible.

## Routed pages and page permissions

Campstore-PoS now uses real routes for each major page instead of dashboard hash-only tabs. Supported routes are:

- `/clerk` — cashier checkout page
- `/stock` — manual stock additions
- `/people` — people/camper management and reconciliation
- `/items` — item and inventory administration
- `/transactions` — transaction and balance-adjustment history
- `/sync` — Google import/sync controls
- `/users` — user management and page access
- `/settings` — Google Sheets and application settings
- `/admin` — operational dashboard/status

Unauthenticated users are redirected to login. Authenticated users are redirected from `/` to their first permitted page. A user with no permitted pages sees an access-denied page and can log out.

Page access is controlled by central permission keys: `page.clerk`, `page.stock`, `page.people`, `page.items`, `page.transactions`, `page.sync`, `page.users`, `page.settings`, and `page.admin`. Navigation only shows pages the signed-in user may access, and server-side middleware protects the page routes and related APIs so hidden links are not the security boundary.

Default role access is:

- `OWNER`: all pages, always. Owner page access cannot be overridden to lock an owner out.
- `ADMIN`: all pages by role default.
- `CLERK`: Clerk only by role default.

Owners and users with user-management page access can open `/users` to manage per-user page access. Each page permission can inherit the role default, be explicitly allowed, or be explicitly denied. Explicit user settings override role defaults except for `OWNER`, which always retains all pages. The app also prevents disabling the final active `OWNER` account.

## Stock page and audit trail

The `/stock` page lists item name, category, SKU, current stock, active/inactive status, and recent stock-update timing. It provides a prominent `+1` action and an `Add Custom` action. Custom stock additions must be positive whole numbers greater than zero. The page does not provide minus buttons, editable stock fields, or any way to set an absolute lower value.

The protected stock-add API is:

```http
POST /api/stock/:itemId/add
Content-Type: application/json

{ "quantity": 1 }
```

The endpoint requires authentication and `page.stock`, validates the item and quantity, rejects zero, negatives, decimals, and invalid strings, and atomically increments `stock_qty`. It never accepts a replacement total. Successful additions are written to `stock_adjustments` with a positive `quantity_change`, resulting quantity, `manual_add` adjustment type, default reason, authenticated user, and timestamp. Existing checkout behavior may still subtract stock when a sale is completed.

## Database migrations

`npm run setup` and application startup run idempotent SQLite migrations. New tables are created only if missing:

- `user_page_permissions` for per-user page access overrides
- `stock_adjustments` for manual stock-add audit records

Existing users, people/campers, items, stock values, and transactions are preserved. Existing users automatically receive effective permissions from their role defaults unless a custom page override is added.

## Deployment

The existing deployment flow remains unchanged and does not require a frontend build:

```bash
npm install
npm run setup
sudo systemctl restart campstore-pos
```

No new environment variables are required.
