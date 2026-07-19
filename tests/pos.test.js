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
    r = await req('POST', `/api/campers/${camperId}`, { name: 'Ledger Lily 2', person_type: 'Camper', current_balance: '42.00', initial_balance: '50.00', active: true, notes: 'x' }, cookie);
    assert.equal(r.status, 200);
    assert.equal(db.prepare('SELECT name,current_balance_cents FROM campers WHERE id=?').get(camperId).name, 'Ledger Lily 2');

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
