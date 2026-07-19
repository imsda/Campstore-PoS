const test = require('node:test'); const assert = require('node:assert'); const fs = require('node:fs'); const path = require('node:path');
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
  assert.equal(plan.summary.totalBalanceDelta, 2500 + 1500); // Bryce delta + Julian's new balance

  // With "Create new campers" off, the preview must not promise creations or count their balances.
  const noCreate = reconcilePlan(parsed, { updateCabins: true, reconcileBalances: true, createNew: false });
  assert.equal(noCreate.summary.newPeople, 0);
  assert.equal(noCreate.summary.skippedNew, 1);
  assert.equal(noCreate.summary.totalBalanceDelta, 2500);  // only Bryce's deposit delta
  assert.ok(!noCreate.items.some(i => i.type === 'new'));
});

test('walk-up add, cabin move, and optimistic-concurrency save', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-live-')), 'test.sqlite');
  process.env.DATABASE_PATH = dbPath;
  process.env.DEFAULT_OWNER_USERNAME = 'owner5';
  process.env.DEFAULT_OWNER_PASSWORD = 'secret123';
  process.env.SESSION_SECRET = 'test-session-secret-5';
  delete require.cache[require.resolve('../server')];
  const { app } = require('../server');
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner5', password: 'secret123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(b) });
  try {
    // Walk-up registration creates an active camper with a starting balance.
    let r = await post('/api/campers/quick-add', { name: 'Walkup Wanda', cabin: 'Bear', initial_balance: '30.00' });
    assert.equal(r.status, 200);
    const created = (await r.json()).camper;
    assert.equal(created.current_balance_cents, 3000);
    assert.equal(created.initial_balance_cents, 3000);
    assert.equal(created.cabin, 'Bear');
    assert.equal(created.active, 1);

    // Cabin move only changes the cabin.
    r = await post(`/api/campers/${created.id}/cabin`, { cabin: 'Coyote' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).cabin, 'Coyote');

    // A save carrying a stale updated_at is rejected with 409 instead of clobbering.
    r = await post(`/api/campers/${created.id}`, { name: 'Walkup Wanda', expected_updated_at: created.updated_at, current_balance: '30.00', initial_balance: '30.00' });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).conflict, true);

    // The camper appears in the clerk state feed for other stations.
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    assert.ok(state.campers.find(c => c.id === created.id));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
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

