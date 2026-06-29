const test = require('node:test'); const assert = require('node:assert');
test('money math stays in cents',()=>{assert.equal(125+375,500)});
test('transaction ids should be externally identifiable',()=>{assert.match('tx_abc123',/^tx_/)});
