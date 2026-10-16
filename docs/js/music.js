/**
 * Musica di sottofondo in loop (docs/musics/egiziana.mp3).
 * I browser bloccano l’autoplay con suono: partiamo al primo click/tocco.
 * Preferenza muto salvata in localStorage (bellum:music-muted).
 */

const MUSIC_KEY = 'bellum:music-muted';
const VOLUME = 0.35; // volume soft, non invade

const audio = document.getElementById('bg-music');
const btn = document.getElementById('music-mute-button');

function isMuted() {
  try {
    return localStorage.getItem(MUSIC_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function setMuted(muted) {
  try {
    localStorage.setItem(MUSIC_KEY, muted ? '1' : '0');
  } catch (_) { /* ignore */ }
  if (audio) {
    audio.muted = muted;
    if (!muted) {
      audio.volume = VOLUME;
      void tryPlay();
    }
  }
  updateButton();
}

function updateButton() {
  if (!btn) return;
  const muted = isMuted() || !!(audio && audio.muted);
  btn.textContent = muted ? '🔇' : '🔊';
  btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  btn.setAttribute('aria-label', muted ? 'Musica disattivata — tocca per attivare' : 'Musica attiva — tocca per silenziare');
  btn.title = muted ? 'Attiva musica' : 'Silenzia musica';
  btn.classList.toggle('is-muted', muted);
}

async function tryPlay() {
  if (!audio || isMuted()) return;
  audio.muted = false;
  audio.volume = VOLUME;
  audio.loop = true;
  try {
    await audio.play();
  } catch (e) {
    // Autoplay bloccato: aspetteremo un gesto utente
  }
}

function unlockOnGesture() {
  if (isMuted()) return;
  void tryPlay();
}

function init() {
  if (!audio) return;

  audio.loop = true;
  audio.volume = VOLUME;

  if (isMuted()) {
    audio.muted = true;
  } else {
    audio.muted = false;
    void tryPlay();
  }
  updateButton();

  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = !(isMuted() || audio.muted);
    setMuted(next);
  });

  // Sblocco autoplay al primo gesto
  const once = { once: true, passive: true };
  document.addEventListener('pointerdown', unlockOnGesture, once);
  document.addEventListener('keydown', unlockOnGesture, once);
  document.addEventListener('touchstart', unlockOnGesture, once);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
