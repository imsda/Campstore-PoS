#!/usr/bin/env node
require('./env').loadEnv();
const { db } = require('../server');
const { randomUUID } = require('crypto');
const nanoid = () => randomUUID().replace(/-/g, '').slice(0, 21);
function cents(v){const s=String(v||'').replace(/[$,]/g,'').trim(); if(!s) throw Error('missing money value'); const n=Number(s); if(Number.isNaN(n)) throw Error('invalid money value '+v); return Math.round(n*100)}
const { now } = require('../datetime');
const name = process.argv[2];
const balance = process.argv[3];
const type = process.argv[4] || 'Camper';
if(!name || balance === undefined){
  console.error('Usage: npm run people:create -- "Test Camper" 25 [Camper|Staff|Other]');
  process.exit(1);
}
const personType = ['Camper','Staff','Other'].includes(type) ? type : 'Other';
const stamp = now();
const amount = cents(balance);
const id = 'manual_' + nanoid();
const run = db.transaction(() => {
  db.prepare('INSERT INTO campers(id,name,person_type,initial_balance_cents,current_balance_cents,sheet_row,active,notes,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, String(name).trim(), personType, amount, amount, null, 1, 'Seed/testing script', 'manual', stamp);
  db.prepare('INSERT INTO audit_logs(id,created_at,admin,action,person_id,person_name,initial_balance_cents,current_balance_cents,details_json) VALUES(?,?,?,?,?,?,?,?,?)').run('audit_'+nanoid(), stamp, 'people:create script', 'manual_person_create', id, String(name).trim(), amount, amount, JSON.stringify({type:personType,active:true,notes:'Seed/testing script'}));
});
run();
console.log(`Created ${name} (${personType}) with $${(amount/100).toFixed(2)} as ${id}`);
