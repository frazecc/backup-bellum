/**
 * Musica di sottofondo in loop (docs/musics/egiziana.mp3).
 * Controllo dal pannello Impostazioni (#music-mute-button).
 */

const MUSIC_KEY = 'bellum:music-muted';
const VOLUME = 0.35;

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
  const value = document.getElementById('music-mute-value');
  if (value) value.textContent = muted ? '🔇' : '🔊';
  btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  btn.classList.toggle('is-muted', muted);
  const title = document.getElementById('music-mute-title');
  const desc = document.getElementById('music-mute-desc');
  if (title) title.textContent = muted ? 'Musica (spenta)' : 'Musica';
  if (desc) desc.textContent = muted ? 'Tocca per riattivare il sottofondo' : 'Sottofondo egiziano in loop';
}

async function tryPlay() {
  if (!audio || isMuted()) return;
  audio.muted = false;
  audio.volume = VOLUME;
  audio.loop = true;
  try {
    await audio.play();
  } catch (_) {
    /* autoplay bloccato finché non c’è un gesto */
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
  if (isMuted()) audio.muted = true;
  else {
    audio.muted = false;
    void tryPlay();
  }
  updateButton();

  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = !(isMuted() || audio.muted);
    setMuted(next);
  });

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