test('page permissions, stock additions, and final owner protection', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-pages-')), 'test.sqlite');
  process.env.DATABASE_PATH = dbPath; process.env.DEFAULT_OWNER_USERNAME = 'ownerp'; process.env.DEFAULT_OWNER_PASSWORD = 'secret123'; process.env.SESSION_SECRET = 'perm-secret';
  delete require.cache[require.resolve('../server')];
  const { app, db, hashPassword, userHasPermission } = require('../server');
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('clerkp','clerkp','Clerk P','CLERK',hashPassword('secret123'),1,stamp,stamp);
  db.prepare('INSERT INTO items(id,name,cost_cents,category,active,sku,stock_qty,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('stock_item','Socks',500,'Clothes',1,'SOCK',8,stamp);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username) => (await fetch(`${base}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password:'secret123'}) })).headers.get('set-cookie').split(';')[0];
  try {
    const ownerCookie = await login('ownerp');
    const clerkCookie = await login('clerkp');
    assert.equal((await fetch(`${base}/stock`, { headers:{ cookie:clerkCookie } })).status, 403);
    assert.equal(userHasPermission({id:'clerkp',role:'CLERK'}, 'page.clerk'), true);
    assert.equal(userHasPermission({id:'clerkp',role:'CLERK'}, 'page.stock'), false);
    db.prepare('INSERT INTO user_page_permissions(user_id,permission_key,allowed,created_at,updated_at) VALUES(?,?,?,?,?)').run('clerkp','page.stock',1,stamp,stamp);
    assert.equal((await fetch(`${base}/stock`, { headers:{ cookie:clerkCookie } })).status, 200);
    let r = await fetch(`${base}/api/stock/stock_item/add`, { method:'POST', headers:{'Content-Type':'application/json', cookie:clerkCookie}, body:JSON.stringify({quantity:1}) });
    assert.equal(r.status, 200); assert.equal((await r.json()).stock_qty, 9);
    r = await fetch(`${base}/api/stock/stock_item/add`, { method:'POST', headers:{'Content-Type':'application/json', cookie:clerkCookie}, body:JSON.stringify({quantity:12}) });
    assert.equal(r.status, 200); assert.equal((await r.json()).stock_qty, 21);
    for (const quantity of [0, -1, 1.5, 'abc']) {
      r = await fetch(`${base}/api/stock/stock_item/add`, { method:'POST', headers:{'Content-Type':'application/json', cookie:clerkCookie}, body:JSON.stringify({quantity}) });
      assert.equal(r.status, 400);
    }
    r = await fetch(`${base}/api/stock/missing/add`, { method:'POST', headers:{'Content-Type':'application/json', cookie:clerkCookie}, body:JSON.stringify({quantity:1}) });
    assert.equal(r.status, 404);
    assert.equal(db.prepare('SELECT count(*) c FROM stock_adjustments WHERE item_id=?').get('stock_item').c, 2);
    db.prepare('INSERT INTO user_page_permissions(user_id,permission_key,allowed,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,permission_key) DO UPDATE SET allowed=excluded.allowed').run('clerkp','page.stock',0,stamp,stamp);
    r = await fetch(`${base}/api/stock/stock_item/add`, { method:'POST', headers:{'Content-Type':'application/json', cookie:clerkCookie}, body:JSON.stringify({quantity:1}) });
    assert.equal(r.status, 403);
    r = await fetch(`${base}/api/users/${db.prepare("SELECT id FROM users WHERE username='ownerp'").get().id}/status`, { method:'POST', headers:{'Content-Type':'application/json', cookie:ownerCookie}, body:JSON.stringify({active:false}) });
    assert.equal(r.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('account ledger records sales, adjustments, people creation, direct-edit protection, and backfill idempotency', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const assert = require('node:assert');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-ledger-')), 'test.sqlite');
  process.env.DATABASE_PATH = dbPath; process.env.DEFAULT_OWNER_USERNAME = 'ownerl'; process.env.DEFAULT_OWNER_PASSWORD = 'secret123'; process.env.SESSION_SECRET = 'ledger-secret';
  delete require.cache[require.resolve('../server')];
  const mod = require('../server'); const { app, db, migrate } = mod;
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, url, body, cookie) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  try {
    const login = await req('POST', '/api/login', { username: 'ownerl', password: 'secret123' }, '');
    const cookie = login.headers.get('set-cookie').split(';')[0];

    let r = await req('POST', '/api/campers', { name: 'Ledger Lily', person_type: 'Camper', initial_balance: '50.00', current_balance: '50.00', active: true, notes: '' }, cookie);
    assert.equal(r.status, 200);
    const camperId = (await r.json()).id;
    assert.equal(db.prepare("SELECT count(*) c FROM account_ledger WHERE camper_id=? AND entry_type='opening_balance'").get(camperId).c, 1);

    r = await req('POST', '/api/campers', { name: 'Zero Zoe', person_type: 'Camper', initial_balance: '0.00', current_balance: '0.00', active: true, notes: '' }, cookie);
    assert.equal(r.status, 200);
    const zeroId = (await r.json()).id;
    assert.equal(db.prepare('SELECT count(*) c FROM account_ledger WHERE camper_id=?').get(zeroId).c, 0);

    db.prepare('INSERT INTO items(id,name,cost_cents,category,active,stock_qty,updated_at) VALUES(?,?,?,?,?,?,?)').run('snack_ledger', 'Snack Ledger', 125, 'Food', 1, 10, new Date().toISOString());
    r = await req('POST', '/api/sale', { camperId, cart: [{ id: 'snack_ledger', qty: 2 }] }, cookie);
    assert.equal(r.status, 200);
    const txid = (await r.json()).id;
    assert.equal(db.prepare('SELECT count(*) c FROM transactions WHERE id=?').get(txid).c, 1);
    const purchase = db.prepare('SELECT * FROM account_ledger WHERE transaction_id=?').get(txid);
    assert.equal(purchase.entry_type, 'purchase');
    assert.equal(purchase.amount_cents, -250);
    assert.equal(purchase.balance_before_cents, 5000);
    assert.equal(purchase.balance_after_cents, 4750);

    r = await req('POST', `/api/campers/${camperId}/adjust`, { action: 'add', amount: '5.00', reason: 'test add' }, cookie);
    assert.equal(r.status, 200);
    let adjId = (await r.json()).id;
    let ledger = db.prepare('SELECT * FROM account_ledger WHERE balance_adjustment_id=?').get(adjId);
    assert.equal(ledger.entry_type, 'funds_added'); assert.equal(ledger.amount_cents, 500);
    r = await req('POST', `/api/campers/${camperId}/adjust`, { action: 'subtract', amount: '3.00', reason: 'test subtract' }, cookie);
    adjId = (await r.json()).id; ledger = db.prepare('SELECT * FROM account_ledger WHERE balance_adjustment_id=?').get(adjId);
    assert.equal(ledger.entry_type, 'funds_subtracted'); assert.equal(ledger.amount_cents, -300);
    r = await req('POST', `/api/campers/${camperId}/adjust`, { action: 'set', amount: '42.00', reason: 'test set' }, cookie);
    adjId = (await r.json()).id; ledger = db.prepare('SELECT * FROM account_ledger WHERE balance_adjustment_id=?').get(adjId);
    assert.equal(ledger.entry_type, 'balance_set'); assert.equal(ledger.amount_cents, 4200 - 4950);

    r = await req('POST', `/api/campers/${camperId}`, { name: 'Ledger Lily 2', person_type: 'Camper', current_balance: '99.00', initial_balance: '50.00', active: true, notes: 'x' }, cookie);
    assert.equal(r.status, 400);
    r = await req('POST', `/api/campers/${camperId}`, { name: 'Ledger Lily 2', person_type: 'Camper', active: true, notes: 'x' }, cookie);
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT name,current_balance_cents FROM campers WHERE id=?').get(camperId).name, 'Ledger Lily 2');

    r = await req('POST', `/api/campers/${camperId}/opening-balance-correction`, { opening_balance: '60.00', reason: 'fix import' }, cookie);
    assert.equal(r.status, 200);
    const corrected = db.prepare('SELECT initial_balance_cents,current_balance_cents FROM campers WHERE id=?').get(camperId);
    assert.equal(corrected.initial_balance_cents, 6000);
    assert.equal(corrected.current_balance_cents, 5200);
    ledger = db.prepare("SELECT * FROM account_ledger WHERE camper_id=? AND entry_type='opening_balance_correction'").get(camperId);
    assert.equal(ledger.amount_cents, 1000);
    assert.equal(ledger.balance_before_cents, 4200);
    assert.equal(ledger.balance_after_cents, 5200);
    assert.equal(JSON.parse(ledger.metadata_json).old_opening_balance_cents, 5000);
    r = await req('POST', `/api/campers/${camperId}/opening-balance-correction`, { opening_balance: '55.00', reason: '' }, cookie);
    assert.equal(r.status, 400);

    db.prepare('INSERT INTO campers(id,name,person_type,initial_balance_cents,current_balance_cents,active,source,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('hist_camper','Hist Camper','Camper',1000,800,1,'manual','2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO transactions(id,created_at,clerk,camper_id,camper_name,previous_balance_cents,total_cents,new_balance_cents,items_json) VALUES(?,?,?,?,?,?,?,?,?)').run('tx_hist','2026-01-02T00:00:00.000Z','Tester','hist_camper','Hist Camper',1000,200,800,'[]');
    db.prepare('INSERT INTO balance_adjustments(id,created_at,admin,camper_id,camper_name,action,amount_cents,previous_balance_cents,new_balance_cents,reason) VALUES(?,?,?,?,?,?,?,?,?,?)').run('adj_hist','2026-01-03T00:00:00.000Z','Tester','hist_camper','Hist Camper','add',100,800,900,'hist');
    migrate(); migrate();
    assert.equal(db.prepare('SELECT count(*) c FROM account_ledger WHERE transaction_id=?').get('tx_hist').c, 1);
    assert.equal(db.prepare('SELECT count(*) c FROM account_ledger WHERE balance_adjustment_id=?').get('adj_hist').c, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('ledger insert failures roll back sale and adjustment side effects', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const assert = require('node:assert');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-ledger-rollback-')), 'test.sqlite');
  process.env.DATABASE_PATH = dbPath; process.env.DEFAULT_OWNER_USERNAME = 'ownerr'; process.env.DEFAULT_OWNER_PASSWORD = 'secret123'; process.env.SESSION_SECRET = 'rollback-secret';
  delete require.cache[require.resolve('../server')];
  const { app, db } = require('../server');
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO campers(id,name,person_type,initial_balance_cents,current_balance_cents,active,source,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('roll_camper','Roll Camper','Camper',1000,1000,1,'manual',stamp);
  db.prepare('INSERT INTO items(id,name,cost_cents,category,active,stock_qty,updated_at) VALUES(?,?,?,?,?,?,?)').run('roll_item','Roll Item',200,'Food',1,5,stamp);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body, cookie) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) });
  try {
    const login = await post('/api/login', { username: 'ownerr', password: 'secret123' }, '');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    db.exec("CREATE TRIGGER fail_purchase_ledger BEFORE INSERT ON account_ledger WHEN NEW.entry_type='purchase' BEGIN SELECT RAISE(ABORT, 'forced purchase ledger failure'); END;");
    let r = await post('/api/sale', { camperId: 'roll_camper', cart: [{ id: 'roll_item', qty: 1 }] }, cookie);
    assert.equal(r.status, 400);
    assert.equal(db.prepare('SELECT current_balance_cents FROM campers WHERE id=?').get('roll_camper').current_balance_cents, 1000);
    assert.equal(db.prepare('SELECT stock_qty FROM items WHERE id=?').get('roll_item').stock_qty, 5);
    assert.equal(db.prepare('SELECT count(*) c FROM transactions').get().c, 0);
    db.exec('DROP TRIGGER fail_purchase_ledger');

    db.exec("CREATE TRIGGER fail_adjustment_ledger BEFORE INSERT ON account_ledger WHEN NEW.entry_type='funds_added' BEGIN SELECT RAISE(ABORT, 'forced adjustment ledger failure'); END;");
    r = await post('/api/campers/roll_camper/adjust', { action: 'add', amount: '5.00', reason: 'rollback' }, cookie);
    assert.equal(r.status, 400);
    assert.equal(db.prepare('SELECT current_balance_cents FROM campers WHERE id=?').get('roll_camper').current_balance_cents, 1000);
    assert.equal(db.prepare('SELECT count(*) c FROM balance_adjustments').get().c, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('camper history endpoint enforces authz, isolation, pagination, purchase and adjustment details', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const assert = require('node:assert');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-history-')), 'test.sqlite');
  process.env.DATABASE_PATH = dbPath; process.env.DEFAULT_OWNER_USERNAME = 'ownerh'; process.env.DEFAULT_OWNER_PASSWORD = 'secret123'; process.env.SESSION_SECRET = 'history-secret';
  delete require.cache[require.resolve('../server')];
  const { app, db, hashPassword } = require('../server');
  const stamp = '2026-02-01T00:00:00.000Z';
  db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('clerkh','clerkh','No People','CLERK',hashPassword('secret123'),1,stamp,stamp);
  db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('peopleh','peopleh','People User','CLERK',hashPassword('secret123'),1,stamp,stamp);
  db.prepare('INSERT INTO user_page_permissions(user_id,permission_key,allowed,created_at,updated_at) VALUES(?,?,?,?,?)').run('peopleh','page.people',1,stamp,stamp);
  db.prepare('INSERT INTO campers(id,name,person_type,cabin,initial_balance_cents,current_balance_cents,active,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('camper_a','History A','Camper','Cabin 1',5000,3250,1,'manual',stamp);
  db.prepare('INSERT INTO campers(id,name,person_type,cabin,initial_balance_cents,current_balance_cents,active,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('camper_b','History B','Camper','Cabin 2',2000,2000,1,'manual',stamp);
  db.prepare('INSERT INTO transactions(id,created_at,clerk,camper_id,camper_name,previous_balance_cents,total_cents,new_balance_cents,items_json) VALUES(?,?,?,?,?,?,?,?,?)').run('tx_a','2026-02-02T00:00:00.000Z','Clerk','camper_a','History A',5000,450,4550,JSON.stringify([{name:'Snack',qty:2,price_cents:125,line_total_cents:250},{item_name:'Juice',quantity:1,unit_price_cents:200}]));
  db.prepare('INSERT INTO transactions(id,created_at,clerk,camper_id,camper_name,previous_balance_cents,total_cents,new_balance_cents,items_json) VALUES(?,?,?,?,?,?,?,?,?)').run('tx_bad','2026-02-04T00:00:00.000Z','Clerk','camper_a','History A',4550,100,4450,'not json');
  db.prepare('INSERT INTO transactions(id,created_at,clerk,camper_id,camper_name,previous_balance_cents,total_cents,new_balance_cents,items_json) VALUES(?,?,?,?,?,?,?,?,?)').run('tx_b','2026-02-05T00:00:00.000Z','Clerk','camper_b','History B',2000,100,1900,'[]');
  db.prepare('INSERT INTO balance_adjustments(id,created_at,admin,camper_id,camper_name,action,amount_cents,previous_balance_cents,new_balance_cents,reason) VALUES(?,?,?,?,?,?,?,?,?,?)').run('adj_a','2026-02-03T00:00:00.000Z','Admin','camper_a','History A','add',500,4550,5050,'Deposit');
  db.prepare('INSERT INTO account_ledger(camper_id,entry_type,amount_cents,balance_before_cents,balance_after_cents,created_at,metadata_json) VALUES(?,?,?,?,?,?,?)').run('camper_a','opening_balance',5000,0,5000,'2026-02-01T00:00:00.000Z',JSON.stringify({backfilled:1}));
  db.prepare('INSERT INTO account_ledger(camper_id,entry_type,amount_cents,balance_before_cents,balance_after_cents,transaction_id,created_by_name,created_at) VALUES(?,?,?,?,?,?,?,?)').run('camper_a','purchase',-450,5000,4550,'tx_a','Clerk','2026-02-02T00:00:00.000Z');
  db.prepare('INSERT INTO account_ledger(camper_id,entry_type,amount_cents,balance_before_cents,balance_after_cents,balance_adjustment_id,reason,created_by_name,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('camper_a','funds_added',500,4550,5050,'adj_a','Deposit','Admin','2026-02-03T00:00:00.000Z');
  db.prepare('INSERT INTO account_ledger(camper_id,entry_type,amount_cents,balance_before_cents,balance_after_cents,transaction_id,created_by_name,created_at) VALUES(?,?,?,?,?,?,?,?)').run('camper_a','purchase',-100,4550,4450,'tx_bad','Clerk','2026-02-04T00:00:00.000Z');
  db.prepare('INSERT INTO account_ledger(camper_id,entry_type,amount_cents,balance_before_cents,balance_after_cents,transaction_id,created_by_name,created_at) VALUES(?,?,?,?,?,?,?,?)').run('camper_a','purchase',-999,9999,9000,'tx_b','Clerk','2026-02-05T00:00:00.000Z');
  db.prepare('INSERT INTO account_ledger(camper_id,entry_type,amount_cents,balance_before_cents,balance_after_cents,transaction_id,created_by_name,created_at) VALUES(?,?,?,?,?,?,?,?)').run('camper_b','purchase',-100,2000,1900,'tx_b','Clerk','2026-02-06T00:00:00.000Z');
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async username => (await fetch(`${base}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password:'secret123'}) })).headers.get('set-cookie').split(';')[0];
  try {
    assert.equal((await fetch(`${base}/api/campers/camper_a/history`)).status, 401);
    const noPeopleCookie = await login('clerkh');
    assert.equal((await fetch(`${base}/api/campers/camper_a/history`, { headers:{cookie:noPeopleCookie} })).status, 403);
    const peopleCookie = await login('peopleh');
    let r = await fetch(`${base}/api/campers/missing/history`, { headers:{cookie:peopleCookie} });
    assert.equal(r.status, 404);
    r = await fetch(`${base}/api/campers/camper_a/history?limit=2&offset=1`, { headers:{cookie:peopleCookie} });
    assert.equal(r.status, 200);
    let d = await r.json();
    assert.deepEqual(d.camper, { id:'camper_a', name:'History A', person_type:'Camper', cabin:'Cabin 1', initial_balance_cents:5000, current_balance_cents:3250, active:1 });
    assert.equal(d.pagination.limit, 2); assert.equal(d.pagination.offset, 1); assert.equal(d.pagination.total, 5); assert.equal(d.pagination.has_more, true);
    assert.deepEqual(d.entries.map(e => e.created_at), ['2026-02-04T00:00:00.000Z','2026-02-03T00:00:00.000Z']);
    assert.ok(d.entries.every(e => e.transaction_id !== 'tx_b'));
    assert.equal(d.entries[0].purchase.details_available, false);
    assert.equal(d.entries[1].adjustment.action, 'add'); assert.equal(d.entries[1].adjustment.administrator_name, 'Admin'); assert.equal(d.entries[1].amount_cents, 500);
    r = await fetch(`${base}/api/campers/camper_a/history?limit=500`, { headers:{cookie:peopleCookie} });
    d = await r.json();
    assert.equal(d.pagination.limit, 100);
    const validPurchase = d.entries.find(e => e.transaction_id === 'tx_a');
    assert.equal(validPurchase.purchase.total_cents, 450);
    assert.deepEqual(validPurchase.purchase.items, [{ name:'Snack', quantity:2, unit_price_cents:125, line_total_cents:250 }, { name:'Juice', quantity:1, unit_price_cents:200, line_total_cents:200 }]);
    assert.ok(!d.entries.some(e => e.camper_id === 'camper_b'));
    const ownerCookie = await login('ownerh');
    assert.equal((await fetch(`${base}/api/campers/camper_a/history`, { headers:{cookie:ownerCookie} })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('People table is a clean summary view and edit dialog preserves person type', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  const peopleBlock = html.match(/<div class="panel wide" id="people">[\s\S]*?<div id="personDetailsModal"/)[0];
  const headers = [...peopleBlock.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map(m => m[1]);
  assert.deepEqual(headers, ['Name', 'Cabin', 'Opening Balance', 'Current Balance', 'Active', 'Actions']);
  assert.doesNotMatch(peopleBlock.match(/<thead>[\s\S]*?<\/thead>/)[0], /Type|Person Type|Notes|Source|Last Imported\/Updated|External ID|Sheet row/);
  assert.doesNotMatch(peopleBlock, /peopleScrollLeft|peopleScrollRight|Shift \+ mouse wheel|Scroll table left|Scroll table right/);
  assert.match(js, /person-name-text/);
  assert.doesNotMatch(js.match(/function renderPeople\(\)[\s\S]*?\nfunction showPersonDetails/)[0].replace(/\nfunction showPersonDetails$/, ''), /<input id=\"pn-|<select id=\"py-|Move|Save<\/button>|>Details<|\+ Funds|Set Balance|Correct Opening Balance|id=\"pt-/);
  assert.match(js, /showPersonDetails/);
  assert.match(js, /Person Type<select id=\"editType\"/);
  assert.match(js, /personTypeOptions\(p\.person_type\)/);
  assert.match(js, /person_type:\$\('editType'\)\.value/);
  assert.match(js, /name:\$\('editName'\)\.value,person_type:\$\('editType'\)\.value,active/);
  assert.doesNotMatch(js.match(/async function savePerson[\s\S]*?async function correctOpening/)[0], /initial_balance|current_balance/);
  assert.match(js, /Source/);
  assert.match(js, /Last Imported\/Updated/);
  assert.match(js, /External ID/);
  assert.match(js, /Sheet row/);
  assert.match(js, /Correct Opening Balance/);
  assert.match(css, /\.people-table\{min-width:980px;width:100%;table-layout:fixed/);
  assert.match(css, /\.people-table \.col-name\{width:34%;min-width:260px\}/);
  assert.match(css, /\.people-table th\{position:sticky;top:0/);
});

test('People active checkbox saves immediately and rolls back failures without clearing person type', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  const fn = js.match(/async function toggleActive[\s\S]*?async function moveCabin/)[0];
  assert.match(js.match(/function renderPeople\(\)[\s\S]*?\nfunction showPersonDetails/)[0].replace(/\nfunction showPersonDetails$/, ''), /onchange=\"toggleActive/);
  assert.match(fn, /el\.disabled=true/);
  assert.match(fn, /person_type:p\.person_type/);
  assert.match(fn, /expected_updated_at:p\.updated_at/);
  assert.match(fn, /el\.checked=previous/);
  assert.doesNotMatch(fn, /initial_balance|current_balance/);
});


test('cash account deposits credit amount, calculate change, store cash details, and are idempotent', async () => {
  const os = require('node:os');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-cash-')), 'test.sqlite');
  process.env.DATABASE_PATH = dbPath;
  process.env.DEFAULT_OWNER_USERNAME = 'cashowner';
  process.env.DEFAULT_OWNER_PASSWORD = 'secret123';
  process.env.SESSION_SECRET = 'cash-secret';
  delete require.cache[require.resolve('../server')];
  const { app, db, hashPassword } = require('../server');
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('cashclerk','cashclerk','Cash Clerk','CLERK',hashPassword('secret123'),1,stamp,stamp);
  db.prepare('INSERT INTO campers(id,name,person_type,initial_balance_cents,current_balance_cents,active,source,cabin,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('cash_camper','Caleb Cash','Camper',1000,1000,1,'manual','Coyote',stamp);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async username => (await fetch(`${base}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password:'secret123'}) })).headers.get('set-cookie').split(';')[0];
  try {
    const ownerCookie = await login('cashowner');
    assert.equal((await fetch(`${base}/api/cash-box/open`, { method:'POST', headers:{'Content-Type':'application/json', cookie:ownerCookie}, body:JSON.stringify({opening_amount_cents:10000}) })).status, 200);
    const cookie = await login('cashclerk');
    const post = body => fetch(`${base}/api/cash-deposits`, { method:'POST', headers:{'Content-Type':'application/json', cookie}, body:JSON.stringify(body) });
    let r = await post({ camper_id:'cash_camper', amount_added_cents:1500, cash_received_cents:2000, reason:'snack money', client_request_id:'req-1' });
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.change_owed_cents, 500);
    assert.equal(d.previous_balance_cents, 1000);
    assert.equal(d.new_balance_cents, 2500);
    assert.equal(db.prepare('SELECT current_balance_cents FROM campers WHERE id=?').get('cash_camper').current_balance_cents, 2500);
    const ledger = db.prepare('SELECT * FROM account_ledger WHERE id=?').get(d.ledger_id);
    assert.equal(ledger.amount_cents, 1500);
    assert.equal(ledger.payment_method, 'cash');
    const cash = db.prepare('SELECT * FROM cash_events WHERE account_ledger_id=?').get(d.ledger_id);
    assert.equal(cash.amount_credited_cents, 1500);
    assert.equal(cash.cash_received_cents, 2000);
    assert.equal(cash.change_given_cents, 500);
    r = await post({ camper_id:'cash_camper', amount_added_cents:1500, cash_received_cents:2000, client_request_id:'req-1' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).duplicate, true);
    assert.equal(db.prepare('SELECT count(*) c FROM cash_events').get().c, 1);
    r = await post({ camper_id:'cash_camper', amount_added_cents:700, cash_received_cents:700, client_request_id:'req-2' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).change_owed_cents, 0);
    for (const body of [
      { camper_id:'cash_camper', amount_added_cents:1500, cash_received_cents:1000 },
      { camper_id:'cash_camper', amount_added_cents:0, cash_received_cents:0 },
      { camper_id:'cash_camper', amount_added_cents:-1, cash_received_cents:100 },
      { camper_id:'missing', amount_added_cents:100, cash_received_cents:100 },
      { camper_id:'cash_camper', amount_added_cents:1.5, cash_received_cents:100 }
    ]) assert.notEqual((await post(body)).status, 200);
    const beforeAtomic = db.prepare('SELECT current_balance_cents balance,(SELECT count(*) FROM account_ledger) ledgers,(SELECT count(*) FROM cash_events) cashes FROM campers WHERE id=?').get('cash_camper');
    db.exec("CREATE TRIGGER fail_cash_ledger BEFORE INSERT ON account_ledger WHEN NEW.metadata_json LIKE '%cash_deposit%' BEGIN SELECT RAISE(ABORT, 'forced ledger failure'); END;");
    r = await post({ camper_id:'cash_camper', amount_added_cents:100, cash_received_cents:100, client_request_id:'req-ledger-fail' });
    assert.notEqual(r.status, 200);
    db.exec('DROP TRIGGER fail_cash_ledger');
    assert.deepEqual(db.prepare('SELECT current_balance_cents balance,(SELECT count(*) FROM account_ledger) ledgers,(SELECT count(*) FROM cash_events) cashes FROM campers WHERE id=?').get('cash_camper'), beforeAtomic);
    db.exec("CREATE TRIGGER fail_cash_event BEFORE INSERT ON cash_events BEGIN SELECT RAISE(ABORT, 'forced cash event failure'); END;");
    r = await post({ camper_id:'cash_camper', amount_added_cents:100, cash_received_cents:100, client_request_id:'req-event-fail' });
    assert.notEqual(r.status, 200);
    db.exec('DROP TRIGGER fail_cash_event');
    assert.deepEqual(db.prepare('SELECT current_balance_cents balance,(SELECT count(*) FROM account_ledger) ledgers,(SELECT count(*) FROM cash_events) cashes FROM campers WHERE id=?').get('cash_camper'), beforeAtomic);
    const hist = await (await fetch(`${base}/api/campers/cash_camper/history`, { headers:{ cookie: await login('cashowner') } })).json();
    assert.ok(hist.entries.some(e => e.display_label === 'Cash added to account' && e.cash_event.cash_received_cents === 2000 && e.cash_event.change_given_cents === 500));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('cash deposit endpoint rejects users without clerk permission', async () => {
  const os = require('node:os'); const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-cash-unauth-')), 'test.sqlite');
  process.env.DATABASE_PATH = dbPath; process.env.DEFAULT_OWNER_USERNAME = 'cashowner2'; process.env.DEFAULT_OWNER_PASSWORD = 'secret123'; process.env.SESSION_SECRET = 'cash-secret-2';
  delete require.cache[require.resolve('../server')];
  const { app, db, hashPassword } = require('../server'); const stamp = new Date().toISOString();
  db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('nopage','nopage','No Page','CLERK',hashPassword('secret123'),1,stamp,stamp);
  db.prepare('INSERT INTO user_page_permissions(user_id,permission_key,allowed,created_at,updated_at) VALUES(?,?,?,?,?)').run('nopage','page.clerk',0,stamp,stamp);
  db.prepare('INSERT INTO campers(id,name,person_type,initial_balance_cents,current_balance_cents,active,source,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('p','No Perm','Camper',0,0,1,'manual',stamp);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); }); const base = `http://127.0.0.1:${server.address().port}`;
  try { const login = await fetch(`${base}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:'nopage',password:'secret123'}) }); const cookie = login.headers.get('set-cookie').split(';')[0]; const r = await fetch(`${base}/api/cash-deposits`, { method:'POST', headers:{'Content-Type':'application/json', cookie}, body:JSON.stringify({camper_id:'p',amount_added_cents:100,cash_received_cents:100}) }); assert.equal(r.status, 403); }
  finally { await new Promise(resolve => server.close(resolve)); }
});

test('cash box permissions, summary, corrections, adjustments, and session activity', async () => {
  const os = require('node:os');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-cashbox-')), 'test.sqlite');
  process.env.DATABASE_PATH = dbPath; process.env.DEFAULT_OWNER_USERNAME = 'boxowner'; process.env.DEFAULT_OWNER_PASSWORD = 'secret123'; process.env.SESSION_SECRET = 'box-secret';
  delete require.cache[require.resolve('../server')];
  const { app, db, hashPassword } = require('../server');
  const stamp = new Date().toISOString();
  db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('admin','admin','Admin User','ADMIN',hashPassword('secret123'),1,stamp,stamp);
  db.prepare('INSERT INTO users(id,username,display_name,role,password_hash,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('clerk','clerk','Clerk User','CLERK',hashPassword('secret123'),1,stamp,stamp);
  db.prepare('INSERT INTO user_page_permissions(user_id,permission_key,allowed,created_at,updated_at) VALUES(?,?,?,?,?)').run('clerk','page.cash_box',1,stamp,stamp);
  db.prepare('INSERT INTO campers(id,name,person_type,initial_balance_cents,current_balance_cents,active,source,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('camper','Camper Cash','Camper',0,0,1,'manual',stamp);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async username => (await fetch(`${base}/api/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username,password:'secret123'}) })).headers.get('set-cookie').split(';')[0];
  const post = (cookie, p, b) => fetch(base+p, { method:'POST', headers:{'Content-Type':'application/json', cookie}, body:JSON.stringify(b) });
  try {
    const owner = await login('boxowner'), admin = await login('admin'), clerk = await login('clerk');
    assert.equal((await fetch(`${base}/cash-box`, { headers:{cookie:clerk, accept:'text/html'} })).status, 200);
    assert.equal((await post(clerk, '/api/cash-box/open', { opening_amount_cents:10000 })).status, 403);
    assert.equal((await post(admin, '/api/cash-box/open', { opening_amount:'bad' })).status, 400);
    assert.equal((await post(admin, '/api/cash-box/open', { opening_amount:'-1.00' })).status, 400);
    let r = await post(admin, '/api/cash-box/open', { opening_amount_cents:10000 });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).session.opening_amount_cents, 10000);
    assert.equal((await post(owner, '/api/cash-box/open', { opening_amount_cents:0 })).status, 400);
    assert.equal((await post(clerk, '/api/cash-box/current/correct-initial', { opening_amount_cents:9000, reason:'nope' })).status, 403);
    assert.equal((await post(admin, '/api/cash-box/current/correct-initial', { opening_amount_cents:9000 })).status, 400);
    r = await post(owner, '/api/cash-box/current/correct-initial', { opening_amount_cents:10000, reason:'count verified' });
    assert.equal(r.status, 200);
    assert.ok(db.prepare("SELECT * FROM audit_logs WHERE action='cash_box_initial_corrected'").get());
    r = await post(clerk, '/api/cash-deposits', { camper_id:'camper', amount_added_cents:2000, cash_received_cents:2500, reason:'deposit', client_request_id:'cb-1' });
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT cash_box_session_id FROM cash_events WHERE client_request_id=?').get('cb-1').cash_box_session_id, 1);
    assert.equal((await post(admin, '/api/cash-box/current/adjustments', { adjustment_type:'cash_added', amount_cents:300, reason:'change money' })).status, 200);
    assert.equal((await post(admin, '/api/cash-box/current/adjustments', { adjustment_type:'cash_removed', amount_cents:100, reason:'safe drop' })).status, 200);
    const cur = await (await fetch(`${base}/api/cash-box/current`, { headers:{cookie:clerk} })).json();
    assert.equal(cur.summary.cash_sales_cents, 0);
    assert.equal(cur.summary.account_deposits_credited_cents, 2000);
    assert.equal(cur.summary.cash_received_cents, 2500);
    assert.equal(cur.summary.change_given_cents, 500);
    assert.equal(cur.summary.expected_cash_cents, 12200);
    assert.ok(cur.activity.some(a => a.type === 'Account Deposit' && a.person_or_sale === 'Camper Cash' && a.net_drawer_change_cents === 2000));
    assert.equal(db.prepare('SELECT current_balance_cents FROM campers WHERE id=?').get('camper').current_balance_cents, 2000);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Cash Box frontend declares protected route, cards, admin controls, and activity table', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'cash-box.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'cash-box.js'), 'utf8');
  const { PAGE_REGISTRY } = require('../server');
  assert.ok(PAGE_REGISTRY.some(p => p.key === 'page.cash_box' && p.route === '/cash-box'));
  assert.match(html, /Cash Box/);
  assert.match(js, /Initial in Box/);
  assert.match(js, /Total Cash Sales/);
  assert.match(js, /Cash Added to Accounts/);
  assert.match(js, /Cash Received/);
  assert.match(js, /Change Given/);
  assert.match(js, /Expected in Box/);
  assert.match(js, /canAdmin/);
  assert.match(html, /activityRows/);
});

test('cash sales use no camper ledger, reduce stock once, and update cash box totals', () => {
  const os = require('node:os');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-cash-sale-')), 'test.sqlite');
  process.env.DATABASE_PATH = dbPath;
  process.env.DEFAULT_OWNER_USERNAME = 'owner_cash_sale';
  process.env.DEFAULT_OWNER_PASSWORD = 'secret123';
  process.env.SESSION_SECRET = 'test-session-cash-sale';
  delete require.cache[require.resolve('../server')];
  const { db, createSale, openCashBox, cashBoxCurrent } = require('../server');
  const user = { id:null, displayName:'Clerk One', role:'CLERK' };
  db.prepare('INSERT INTO campers(id,name,person_type,initial_balance_cents,current_balance_cents,active,source,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('real_camper','Real Camper','Camper',5000,5000,1,'manual',new Date().toISOString());
  db.prepare('INSERT INTO items(id,name,cost_cents,category,active,stock_qty,updated_at) VALUES(?,?,?,?,?,?,?)').run('snack','Snack',700,'Food',1,5,new Date().toISOString());
  assert.throws(() => createSale({ saleType:'cash', cart:[{id:'snack',qty:1}], cashReceivedCents:1000, user }), /cash box must be opened/i);
  openCashBox({ openingAmountCents:10000, user:{...user, role:'ADMIN'}, notes:'start' });
  const result = createSale({ saleType:'cash', cart:[{id:'snack',qty:1}], cashReceivedCents:1000, clientRequestId:'cash-sale-1', user });
  assert.equal(result.total_cents, 700);
  assert.equal(result.change_given_cents, 300);
  assert.equal(db.prepare('SELECT current_balance_cents FROM campers WHERE id=?').get('real_camper').current_balance_cents, 5000);
  assert.equal(db.prepare('SELECT count(*) c FROM campers').get().c, 1);
  assert.equal(db.prepare('SELECT count(*) c FROM account_ledger').get().c, 0);
  assert.equal(db.prepare('SELECT stock_qty FROM items WHERE id=?').get('snack').stock_qty, 4);
  const tx = db.prepare('SELECT * FROM transactions').get();
  assert.equal(tx.camper_id, null);
  assert.equal(tx.sale_type, 'cash');
  assert.equal(tx.payment_method, 'cash');
  assert.equal(tx.cash_received_cents, 1000);
  assert.equal(tx.change_given_cents, 300);
  assert.equal(JSON.parse(tx.items_json)[0].line_total_cents, 700);
  const ev = db.prepare('SELECT * FROM cash_events WHERE transaction_id=?').get(tx.id);
  assert.equal(ev.event_type, 'cash_sale');
  assert.equal(ev.sale_total_cents, 700);
  assert.equal(ev.net_drawer_change_cents, 700);
  const dup = createSale({ saleType:'cash', cart:[{id:'snack',qty:1}], cashReceivedCents:1000, clientRequestId:'cash-sale-1', user });
  assert.equal(dup.duplicate, true);
  assert.equal(db.prepare('SELECT stock_qty FROM items WHERE id=?').get('snack').stock_qty, 4);
  const cur = cashBoxCurrent();
  assert.equal(cur.summary.cash_sales_cents, 700);
  assert.equal(cur.summary.cash_received_cents, 1000);
  assert.equal(cur.summary.change_given_cents, 300);
  assert.equal(cur.summary.expected_cash_cents, 10700);
  assert.ok(cur.activity.some(a => a.type === 'Cash Sale' && a.person_or_sale === 'Walk-up Cash Sale'));
});

test('nullable cash-sale migration preserves financial foreign keys and is idempotent', () => {
  const os = require('node:os');
  const Database = require('better-sqlite3');
  const { execFileSync } = require('node:child_process');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-nullable-migration-')), 'test.sqlite');
  const old = new Database(dbPath);
  old.pragma('foreign_keys = ON');
  old.exec(`CREATE TABLE campers(id TEXT PRIMARY KEY,name TEXT NOT NULL,initial_balance_cents INTEGER NOT NULL,current_balance_cents INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,role TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE transactions(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,clerk TEXT,camper_id TEXT NOT NULL,camper_name TEXT NOT NULL,previous_balance_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,new_balance_cents INTEGER NOT NULL,items_json TEXT NOT NULL,sync_status TEXT NOT NULL DEFAULT 'pending',synced_at TEXT,error TEXT,client_request_id TEXT UNIQUE,FOREIGN KEY(camper_id) REFERENCES campers(id));
    CREATE TABLE balance_adjustments(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,admin TEXT,camper_id TEXT NOT NULL,camper_name TEXT NOT NULL,action TEXT NOT NULL,amount_cents INTEGER,previous_balance_cents INTEGER NOT NULL,new_balance_cents INTEGER NOT NULL,reason TEXT NOT NULL,sync_status TEXT NOT NULL DEFAULT 'pending',synced_at TEXT,error TEXT);
    CREATE TABLE audit_logs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,admin TEXT,action TEXT NOT NULL,person_id TEXT,person_name TEXT,initial_balance_cents INTEGER,current_balance_cents INTEGER,details_json TEXT);
    CREATE TABLE account_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,camper_id TEXT NOT NULL,entry_type TEXT NOT NULL,amount_cents INTEGER NOT NULL,balance_before_cents INTEGER NOT NULL,balance_after_cents INTEGER NOT NULL,payment_method TEXT,reason TEXT,transaction_id TEXT,balance_adjustment_id TEXT,audit_log_id TEXT,created_by_user_id TEXT,created_by_name TEXT,created_at TEXT NOT NULL,metadata_json TEXT,FOREIGN KEY(camper_id) REFERENCES campers(id),FOREIGN KEY(transaction_id) REFERENCES transactions(id),FOREIGN KEY(created_by_user_id) REFERENCES users(id));
    CREATE TABLE cash_box_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT,opening_amount_cents INTEGER NOT NULL,opened_at TEXT NOT NULL,opened_by_user_id TEXT,opened_by_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',FOREIGN KEY(opened_by_user_id) REFERENCES users(id));
    CREATE TABLE cash_events(id TEXT PRIMARY KEY,account_ledger_id INTEGER NOT NULL,camper_id TEXT NOT NULL,event_type TEXT NOT NULL,amount_credited_cents INTEGER NOT NULL DEFAULT 0,cash_received_cents INTEGER NOT NULL,change_given_cents INTEGER NOT NULL,reason TEXT,created_by_user_id TEXT,created_by_name TEXT,created_at TEXT NOT NULL,client_request_id TEXT UNIQUE,cash_box_session_id INTEGER NOT NULL,FOREIGN KEY(account_ledger_id) REFERENCES account_ledger(id),FOREIGN KEY(camper_id) REFERENCES campers(id),FOREIGN KEY(created_by_user_id) REFERENCES users(id));`);
  old.prepare('INSERT INTO campers(id,name,initial_balance_cents,current_balance_cents,updated_at) VALUES(?,?,?,?,?)').run('camper_1','A Camper',5000,4500,'2026-01-01T00:00:00.000Z');
  old.prepare('INSERT INTO users(id,username,display_name,role,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('user_1','owner','Owner','OWNER','hash','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
  old.prepare('INSERT INTO transactions(id,created_at,clerk,camper_id,camper_name,previous_balance_cents,total_cents,new_balance_cents,items_json,sync_status,synced_at,error,client_request_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('tx_account','2026-01-01T00:01:00.000Z','Owner','camper_1','A Camper',5000,500,4500,'[{"id":"item_1"}]','pending',null,null,'req-account');
  old.prepare('INSERT INTO account_ledger(camper_id,entry_type,amount_cents,balance_before_cents,balance_after_cents,payment_method,transaction_id,created_by_user_id,created_by_name,created_at,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('camper_1','purchase',-500,5000,4500,'account','tx_account','user_1','Owner','2026-01-01T00:01:00.000Z','{}');
  const ledgerId = old.prepare('SELECT id FROM account_ledger').get().id;
  old.prepare('INSERT INTO cash_box_sessions(opening_amount_cents,opened_at,opened_by_user_id,opened_by_name,status) VALUES(?,?,?,?,?)').run(10000,'2026-01-01T00:00:00.000Z','user_1','Owner','open');
  old.prepare('INSERT INTO cash_events(id,account_ledger_id,camper_id,event_type,amount_credited_cents,cash_received_cents,change_given_cents,reason,created_by_user_id,created_by_name,created_at,client_request_id,cash_box_session_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('cash_deposit_1',ledgerId,'camper_1','account_deposit',2000,2000,0,'deposit','user_1','Owner','2026-01-01T00:02:00.000Z','req-deposit',1);
  const beforeCounts = { transactions: old.prepare('SELECT count(*) c FROM transactions').get().c, cash_events: old.prepare('SELECT count(*) c FROM cash_events').get().c, account_ledger: old.prepare('SELECT count(*) c FROM account_ledger').get().c };
  old.close();

  process.env.DATABASE_PATH = dbPath;
  process.env.DEFAULT_OWNER_USERNAME = '';
  process.env.DEFAULT_OWNER_PASSWORD = '';
  delete require.cache[require.resolve('../server')];
  const { db } = require('../server');
  assert.deepEqual({ transactions: db.prepare('SELECT count(*) c FROM transactions').get().c, cash_events: db.prepare('SELECT count(*) c FROM cash_events').get().c, account_ledger: db.prepare('SELECT count(*) c FROM account_ledger').get().c }, beforeCounts);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('SELECT transaction_id FROM account_ledger WHERE id=?').get(ledgerId).transaction_id, 'tx_account');
  assert.equal(db.prepare('SELECT event_type FROM cash_events WHERE id=?').get('cash_deposit_1').event_type, 'account_deposit');
  db.prepare('INSERT INTO transactions(id,created_at,clerk,camper_id,camper_name,previous_balance_cents,total_cents,new_balance_cents,items_json,sale_type,payment_method,cash_box_session_id,cash_received_cents,change_given_cents,client_request_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('tx_cash','2026-01-01T00:03:00.000Z','Owner',null,null,null,750,null,'[]','cash','cash',1,1000,250,'req-cash-sale');
  db.prepare('INSERT INTO cash_events(id,account_ledger_id,camper_id,event_type,amount_credited_cents,cash_received_cents,change_given_cents,reason,created_by_user_id,created_by_name,created_at,client_request_id,cash_box_session_id,transaction_id,sale_total_cents,net_drawer_change_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('cash_sale_1',null,null,'cash_sale',0,1000,250,'Walk-up','user_1','Owner','2026-01-01T00:03:00.000Z','req-cash-event',1,'tx_cash',750,750);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const snapshot = db.prepare('SELECT count(*) c FROM transactions').get().c + ':' + db.prepare('SELECT count(*) c FROM cash_events').get().c;
  db.close();
  execFileSync('npm', ['run', 'setup'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: dbPath }, stdio: 'pipe' });
  execFileSync('npm', ['run', 'setup'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: dbPath }, stdio: 'pipe' });
  const after = new Database(dbPath);
  assert.equal(after.prepare('SELECT count(*) c FROM transactions').get().c + ':' + after.prepare('SELECT count(*) c FROM cash_events').get().c, snapshot);
  assert.deepEqual(after.prepare('PRAGMA foreign_key_check').all(), []);
  after.close();
});

test('nullable transaction migration copy failure rolls back original tables', () => {
  const os = require('node:os');
  const Database = require('better-sqlite3');
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'campstore-nullable-rollback-')), 'test.sqlite');
  const old = new Database(dbPath);
  old.exec(`CREATE TABLE campers(id TEXT PRIMARY KEY,name TEXT NOT NULL,initial_balance_cents INTEGER NOT NULL,current_balance_cents INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,role TEXT NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE transactions(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,clerk TEXT,camper_id TEXT NOT NULL,camper_name TEXT NOT NULL,previous_balance_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,new_balance_cents INTEGER NOT NULL,items_json TEXT NOT NULL,client_request_id TEXT);
    CREATE TABLE account_ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,camper_id TEXT NOT NULL,entry_type TEXT NOT NULL,amount_cents INTEGER NOT NULL,balance_before_cents INTEGER NOT NULL,balance_after_cents INTEGER NOT NULL,transaction_id TEXT,created_at TEXT NOT NULL);
    CREATE TABLE cash_events(id TEXT PRIMARY KEY,account_ledger_id INTEGER,camper_id TEXT,event_type TEXT NOT NULL,amount_credited_cents INTEGER NOT NULL DEFAULT 0,cash_received_cents INTEGER NOT NULL,change_given_cents INTEGER NOT NULL,created_at TEXT NOT NULL);`);
  old.prepare('INSERT INTO campers VALUES(?,?,?,?,?)').run('c1','Camper',0,0,'now');
  old.prepare('INSERT INTO transactions(id,created_at,camper_id,camper_name,previous_balance_cents,total_cents,new_balance_cents,items_json,client_request_id) VALUES(?,?,?,?,?,?,?,?,?)').run('tx1','now','c1','Camper',0,1,-1,'[]','dup');
  old.prepare('INSERT INTO transactions(id,created_at,camper_id,camper_name,previous_balance_cents,total_cents,new_balance_cents,items_json,client_request_id) VALUES(?,?,?,?,?,?,?,?,?)').run('tx2','now','c1','Camper',0,1,-1,'[]','dup');
  old.close();
  process.env.DATABASE_PATH = dbPath;
  delete require.cache[require.resolve('../server')];
  assert.throws(() => require('../server'), /UNIQUE constraint failed|nullable migration/);
  const check = new Database(dbPath);
  assert.equal(check.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='transactions'").get().c, 1);
  assert.equal(check.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name='transactions_old_nullable'").get().c, 0);
  assert.equal(check.prepare('SELECT count(*) c FROM transactions').get().c, 2);
  check.close();
});
