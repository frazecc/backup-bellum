import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://dgsqxnmrjfvklnjliplh.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ZwwwsHnjEWNbe2CnDKsTSA_8ljXZlOG';
const TEST_EMAIL_DOMAIN = '@test.local';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const authScreen = document.getElementById('auth-screen');
const gameScreen = document.getElementById('game-screen');
const loginForm = document.getElementById('login-form');
const usernameInput = document.getElementById('login-username');
const passwordInput = document.getElementById('login-password');
const loginButton = document.getElementById('login-button');
const authMessage = document.getElementById('auth-message');
const signedInUser = document.getElementById('signed-in-user');
const logoutButton = document.getElementById('logout-button');
const authKnown = document.getElementById('auth-known');
const authKnownName = document.getElementById('auth-known-name');
const authSonoIo = document.getElementById('auth-sono-io');
const authAltroUtente = document.getElementById('auth-altro-utente');

export function usernameFromEmail(email) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  if (normalizedEmail.endsWith(TEST_EMAIL_DOMAIN)) {
    return normalizedEmail.slice(0, -TEST_EMAIL_DOMAIN.length);
  }
  return normalizedEmail.split('@')[0] || '';
}

export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    console.error('Errore nel recupero dell’utente:', error);
    return null;
  }
  return data.user ?? null;
}

export async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('Errore nel recupero della sessione:', error);
    return null;
  }
  return data.session?.access_token ?? null;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

function setAuthMessage(message = '', type = '') {
  if (!authMessage) return;
  authMessage.textContent = message;
  authMessage.className = `form-message ${type}`.trim();
  authMessage.hidden = !message;
}

function setLoginLoading(isLoading) {
  if (loginButton) {
    loginButton.disabled = isLoading;
    loginButton.textContent = isLoading ? 'Accesso in corso…' : 'Accedi';
  }
  if (usernameInput) usernameInput.disabled = isLoading;
  if (passwordInput) passwordInput.disabled = isLoading;
}

function showLoginForm() {
  loginForm?.classList.remove('hidden');
  authKnown?.classList.add('hidden');
}

function showKnownUser(user) {
  const name = usernameFromEmail(user?.email) || 'viaggiatore';
  if (authKnownName) authKnownName.textContent = `Riconosco l’ombra di @${name}.`;
  loginForm?.classList.add('hidden');
  authKnown?.classList.remove('hidden');
}

/** Schermata mummia: sempre visibile all’ingresso / dopo sconfitta. */
export function showAuthScreen(options = {}) {
  authScreen?.classList.remove('hidden');
  gameScreen?.classList.add('hidden');
  setAuthMessage();

  if (signedInUser) signedInUser.textContent = '';

  supabase.auth.getSession().then(({ data }) => {
    if (data.session?.user && !options.forceLoginForm) {
      showKnownUser(data.session.user);
    } else {
      showLoginForm();
    }
  }).catch(() => showLoginForm());
}

function showGameScreen(user) {
  const username = usernameFromEmail(user?.email);
  authScreen?.classList.add('hidden');
  gameScreen?.classList.remove('hidden');
  if (signedInUser) {
    signedInUser.textContent = username ? `@${username}` : 'Giocatore';
  }
  window.dispatchEvent(
    new CustomEvent('bellum:auth-ready', {
      detail: { user },
    }),
  );
}

async function loadSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('Errore nel recupero della sessione:', error);
    setAuthMessage('Impossibile verificare la sessione. Riprova.', 'error');
    showAuthScreen({ forceLoginForm: true });
    return;
  }

  if (data.session?.user) {
    showAuthScreen({ preferKnown: true });
    return;
  }
  showAuthScreen({ forceLoginForm: true });
}

async function handleLogin(event) {
  event.preventDefault();
  setAuthMessage();

  const username = String(usernameInput?.value ?? '').trim().toLowerCase();
  const password = String(passwordInput?.value ?? '');

  if (!username || !password) {
    setAuthMessage('Inserisci nome utente e password.', 'error');
    return;
  }

  const email = username.includes('@') ? username : `${username}${TEST_EMAIL_DOMAIN}`;
  setLoginLoading(true);

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      setAuthMessage('Nome utente o password non validi.', 'error');
      return;
    }
    if (passwordInput) passwordInput.value = '';
    setAuthMessage('Accesso eseguito.', 'success');
    showGameScreen(data.user);
  } catch (error) {
    console.error('Errore inatteso durante il login:', error);
    setAuthMessage('Errore di connessione. Riprova tra poco.', 'error');
  } finally {
    setLoginLoading(false);
  }
}

async function handleSonoIo() {
  setAuthMessage();
  const user = await getCurrentUser();
  if (!user) {
    setAuthMessage('Sessione scaduta. Accedi di nuovo.', 'error');
    showLoginForm();
    return;
  }
  showGameScreen(user);
}

async function handleAltroUtente() {
  setAuthMessage();
  try {
    await signOut();
  } catch (e) {
    console.warn(e);
  }
  if (loginForm) loginForm.reset();
  showLoginForm();
}

async function handleLogout() {
  setAuthMessage();
  try {
    await signOut();
    if (loginForm) loginForm.reset();
    showAuthScreen({ forceLoginForm: true });
    setAuthMessage('Sessione terminata.', 'success');
  } catch (error) {
    console.error('Errore durante il logout:', error);
    setAuthMessage('Impossibile chiudere la sessione. Riprova.', 'error');
  }
}

loginForm?.addEventListener('submit', handleLogin);
logoutButton?.addEventListener('click', handleLogout);
authSonoIo?.addEventListener('click', () => handleSonoIo().catch(console.error));
authAltroUtente?.addEventListener('click', () => handleAltroUtente().catch(console.error));

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    showAuthScreen({ forceLoginForm: true });
  }
});

loadSession();
