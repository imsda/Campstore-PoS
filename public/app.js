let state = {}, selected = null, cart = [], selectedCategory = null, saleCamperId = null, selectedCabin = null;
const $ = id => document.getElementById(id), fmt = c => '$' + (c / 100).toFixed(2);

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login.html';
}

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function toast(type, title, lines = []) {
  const host = $('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const body = Array.isArray(lines) ? lines : [lines];
  el.innerHTML = `<div class="toast-title">${esc(title)}</div>${body.filter(Boolean).map(l => `<div>${esc(l)}</div>`).join('')}`;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, 2000);
}

function renderNav(pages) {
  const nav = $('nav'); if (!nav || nav.dataset.ready) return; nav.dataset.ready = '1';
  nav.innerHTML = pages.map(p => `<a class="${location.pathname===p.route?'active':''}" href="${p.route}">${esc(p.label)}</a>`).join('') + nav.innerHTML;
}

function resetSaleWorkflow() {
  cart = [];
  selected = null;
  saleCamperId = null;
  selectedCategory = null;
  $('camperSearch').value = '';
  $('itemSearch').value = '';
  $('selected').className = 'balance-card muted';
  $('selected').textContent = 'No camper selected';
  renderCabins();
  renderCampers();
  renderItems();
  renderCart();
  $('camperSearch').focus();
}

async function load() {
  const r = await fetch('/api/state');
  if (r.status === 401) {
    location.href = '/login.html';
    return;
  }
  state = await r.json();
  $('sync').textContent = `Pending Google Sync: ${state.pendingGoogleSync ?? state.pending} Transactions`;
  $('userBadge').textContent = `${state.user.displayName} · ${state.user.role}`;
  if (state.allowedPages) renderNav(state.allowedPages);
  if (selected) selected = state.campers.find(c => c.id === selected.id) || selected;
  renderCabins();
  renderCampers();
  renderItems();
  renderCart();
  renderSelected();
  renderRecentCash();
}

function cabinList() {
  const map = new Map();
  for (const c of state.campers) {
    const cab = (c.cabin || '').trim();
    if (!cab) { map.set('__none', (map.get('__none') || 0) + 1); continue; }
    map.set(cab, (map.get(cab) || 0) + 1);
  }
  const named = [...map.entries()].filter(([k]) => k !== '__none').sort((a, b) => a[0].localeCompare(b[0]));
  if (map.has('__none')) named.push(['__none', map.get('__none')]);
  return named;
}

function renderCabinOptions() {
  const dl = $('cabinOptions');
  if (!dl) return;
  const names = [...new Set(state.campers.map(c => (c.cabin || '').trim()).filter(Boolean))].sort();
  dl.innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
}

