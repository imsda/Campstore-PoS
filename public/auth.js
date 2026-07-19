(function(){
  const AUTH_STORAGE_KEYS = ['campstore_session','campstore_auth','campstore_token','authToken','token','currentUser'];
  let logoutInFlight = false;
  function clearAuthState(){
    for(const store of [window.localStorage, window.sessionStorage]){
      if(!store) continue;
      for(const key of AUTH_STORAGE_KEYS) store.removeItem(key);
    }
    window.currentUser = null;
    window.CampCurrentUser = null;
  }
  function setLogoutMessage(button,message){
    let el = document.getElementById('logoutMsg');
    if(!el && button){
      el = document.createElement('span');
      el.id = 'logoutMsg';
      el.className = 'danger';
      el.setAttribute('role','status');
      el.setAttribute('aria-live','polite');
      button.insertAdjacentElement('afterend', el);
    }
    if(el) el.textContent = message || '';
  }
  async function logout(button){
    if(logoutInFlight) return;
    logoutInFlight = true;
    if(button) button.disabled = true;
    setLogoutMessage(button,'');
    try{
      const r = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      if(!r.ok) throw Error('Logout failed. Please try again.');
      clearAuthState();
      location.replace('/login.html');
    }catch(e){
      logoutInFlight = false;
      if(button) button.disabled = false;
      setLogoutMessage(button, e.message || 'Logout failed. Please try again.');
    }
  }
  function initLogoutButton(root){
    const button = (root || document).getElementById ? (root || document).getElementById('logout') : document.getElementById('logout');
    if(!button) return;
    button.type = 'button';
    button.onclick = () => logout(button);
  }
  window.CampAuth = { clearAuthState, logout, initLogoutButton };
  document.addEventListener('DOMContentLoaded', () => initLogoutButton(document));
})();
