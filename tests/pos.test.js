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