// encodeURIComponent leaves ' untouched, which would terminate the single-quoted
// inline handler string; %27 round-trips through decodeURIComponent.
function uriArg(s) { return encodeURIComponent(s).replace(/'/g, '%27'); }

function renderCabins() {
  renderCabinOptions();
  const host = $('cabinBar');
  if (!host) return;
  const cabins = cabinList();
  if (!cabins.length || (cabins.length === 1 && cabins[0][0] === '__none')) { host.innerHTML = ''; host.style.display = 'none'; return; }
  host.style.display = 'flex';
  const chip = (key, label, count, active) => `<button class="cabin-chip ${active ? 'active' : ''}" onclick="selectCabin(${key === null ? 'null' : `'${uriArg(key)}'`})">${esc(label)}${count != null ? `<span class="cabin-count">${count}</span>` : ''}</button>`;
  host.innerHTML = chip(null, 'All cabins', state.campers.length, !selectedCabin) +
    cabins.map(([k, n]) => chip(k, k === '__none' ? 'No cabin' : k, n, selectedCabin === k)).join('');
}

function selectCabin(key) {
  selectedCabin = key === null ? null : decodeURIComponent(key);
  $('camperSearch').value = '';
  renderCabins();
  renderCampers();
}

function renderCampers() {
  const q = $('camperSearch').value.toLowerCase().trim();
  let list = state.campers;
  if (selectedCabin && !q) list = list.filter(c => (selectedCabin === '__none' ? !(c.cabin || '').trim() : (c.cabin || '').trim() === selectedCabin));
  if (q) list = list.filter(c => c.name.toLowerCase().includes(q));
  $('campers').innerHTML = list
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 60)
    .map(c => `<div class="row ${selected?.id === c.id ? 'selected' : ''} ${saleCamperId && saleCamperId !== c.id ? 'locked-choice' : ''}" onclick="selectCamper('${c.id}')"><b>${esc(c.name)}</b>${c.cabin ? `<span class="cabin-tag">${esc(c.cabin)}</span>` : ''}<br><span class="muted">Current: ${fmt(c.current_balance_cents)}</span></div>`)
    .join('') || '<p class="muted">No campers match. Try a different cabin or search.</p>';
}

function renderSelected() {
  if (!selected) return;
  const locked = cart.length > 0;
  $('selected').className = `balance-card ${locked ? 'sale-locked' : ''}`;
  $('selected').innerHTML = `<div class="selected-head"><h3>${esc(selected.name)}</h3>${locked ? '<span class="lock-pill">🔒 Sale in Progress</span>' : ''}</div><p class="muted">Current balance</p><div class="amount">${fmt(selected.current_balance_cents)}</div><p>Opening balance: <b>${fmt(selected.initial_balance_cents)}</b></p>`;
}

function selectCamper(id) {
  if (cart.length && saleCamperId && id !== saleCamperId) {
    toast('warning', '⚠ Finish or Clear Current Sale', ['Complete the current transaction or clear the cart before selecting another camper.']);
    renderCampers();
    return;
  }
  selected = state.campers.find(c => c.id === id);
  renderSelected();
  renderCampers();
  renderCart();
  $('itemSearch').focus();
}

function categories() {
  return [...new Set(state.items.map(i => i.category || 'Uncategorized'))].sort((a, b) => a.localeCompare(b));
}

function selectCategory(category) {
  selectedCategory = decodeURIComponent(category);
  $('itemSearch').value = '';
  renderItems();
}

function backToCategories() {
  selectedCategory = null;
  $('itemSearch').value = '';
  renderItems();
  $('itemSearch').focus();
}

function renderItems() {
  const q = $('itemSearch').value.trim().toLowerCase();
  if (!q && !selectedCategory) {
    $('items').innerHTML = categories().map(c => {
      const count = state.items.filter(i => (i.category || 'Uncategorized') === c).length;
      return `<button class="item category-card" onclick="selectCategory('${uriArg(c)}')"><b>${esc(c)}</b><br><span class="muted">${count} item${count === 1 ? '' : 's'}</span></button>`;
    }).join('') || '<p class="muted">No items imported yet.</p>';
    return;
  }
  const items = state.items.filter(i => q ? i.name.toLowerCase().includes(q) : (i.category || 'Uncategorized') === selectedCategory);
  const back = selectedCategory && !q ? `<button class="secondary back-button" onclick="backToCategories()">← Back to Categories</button>` : '';
  $('items').innerHTML = back + items.slice(0, 60).map(i => `<button class="item" onclick="addItem('${i.id}')"><b>${esc(i.name)}</b><br><span class="muted">${esc(i.category || 'Uncategorized')}</span><br>${fmt(i.cost_cents)}</button>`).join('') || (back + '<p class="muted">No matching items.</p>');
}

function addItem(id) {
  if (!selected) {
    toast('warning', 'Select a Camper First', ['Choose a camper before adding items to the cart.']);
    $('camperSearch').focus();
    return;
  }
  if (!saleCamperId) saleCamperId = selected.id;
  const l = cart.find(x => x.id === id);
  l ? l.qty++ : cart.push({ id, qty: 1 });
  renderSelected();
  renderCampers();
  renderCart();
  $('itemSearch').focus();
}

function qty(id, d) {
  const l = cart.find(x => x.id === id);
  if (!l) return;
  l.qty += d;
  if (l.qty < 1) cart = cart.filter(x => x.id !== id);
  if (!cart.length) saleCamperId = null;
  renderSelected();
  renderCampers();
  renderCart();
}

function total() {
  return cart.reduce((a, l) => a + state.items.find(i => i.id === l.id).cost_cents * l.qty, 0);
}

function renderCart() {
  $('cart').innerHTML = cart.map(l => {
    const i = state.items.find(x => x.id === l.id);
    return `<div class="cartLine"><div><b>${esc(i.name)}</b><br>${l.qty} × ${fmt(i.cost_cents)} = ${fmt(i.cost_cents * l.qty)}</div><div class="qty"><button onclick="qty('${l.id}',-1)">−</button><b>${l.qty}</b><button onclick="qty('${l.id}',1)">+</button></div></div>`;
  }).join('') || '<p class="muted">No items yet.</p>';
  const t = total();
  $('total').textContent = fmt(t);
  const nb = selected ? selected.current_balance_cents - t : null;
  $('newBal').textContent = selected ? fmt(nb) : '—';
  $('warn').innerHTML = selected && nb < 0 ? '<span class="danger">Warning: purchase exceeds current balance.</span>' : '';
}

function clearCart() {
  cart = [];
  saleCamperId = null;
  renderSelected();
  renderCampers();
  renderCart();
  $('itemSearch').focus();
}

async function checkout() {
  if (!selected) return alert('Select a camper first.');
  if (!cart.length) return alert('Add at least one item.');
  const saleName = selected.name, saleTotal = total();
  const r = await fetch('/api/sale', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ camperId: selected.id, cart, allowOverride: false })
  });
  const data = await r.json();
  if (!r.ok) return alert(data.error);
  await load();
  const updated = state.campers.find(c => c.id === data.camperId);
  if (updated) updated.current_balance_cents = data.new_balance_cents;
  toast('success', '✓ Sale Complete', [saleName, fmt(saleTotal), 'Queued for Google Sync']);
  resetSaleWorkflow();
}

