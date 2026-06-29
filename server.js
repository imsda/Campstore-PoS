try { require('dotenv').config(); } catch { require('./scripts/env').loadEnv(); }
const express = require('express');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const nanoid = () => randomUUID().replace(/-/g, '').slice(0, 21);
const APP_VERSION = process.env.APP_VERSION || readCommit() || 'dev';
const DB_PATH = process.env.DATABASE_PATH || './data/campstore.sqlite';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
migrate();
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
function readCommit(){try{return require('child_process').execSync('git rev-parse --short HEAD',{stdio:['ignore','pipe','ignore']}).toString().trim()}catch{return null}}
function migrate(){
 db.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,cost_cents INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS campers(id TEXT PRIMARY KEY,name TEXT NOT NULL,initial_balance_cents INTEGER NOT NULL,current_balance_cents INTEGER NOT NULL,sheet_row INTEGER,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_campers_name ON campers(name);
 CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,clerk TEXT,camper_id TEXT NOT NULL,camper_name TEXT NOT NULL,previous_balance_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,new_balance_cents INTEGER NOT NULL,items_json TEXT NOT NULL,sync_status TEXT NOT NULL DEFAULT 'pending',synced_at TEXT,error TEXT,FOREIGN KEY(camper_id) REFERENCES campers(id));
 CREATE TABLE IF NOT EXISTS sync_events(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,type TEXT NOT NULL,status TEXT NOT NULL,message TEXT);`);
 setDefault('allow_over_balance', String(process.env.ALLOW_OVER_BALANCE === 'true'));
}
function setDefault(k,v){db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k,v)}
function cents(v){ if (typeof v === 'number') return Math.round(v*100); const s=String(v||'').replace(/[$,]/g,'').trim(); if(!s) throw Error('missing money value'); const n=Number(s); if(Number.isNaN(n)) throw Error('invalid money value '+v); return Math.round(n*100)}
function money(c){return (c/100).toFixed(2)}
function now(){return new Date().toISOString()}
function sheetsClient(){
 const email=process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key=(process.env.GOOGLE_PRIVATE_KEY||'').replace(/\\n/g,'\n');
 if(!process.env.GOOGLE_SPREADSHEET_ID || !email || !key) throw Error('Google Sheets credentials are not configured');
 const auth = new google.auth.JWT(email, null, key, ['https://www.googleapis.com/auth/spreadsheets']);
 return google.sheets({version:'v4', auth});
}
function event(type,status,message){db.prepare('INSERT INTO sync_events(created_at,type,status,message) VALUES(?,?,?,?)').run(now(),type,status,message||'')}
app.get('/api/state',(req,res)=>{res.json({items:db.prepare('SELECT * FROM items WHERE active=1 ORDER BY name').all(),campers:db.prepare('SELECT * FROM campers ORDER BY name').all(),settings:Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r=>[r.key,r.value])),pending:db.prepare("SELECT count(*) c FROM transactions WHERE sync_status!='synced'").get().c,version:APP_VERSION})});
app.get('/api/transactions',(req,res)=>res.json(db.prepare('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 200').all().map(t=>({...t,items:JSON.parse(t.items_json)}))));
app.post('/api/settings',(req,res)=>{for(const [k,v] of Object.entries(req.body||{})) db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v)); res.json({ok:true})});
app.post('/api/sale',(req,res)=>{const {camperId, cart, clerk, allowOverride}=req.body; const camper=db.prepare('SELECT * FROM campers WHERE id=?').get(camperId); if(!camper) return res.status(404).json({error:'Camper not found'}); if(!Array.isArray(cart)||!cart.length) return res.status(400).json({error:'Cart is empty'}); const items=cart.map(ci=>{const item=db.prepare('SELECT * FROM items WHERE id=? AND active=1').get(ci.id); if(!item) throw Error('Item not found'); const qty=Math.max(1,Number(ci.qty)||1); return {id:item.id,name:item.name,price_cents:item.cost_cents,qty,line_total_cents:item.cost_cents*qty}}); const total=items.reduce((a,i)=>a+i.line_total_cents,0); const allow=db.prepare("SELECT value FROM settings WHERE key='allow_over_balance'").get()?.value==='true'; if(camper.current_balance_cents-total<0 && !allow && !allowOverride) return res.status(409).json({error:'Purchase exceeds current balance'}); const txid='tx_'+nanoid(); const created=now(); const run=db.transaction(()=>{db.prepare('UPDATE campers SET current_balance_cents=?,updated_at=? WHERE id=?').run(camper.current_balance_cents-total,created,camper.id); db.prepare('INSERT INTO transactions(id,created_at,clerk,camper_id,camper_name,previous_balance_cents,total_cents,new_balance_cents,items_json) VALUES(?,?,?,?,?,?,?,?,?)').run(txid,created,clerk||process.env.CLERK_NAME||'',camper.id,camper.name,camper.current_balance_cents,total,camper.current_balance_cents-total,JSON.stringify(items));}); run(); res.json({ok:true,id:txid,camperId:camper.id,new_balance_cents:camper.current_balance_cents-total})});
app.post('/api/import',async(req,res)=>{try{const sheets=sheetsClient(), id=process.env.GOOGLE_SPREADSHEET_ID; const r=await sheets.spreadsheets.values.batchGet({spreadsheetId:id,ranges:['Items!A2:B','Campers / Balances!A2:C']}); const [itemRows=[],camperRows=[]]=r.data.valueRanges.map(v=>v.values||[]); const seen=new Set(), warnings=[]; const stamp=now(); const run=db.transaction(()=>{for(const row of itemRows){if(!row[0]&&!row[1]) continue; if(!row[1]){warnings.push('Item row missing name'); continue} const name=String(row[1]).trim(); db.prepare('INSERT INTO items(id,name,cost_cents,active,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET cost_cents=excluded.cost_cents,active=1,updated_at=excluded.updated_at').run('item_'+nanoid(),name,cents(row[0]),1,stamp)} camperRows.forEach((row,i)=>{if(!row[0]) return; const name=String(row[0]).trim(); if(seen.has(name.toLowerCase())) warnings.push('Duplicate child name: '+name); seen.add(name.toLowerCase()); db.prepare('INSERT INTO campers(id,name,initial_balance_cents,current_balance_cents,sheet_row,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at').run('camper_'+Buffer.from(name.toLowerCase()).toString('hex').slice(0,32),name,cents(row[1]),cents(row[2]),i+2,stamp)}); setDefault('last_import',stamp)}); run(); event('import','ok',`Imported ${itemRows.length} item rows and ${camperRows.length} camper rows`); res.json({ok:true,warnings})}catch(e){event('import','error',e.message); res.status(500).json({error:e.message})}});
app.post('/api/sync',async(req,res)=>{try{const sheets=sheetsClient(), id=process.env.GOOGLE_SPREADSHEET_ID; const pending=db.prepare("SELECT * FROM transactions WHERE sync_status!='synced' ORDER BY created_at").all(); for(const t of pending){await sheets.spreadsheets.values.append({spreadsheetId:id,range:'Logs!A:I',valueInputOption:'USER_ENTERED',requestBody:{values:[[t.created_at,t.clerk,t.camper_name,money(t.previous_balance_cents),money(t.total_cents),money(t.new_balance_cents),JSON.parse(t.items_json).map(i=>`${i.qty}x ${i.name} @ $${money(i.price_cents)}`).join('; '),t.id,'synced']]}}); const camper=db.prepare('SELECT sheet_row FROM campers WHERE id=?').get(t.camper_id); if(camper?.sheet_row) await sheets.spreadsheets.values.update({spreadsheetId:id,range:`Campers / Balances!C${camper.sheet_row}`,valueInputOption:'USER_ENTERED',requestBody:{values:[[money(t.new_balance_cents)]]}}); db.prepare("UPDATE transactions SET sync_status='synced',synced_at=?,error=NULL WHERE id=?").run(now(),t.id)} setDefault('last_sync',now()); event('sync','ok',`Synced ${pending.length} transactions`); res.json({ok:true,synced:pending.length})}catch(e){event('sync','error',e.message); db.prepare("UPDATE transactions SET sync_status='error',error=? WHERE sync_status!='synced'").run(e.message); res.status(500).json({error:e.message})}});
app.get('/api/status',async(req,res)=>{let googleStatus='not configured'; try{sheetsClient(); googleStatus='configured'}catch(e){googleStatus=e.message} res.json({database:{path:DB_PATH,ok:true},googleStatus,lastImport:db.prepare("SELECT value FROM settings WHERE key='last_import'").get()?.value||null,lastSync:db.prepare("SELECT value FROM settings WHERE key='last_sync'").get()?.value||null,pending:db.prepare("SELECT count(*) c FROM transactions WHERE sync_status!='synced'").get().c,version:APP_VERSION,events:db.prepare('SELECT * FROM sync_events ORDER BY id DESC LIMIT 30').all()})});
app.listen(process.env.PORT||3077,()=>console.log(`Camp Store POS running on ${process.env.PORT||3077}`));
