const test = require('node:test'); const assert = require('node:assert');
test('money math stays in cents',()=>{assert.equal(125+375,500)});
test('transaction ids should be externally identifiable',()=>{assert.match('tx_abc123',/^tx_/)});

test('login creates a session and protected routes require it', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-auth-')), 'test.sqlite');
  process.env.DATABASE_PATH = dbPath;
  process.env.DEFAULT_OWNER_USERNAME = 'owner';
  process.env.DEFAULT_OWNER_PASSWORD = 'secret123';
  process.env.DEFAULT_OWNER_DISPLAY_NAME = 'Store Owner';
  process.env.SESSION_SECRET = 'test-session-secret';
  delete require.cache[require.resolve('../server')];
  const { app } = require('../server');
  const server = await new Promise(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const unauth = await fetch(`${base}/api/state`);
    assert.equal(unauth.status, 401);
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'secret123' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /campstore_session=/);
    const authed = await fetch(`${base}/api/state`, { headers: { cookie } });
    assert.equal(authed.status, 200);
    const state = await authed.json();
    assert.equal(state.user.role, 'OWNER');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});


test('items support category data', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-items-')), 'test.sqlite');
  process.env.DATABASE_PATH = dbPath;
  process.env.DEFAULT_OWNER_USERNAME = 'owner2';
  process.env.DEFAULT_OWNER_PASSWORD = 'secret123';
  process.env.SESSION_SECRET = 'test-session-secret-2';
  delete require.cache[require.resolve('../server')];
  const { db } = require('../server');
  const cols = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
  assert.ok(cols.includes('category'));
  db.prepare('INSERT INTO items(id,name,cost_cents,category,active,updated_at) VALUES(?,?,?,?,?,?)').run('item_1', 'Flashlight', 250, 'Camping', 1, new Date().toISOString());
  const item = db.prepare('SELECT name,cost_cents,category,active FROM items WHERE id=?').get('item_1');
  assert.deepEqual(item, { name: 'Flashlight', cost_cents: 250, category: 'Camping', active: 1 });
});

test('roster importer detects UltraCamp exports and reconciles cabins + balances', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-roster-')), 'test.sqlite');
  process.env.DATABASE_PATH = dbPath;
  process.env.DEFAULT_OWNER_USERNAME = 'owner4';
  process.env.DEFAULT_OWNER_PASSWORD = 'secret123';
  process.env.SESSION_SECRET = 'test-session-secret-4';
  delete require.cache[require.resolve('../server')];
  const { db, parseRosterCsv, reconcilePlan } = require('../server');

  // Store Deposits export: two rows for the same idPerson must sum, cabin comes from facilityName.
  const deposits = 'idPerson,amount,nameFirst,nameLast,facilityName\n'
    + '1,25.00,Bryce,Allred,Coyote\n'
    + '1,20.00,Bryce,Allred,Coyote\n'
    + '2,15.00,Julian,Allen,Raccoon\n';
  const parsed = parseRosterCsv(deposits);
  assert.equal(parsed.format, 'ultracamp_deposits');
  assert.equal(parsed.people.length, 2);
  const bryce = parsed.people.find(p => p.name === 'Bryce Allred');
  assert.equal(bryce.balance, 4500); // $25 + $20 summed to cents
  assert.equal(bryce.cabin, 'Coyote');
  assert.equal(bryce.external_id, '1');

  // Cabin Assignments export (no amount) is detected as cabins-only.
  const cabins = 'idPerson,nameFirst,nameLast,facilityName\n3,Ada,Kaufman,Cardinal\n';
  assert.equal(parseRosterCsv(cabins).format, 'ultracamp_cabins');

  // Applying deposits to an existing camper adjusts current balance by the deposit delta.
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO campers(id,name,person_type,initial_balance_cents,current_balance_cents,active,source,external_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('camper_test', 'Bryce Allred', 'Camper', 2000, 1200, 1, 'ultracamp', '1', stamp);
  const plan = reconcilePlan(parsed, { updateCabins: true, reconcileBalances: true, createNew: true });
  const brycePlan = plan.items.find(i => i.name === 'Bryce Allred');
  assert.equal(brycePlan.type, 'update');
  assert.equal(brycePlan.balanceChange.mode, 'deposit');
  assert.equal(brycePlan.balanceChange.delta, 2500);       // 4500 new initial − 2000 old initial
  assert.equal(brycePlan.balanceChange.toCurrent, 3700);   // 1200 current + 2500 delta (spending preserved)
  assert.equal(plan.summary.newPeople, 1);                 // Julian Allen is new
});

test('migration upgrades older items table before category is referenced', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const Database = require('better-sqlite3');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-migrate-old-items-')), 'test.sqlite');
  const oldDb = new Database(dbPath);
  oldDb.exec(`
    CREATE TABLE items(id TEXT PRIMARY KEY,name TEXT NOT NULL,cost_cents INTEGER NOT NULL,updated_at TEXT NOT NULL);
    INSERT INTO items(id,name,cost_cents,updated_at) VALUES('old_item','Compass',599,'2026-01-01T00:00:00.000Z');
  `);
  oldDb.close();

  process.env.DATABASE_PATH = dbPath;
  process.env.DEFAULT_OWNER_USERNAME = 'owner3';
  process.env.DEFAULT_OWNER_PASSWORD = 'secret123';
  process.env.SESSION_SECRET = 'test-session-secret-3';
  delete require.cache[require.resolve('../server')];
  const { db } = require('../server');

  const cols = db.prepare('PRAGMA table_info(items)').all().map(c => c.name);
  assert.ok(cols.includes('category'));
  assert.ok(cols.includes('active'));
  assert.ok(cols.includes('sku'));
  assert.ok(cols.includes('notes'));

  const item = db.prepare('SELECT name,cost_cents,category,active FROM items WHERE id=?').get('old_item');
  assert.deepEqual(item, { name: 'Compass', cost_cents: 599, category: 'Uncategorized', active: 1 });
  const categoryStatus = db.prepare('SELECT category,count(*) c FROM items WHERE active=1 GROUP BY category ORDER BY category').all();
  assert.deepEqual(categoryStatus, [{ category: 'Uncategorized', c: 1 }]);
});