// Live refresh so multiple stations (registration, clerks) see each other's
// adds and cabin moves without reloading. Skips the tab when hidden, and never
// disturbs the in-progress cart or the selected camper.
async function refreshState() {
  if (document.hidden) return;
  try {
    const r = await fetch('/api/state');
    if (!r.ok) return;
    const next = await r.json();
    state.items = next.items;
    state.campers = next.campers;
    $('sync').textContent = `Pending Google Sync: ${next.pendingGoogleSync ?? next.pending} Transactions`;
    if (selected) selected = state.campers.find(c => c.id === selected.id) || selected;
    cart = cart.filter(l => state.items.find(i => i.id === l.id));
    if (!cart.length) saleCamperId = null;
    renderCabins();
    renderCampers();
    renderItems();
    renderSelected();
    renderCart();
    renderRecentCash();
  } catch {}
}

function toggleQuickAdd(show) {
  const f = $('quickAddForm');
  f.hidden = show === undefined ? !f.hidden : !show;
  if (!f.hidden) {
    $('qaName').focus();
  } else {
    $('qaName').value = '';
    $('qaCabin').value = '';
    $('qaBalance').value = '';
    $('qaMsg').textContent = '';
  }
}

async function quickAddCamper(e) {
  e.preventDefault();
  const name = $('qaName').value.trim();
  if (!name) { $('qaMsg').textContent = 'Enter a name.'; return; }
  $('qaMsg').textContent = 'Adding…';
  const r = await fetch('/api/campers/quick-add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, cabin: $('qaCabin').value.trim(), initial_balance: $('qaBalance').value.trim() })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { $('qaMsg').textContent = d.error || 'Could not add camper.'; return; }
  state.campers.push(d.camper);
  toast('success', '✓ Camper Added', [d.camper.name, d.camper.cabin || 'No cabin', fmt(d.camper.current_balance_cents)]);
  toggleQuickAdd(false);
  selectedCabin = null;
  renderCabins();
  renderCampers();
  selectCamper(d.camper.id);
}


let cashState = { person:null, amount:null, received:null, submitting:false, result:null, requestId:null };
function parseCurrencyInput(v){const s=String(v||'').trim().replace(/^\$/,'').replace(/,/g,''); if(!/^(?:\d+)(?:\.\d{1,2})?$/.test(s)) return null; const [d, cents='']=s.split('.'); const n=Number(d)*100+Number((cents+'00').slice(0,2)); return Number.isSafeInteger(n)?n:null}
function openCashModal(){cashState={person:null,amount:null,received:null,submitting:false,result:null,requestId:null}; $('cashModal').hidden=false; $('cashStepForm').hidden=false; $('cashConfirm').hidden=true; $('cashResult').hidden=true; $('cashPersonSearch').value=''; $('cashAmount').value=''; $('cashReceived').value=''; $('cashReason').value=''; renderCashPeople(); updateCashCalc(); $('cashPersonSearch').focus()}
function closeCashModal(){if(cashState.submitting)return; $('cashModal').hidden=true}
function renderCashPeople(){const q=$('cashPersonSearch').value.toLowerCase().trim(); const list=(state.campers||[]).filter(p=>!q||p.name.toLowerCase().includes(q)).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,10); $('cashPersonResults').innerHTML=list.map(p=>`<button class="row ${cashState.person?.id===p.id?'selected':''}" type="button" onclick="selectCashPerson('${p.id}')"><b>${esc(p.name)}</b>${p.cabin?`<span class="cabin-tag">${esc(p.cabin)}</span>`:''}<br><span class="muted">${esc(p.person_type||'Person')} · Current: ${fmt(p.current_balance_cents)}</span></button>`).join('')||'<p class="muted">No active people match.</p>'}
function selectCashPerson(id){cashState.person=state.campers.find(p=>p.id===id)||null; $('cashSelectedPerson').className='balance-card'; $('cashSelectedPerson').innerHTML=cashState.person?`<h3>${esc(cashState.person.name)}</h3><p class="muted">${cashState.person.cabin?`Cabin ${esc(cashState.person.cabin)} · `:''}Current balance</p><div class="amount">${fmt(cashState.person.current_balance_cents)}</div>`:'No person selected'; renderCashPeople(); updateCashCalc()}
function updateCashCalc(){const amount=parseCurrencyInput($('cashAmount').value), received=parseCurrencyInput($('cashReceived').value); cashState.amount=amount; cashState.received=received; let msg='', ok=false, change=null; if(!cashState.person) msg='Select a valid person.'; else if(amount==null||received==null) msg='Enter valid dollar amounts with up to two cents.'; else if(amount<=0) msg='Amount to Add must be greater than zero.'; else if(received<amount) msg='Insufficient cash received'; else {ok=true; change=received-amount; msg='Ready to review.'} $('cashChange').textContent=change==null?'—':fmt(change); $('cashValidation').textContent=msg; $('cashChangeBox').className='change-box '+(ok?'ok-box':'bad-box'); $('cashReview').disabled=!ok; return ok}
function showCashConfirm(){if(!updateCashCalc())return; const p=cashState.person, resulting=p.current_balance_cents+cashState.amount, reason=$('cashReason').value.trim(); $('cashStepForm').hidden=true; $('cashConfirm').hidden=false; $('cashConfirm').innerHTML=`<h3>Confirm cash deposit</h3><div class="confirm-grid"><div><b>Person</b>${esc(p.name)}${p.cabin?` · ${esc(p.cabin)}`:''}</div><div><b>Current balance</b>${fmt(p.current_balance_cents)}</div><div><b>Amount being added</b>${fmt(cashState.amount)}</div><div><b>Cash received</b>${fmt(cashState.received)}</div><div class="change-return"><b>Change owed</b>${fmt(cashState.received-cashState.amount)}</div><div><b>Resulting balance</b>${fmt(resulting)}</div>${reason?`<div><b>Reason / Note</b>${esc(reason)}</div>`:''}</div><p id="cashSubmitError" class="danger"></p><div class="dialog-actions"><button id="cashSubmit" class="primary" type="button" onclick="submitCashDeposit()">Confirm and Record Cash</button><button class="secondary" type="button" onclick="$('cashConfirm').hidden=true;$('cashStepForm').hidden=false">Back</button></div>`}
async function submitCashDeposit(){if(cashState.submitting)return; cashState.submitting=true; $('cashSubmit').disabled=true; $('cashSubmit').textContent='Recording…'; cashState.requestId=cashState.requestId||('cash_'+Date.now()+'_'+Math.random().toString(16).slice(2)); const r=await fetch('/api/cash-deposits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({camper_id:cashState.person.id,amount_added_cents:cashState.amount,cash_received_cents:cashState.received,reason:$('cashReason').value.trim(),client_request_id:cashState.requestId})}); const d=await r.json().catch(()=>({})); if(!r.ok){cashState.submitting=false; $('cashSubmit').disabled=false; $('cashSubmit').textContent='Confirm and Record Cash'; $('cashSubmitError').textContent=d.error||'Cash deposit failed.'; return} cashState.result=d; await load(); showCashResult(d)}
function showCashResult(d){$('cashConfirm').hidden=true; $('cashResult').hidden=false; $('cashResult').innerHTML=`<h3>Cash deposit recorded</h3><div class="change-return big"><b>Change to Return</b>${fmt(d.change_owed_cents)}</div><div class="confirm-grid"><div><b>Person</b>${esc(d.camperName)}</div><div><b>Amount added</b>${fmt(d.amount_added_cents)}</div><div><b>Cash received</b>${fmt(d.cash_received_cents)}</div><div><b>New balance</b>${fmt(d.new_balance_cents)}</div><div><b>Clerk</b>${esc(d.clerk||state.user.displayName)}</div><div><b>Timestamp</b>${esc(d.created_at)}</div></div><div class="dialog-actions"><button class="primary" type="button" onclick="closeCashModal()">Done</button><button class="secondary" type="button" onclick="openCashModal()">Add Another Cash Deposit</button></div>`}
function renderRecentCash(){const host=$('recentCashActivity'); if(!host)return; host.innerHTML=(state.recentCashDeposits||[]).slice(0,5).map(e=>`<div>${esc(e.camper_name)} — Cash deposit +${fmt(e.amount_credited_cents)} — <b>Change ${fmt(e.change_given_cents)}</b></div>`).join('')||'<p class="muted">No recent cash deposits.</p>'}

$('camperSearch').oninput = renderCampers;
$('itemSearch').oninput = () => {
  if ($('itemSearch').value.trim()) selectedCategory = null;
  renderItems();
};
$('checkout').onclick = checkout;
$('clear').onclick = clearCart;
$('logout').onclick = logout;
$('addCamperBtn').onclick = () => toggleQuickAdd();
$('qaCancel').onclick = () => toggleQuickAdd(false);
$('quickAddForm').onsubmit = quickAddCamper;
$('cashDepositBtn').onclick = openCashModal; $('cashClose').onclick = closeCashModal; $('cashPersonSearch').oninput = renderCashPeople; $('cashAmount').oninput = updateCashCalc; $('cashReceived').oninput = updateCashCalc; $('cashReview').onclick = showCashConfirm;
setInterval(refreshState, 8000);
load();
