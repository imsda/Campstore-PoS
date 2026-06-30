let state = {}, selected = null, cart = [], selectedCategory = null, saleCamperId = null;
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

function resetSaleWorkflow() {
  cart = [];
  selected = null;
  saleCamperId = null;
  selectedCategory = null;
  $('camperSearch').value = '';
  $('itemSearch').value = '';
  $('selected').className = 'balance-card muted';
  $('selected').textContent = 'No camper selected';
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
  if (state.user.role === 'CLERK') $('adminLink').style.display = 'none';
  if (selected) selected = state.campers.find(c => c.id === selected.id) || selected;
  renderCampers();
  renderItems();
  renderCart();
  renderSelected();
}

function renderCampers() {
  const q = $('camperSearch').value.toLowerCase();
  $('campers').innerHTML = state.campers
    .filter(c => c.name.toLowerCase().includes(q))
    .slice(0, 30)
    .map(c => `<div class="row ${selected?.id === c.id ? 'selected' : ''} ${saleCamperId && saleCamperId !== c.id ? 'locked-choice' : ''}" onclick="selectCamper('${c.id}')"><b>${esc(c.name)}</b><br><span class="muted">Current: ${fmt(c.current_balance_cents)}</span></div>`)
    .join('');
}

function renderSelected() {
  if (!selected) return;
  const locked = cart.length > 0;
  $('selected').className = `balance-card ${locked ? 'sale-locked' : ''}`;
  $('selected').innerHTML = `<div class="selected-head"><h3>${esc(selected.name)}</h3>${locked ? '<span class="lock-pill">🔒 Sale in Progress</span>' : ''}</div><p class="muted">Current balance</p><div class="amount">${fmt(selected.current_balance_cents)}</div><p>Initial balance: <b>${fmt(selected.initial_balance_cents)}</b></p>`;
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
      return `<button class="item category-card" onclick="selectCategory('${encodeURIComponent(c)}')"><b>${esc(c)}</b><br><span class="muted">${count} item${count === 1 ? '' : 's'}</span></button>`;
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

$('camperSearch').oninput = renderCampers;
$('itemSearch').oninput = () => {
  if ($('itemSearch').value.trim()) selectedCategory = null;
  renderItems();
};
$('checkout').onclick = checkout;
$('clear').onclick = clearCart;
$('logout').onclick = logout;
load();
