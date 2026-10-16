// docs/js/game.js — Bellum Penumbrum v4, bersaglio unico ETB (3d).
// Passo 1 / Consegne A+B: layout a colonna centrale (stage), mano a ventaglio, dorsi IA, menu,
// dialoghi confinati nella colonna e schermata iniziale (recupera / nuova partita).
import { getAccessToken, getCurrentUser, signOut, usernameFromEmail, showAuthScreen } from './auth.js';

const API = 'https://bellum-penumbrum-api.onrender.com';
const $ = id => document.getElementById(id);
const cache = new Map();
let state = null, matchId = null, busy = false, initialized = false, view = null, flow = null;
let deathDraft = { choiceId: null, instanceIds: [] };
let presentationRunning = false, presentationGeneration = 0;
let lastPhaseKey = null; // scandisce ogni cambio fase anche se vuota
const waitPresentation = ms => new Promise(resolve => setTimeout(resolve,ms));
const board = () => state?.board?.rows ?? [[null,null,null],[null,null,null],[null,null,null]];
const at = p => board()[p.row]?.[p.col] ?? null;
const me = () => state?.players?.[1];
const them = () => state?.players?.[0];
const reaction = () => state?.pending_reaction?.responder_index === 1 ? state.pending_reaction : null;
const deathOrder = () => state?.pending_death_order?.chooser_index === 1 ? state.pending_death_order : null;
const deathTarget = () => state?.pending_target_choice?.chooser_index === 1 ? state.pending_target_choice : null;
const obligatory = () => !!state?.pending_death_order || !!state?.pending_target_choice;
const turn = () => state?.status === 'running' && state.active_player_index === 1 && state.phase === 'main';
const pending = () => state?.pending_mostrissimo?.player_index === 1 ? state.pending_mostrissimo : null;
const active = () => turn() && !busy && !pending() && !state?.pending_reaction && !obligatory() && !(state?.work_queue?.length);
const inside = p => p.row >= 0 && p.row < 3 && p.col >= 0 && p.col < 3;
const around = p => [{row:p.row-1,col:p.col},{row:p.row+1,col:p.col},{row:p.row,col:p.col-1},{row:p.row,col:p.col+1}].filter(inside);
const eq = (a,b) => !!(a && b && a.row === b.row && a.col === b.col);
const isCreatureCell = c => c?.kind === 'creature';
const foes = p => around(p).filter(q => isCreatureCell(at(q)) && at(q).owner_index === 0);
const steps = p => around(p).filter(q => q.row !== 0 && !at(q));
const escape = x => String(x ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const creature = d => ['monster','mostrissimo'].includes(d.card_type);
const effects = d => Array.isArray(d?.effect_json?.effects) ? d.effect_json.effects : d?.effect_json?.type ? [d.effect_json] : [];
const targetEffect = d => effects(d).find(e => !e?.trigger && (e?.target === 'any_creature' || e?.target === 'any_target' || e?.type === 'return_hand'));
// Danno a scelta: il giocatore avversario (IA, indice 0) si sceglie toccando i suoi PV. Id fittizio player:0.
const AI_TARGET = 'player:0';
const playerTargetEffect = d => ['aura','terraforma'].includes(d?.card_type) ? undefined : effects(d).find(e => !e?.trigger && e?.target === 'any_target' && ['damage','damage_creature'].includes(e.type));
const hasTargets = d => !!playerTargetEffect(d) || targets(d).length > 0;
// Si attaccano creature nemiche e Terraforme nemiche con PV; solo le creature bloccano l'attacco diretto.
const attackable = p => around(p).filter(q => { const c = at(q); return c?.owner_index === 0 && (isCreatureCell(c) || (c.kind === 'terraforma' && c.hp !== undefined)); });
const factions = ['','CHI','INF','PES','BUL','GRO','CLO','IND'];
const deckFactionNames = {CHI:'Chiericanza',INF:'Infamia',PES:'Pestilenza',BUL:'Bullismo',GRO:'Grossanza',CLO:'Clownerie'};
const types = {monster:'MOSTRO',mostrissimo:'MOSTRISSIMO',maledizione:'MALEDIZIONE',instant:'TRAPPOLA',terraforma:'TERRAFORMA',aura:'AURA'};
const rarities = {common:'Comune',uncommon:'Non comune',rare:'Rara',ultra_rare:'Ultra rara',legendary:'Leggendaria'};
const faction = d => {
  const code = String(d?.faction_code ?? factions[Number(d?.faction_id)] ?? 'IND').toLowerCase();
  return ['chi','inf','pes','bul','gro','clo','ind'].includes(code) ? code : 'ind';
};
// ---------- Passo 1: helper di presentazione (stage) ----------
const stageRoot = () => $('stage') ?? document.body; // tutti i dialoghi vivono dentro la colonna centrale
/** Costo mana effettivo (Medaglione CLO in Storia: creature −1, min 1). */
function effectiveManaCost(d) {
  let cost = Number(d?.mana_cost ?? 0);
  if (currentMode === 'story' && d?.card_type === 'monster') {
    const med = getStoryProgress()?.chosenPower;
    if (med === 'CLO') cost = Math.max(1, cost - 1);
  }
  return cost;
}
const costText = d => d.card_type === 'mostrissimo' ? `✦${Number(d.sacrifice_cost ?? 0)}` : `⚡${effectiveManaCost(d)}`;
const plainText = d => String(d?.effect_text ?? '').replace(/\*\*/g,'').replace(/\s+/g,' ').trim();
const hasText = d => plainText(d).length > 0;
/** Anteprima effetto: intero se corto, altrimenti taglio + puntini. */
const effectPreview = (d, max = 72) => {
  const t = plainText(d);
  if (!t) return '';
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
};
const artHTML = d => d.image_url ? `<img src="${escape(d.image_url)}" alt="Illustrazione di ${escape(d.name)}">` : '<span class="game-card-art-placeholder">🎴</span>';
const TEXT_ICON = '<span class="CLS" title="Questa carta ha un testo" aria-hidden="true">📜</span>';
function cellHTML(d, c) {
  const isCreature = isCreatureCell(c);
  const atk = c.attack ?? d.attack ?? 0;
  const hp = c.hp ?? d.hp ?? 0;
  const hurt = isCreature && Number(c.max_hp) > 0 && Number(hp) < Number(c.max_hp) ? ' hurt' : '';
  const buff = isCreature && Number(atk) > Number(d.attack ?? 0) ? ' buff' : '';
  const f = faction(d);
  const cost = d.card_type === 'mostrissimo'
    ? Number(d.sacrifice_cost ?? 0)
    : Number(d.mana_cost ?? 0);
  const costIcon = d.card_type === 'mostrissimo' ? '✦' : '';
  const fx = effectPreview(d, 48);

  return `<article class="cell-card faction-${f}${c.kind === 'terraforma' ? ' is-terra' : ''}">
    <div class="cc-nameband"><span class="cc-name">${escape(d.name)}</span></div>
    <div class="cc-art">${artHTML(d)}</div>
    <span class="cc-cost shape-${f}" title="Costo">${costIcon}${cost}</span>
    ${fx ? `<div class="cc-fx">${escape(fx)}</div>` : ''}
    ${isCreature
      ? `<span class="cc-atk${buff}">${atk}</span><span class="cc-hp${hurt}">${hp}</span>`
      : (c.kind === 'terraforma' && c.hp !== undefined
          ? `<span class="cc-hp${Number(c.hp) < Number(c.max_hp) ? ' hurt' : ''}">${c.hp}</span>`
          : '')}
  </article>`;
}
function handCardHTML(d) {
  const isCreature = creature(d);
  const f = faction(d);
  const cost = d.card_type === 'mostrissimo'
    ? Number(d.sacrifice_cost ?? 0)
    : Number(d.mana_cost ?? 0);
  const costIcon = d.card_type === 'mostrissimo' ? '✦' : '';
  const fx = effectPreview(d, 72);

  return `<article class="fan-card faction-${f}${isCreature ? '' : ' no-stats'}">
    <div class="fc-nameband"><span class="fc-name">${escape(d.name)}</span></div>
    <div class="fc-art">${artHTML(d)}</div>
    <span class="fc-cost shape-${f}" title="Costo">${costIcon}${cost}</span>
    ${fx ? `<div class="fc-fx">${escape(fx)}</div>` : ''}
    ${isCreature ? `<span class="fc-stat atk">${d.attack ?? 0}</span><span class="fc-stat hp">${d.hp ?? 0}</span>` : ''}
  </article>`;
}
// Geometria del ventaglio, in "px di riferimento" della colonna 455x768 (vedi css/stage.css).
const HAND_AREA = 403, HAND_MIN_VISIBLE = 34;
function handGeometry(n) {
  const w = Math.max(56, Math.min(88, n > 1 ? HAND_AREA - HAND_MIN_VISIBLE * (n - 1) : 88));
  const step = n > 1 ? Math.min(w + 6, (HAND_AREA - w) / (n - 1)) : 0;
  const rot = n > 1 ? Math.min(3.4, 22 / (n - 1)) : 0;
  const k = n > 1 ? Math.min(3, 12 / Math.max(1, ((n - 1) / 2) ** 2)) : 0;
  return {w, h: Math.round(w * 1.48), step, rot, k, drop: k * ((n - 1) / 2) ** 2};
}
// Misura la finestra reale e imposta la scala della colonna centrale.
// Riferimento 455x768. Finestra "larga" (PC): colonna di 455x768 scalata e centrata. Finestra "stretta" (telefono
// in verticale): la colonna occupa tutta l'area visibile e l'altezza è flessibile.
const STAGE_W = 455, STAGE_H = 768, STAGE_MIN_ASPECT = 0.44;
function fitStage() {
  const stage = $('stage'); if (!stage) return;
  const vw = window.innerWidth, vh = window.innerHeight; if (!vw || !vh) return;
  const byWidth = vw / STAGE_W, byHeight = vh / STAGE_H;
  const unit = Math.min(byWidth, byHeight), fullWidth = byWidth <= byHeight;
  const width = fullWidth ? vw : STAGE_W * unit, height = fullWidth ? Math.min(vh, vw / STAGE_MIN_ASPECT) : vh;
  stage.style.setProperty('--p',`${unit.toFixed(4)}px`);
  document.documentElement.style.setProperty('--p',`${unit.toFixed(4)}px`);
  stage.style.setProperty('--sw',`${Math.floor(width)}px`);
  stage.style.setProperty('--sh',`${Math.floor(height)}px`);
  stage.closest('.stage-frame')?.classList.toggle('is-framed',!fullWidth);
}
function wireStage() {
  fitStage();
  window.addEventListener('resize',fitStage);
  window.addEventListener('orientationchange',() => setTimeout(fitStage,150));
  window.visualViewport?.addEventListener('resize',fitStage);
}
function applyReduceMotion(on) {
  const stage = $('stage');
  if (stage) stage.classList.toggle('calm', !!on);
  const toggle = $('reduce-motion-toggle');
  if (toggle) toggle.setAttribute('aria-checked', on ? 'true' : 'false');
  try { localStorage.setItem('bellum:reduce-motion', on ? '1' : '0'); } catch (_) { /* ignore */ }
}
function wireReduceMotion() {
  const toggle = $('reduce-motion-toggle');
  if (!toggle || toggle.dataset.ready) return;
  toggle.dataset.ready = 'true';
  let stored = null;
  try { stored = localStorage.getItem('bellum:reduce-motion'); } catch (_) { /* ignore */ }
  const prefers = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const on = stored === '1' || (stored === null && prefers);
  applyReduceMotion(on);
  toggle.addEventListener('click', e => {
    e.stopPropagation();
    const next = toggle.getAttribute('aria-checked') !== 'true';
    applyReduceMotion(next);
  });
}

/** Preferenza: conferma automatica dei popup «Ho capito» (solo phase-banner, non dialoghi Mummia). */
function isAutoNotice() {
  try { return localStorage.getItem('bellum:auto-ho-capito') === '1'; } catch (_) { return false; }
}
function applyAutoNotice(on) {
  const toggle = $('auto-notice-toggle');
  if (toggle) toggle.setAttribute('aria-checked', on ? 'true' : 'false');
  try { localStorage.setItem('bellum:auto-ho-capito', on ? '1' : '0'); } catch (_) { /* ignore */ }
}
function wireAutoNotice() {
  const toggle = $('auto-notice-toggle');
  if (!toggle || toggle.dataset.ready) return;
  toggle.dataset.ready = 'true';
  let stored = null;
  try { stored = localStorage.getItem('bellum:auto-ho-capito'); } catch (_) { /* ignore */ }
  applyAutoNotice(stored === '1');
  toggle.addEventListener('click', e => {
    e.stopPropagation();
    const next = toggle.getAttribute('aria-checked') !== 'true';
    applyAutoNotice(next);
  });
}
let narratorResolver = null;
function setNarratorImage(src) {
  const url = src || 'img/mummy/mummy-base.png';
  for (const id of ['narrator-popup-img', 'narrator-desk-img']) {
    const img = $(id);
    if (!img) continue;
    img.style.display = '';
    img.onerror = () => {
      img.style.display = 'none';
      img.nextElementSibling?.classList.remove('hidden');
    };
    if (img.getAttribute('src') !== url) img.setAttribute('src', url);
    img.onload = () => {
      img.style.display = '';
      img.nextElementSibling?.classList.add('hidden');
    };
  }
}
/** Mostra battuta del narratore. Su mobile apre popup; su desktop aggiorna la colonna sinistra. */
function showNarrator(text, imageSrc) {
  const speech = String(text ?? '').trim() || '…';
  setNarratorImage(imageSrc);
  const desk = $('narrator-desk-speech');
  if (desk) desk.textContent = speech;
  const popup = $('narrator-popup');
  const bubble = $('narrator-popup-speech');
  if (bubble) bubble.textContent = speech;
  const wide = typeof matchMedia === 'function' && matchMedia('(min-width: 1100px)').matches
    && !!document.querySelector('.stage-frame.is-framed');
  if (wide || !popup) return Promise.resolve();
  popup.classList.remove('hidden');
  return new Promise(resolve => {
    narratorResolver = resolve;
    const btn = $('narrator-continue');
    if (btn && !btn.dataset.ready) {
      btn.dataset.ready = 'true';
      btn.addEventListener('click', () => hideNarrator());
    }
  });
}
function hideNarrator() {
  $('narrator-popup')?.classList.add('hidden');
  const r = narratorResolver;
  narratorResolver = null;
  if (r) r();
}
function wireMenu() {
  const button = $('menu-button'), panel = $('menu-panel');
  if (!button || !panel || button.dataset.ready) return;
  button.dataset.ready = 'true';
  const setOpen = open => { panel.classList.toggle('hidden',!open); button.setAttribute('aria-expanded',String(open)); };
  button.addEventListener('click',e => { e.stopPropagation(); setOpen(panel.classList.contains('hidden')); });
  panel.addEventListener('click',e => {
    const t = e.target.closest?.('button');
    if (t) setOpen(false);
  });
  document.addEventListener('click',e => { if (!panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== button) setOpen(false); });
  document.addEventListener('keydown',e => { if (e.key === 'Escape' && !panel.classList.contains('hidden')) setOpen(false); });
}

/** Pannello Impostazioni sempre visibile (audio, auto Ho capito, riduci animazioni). */
function wireSettings() {
  const button = $('settings-button'), panel = $('settings-panel');
  if (!button || !panel || button.dataset.ready) return;
  button.dataset.ready = 'true';
  const setOpen = open => {
    panel.classList.toggle('hidden', !open);
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', e => {
    e.stopPropagation();
    setOpen(panel.classList.contains('hidden'));
  });
  document.addEventListener('click', e => {
    if (panel.classList.contains('hidden')) return;
    if (panel.contains(e.target) || e.target === button) return;
    setOpen(false);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) setOpen(false);
  });
  wireReduceMotion();
  wireAutoNotice();
}
function drawOpponentHand() {
  const root = $('opponent-hand'); if (!root) return;
  const n = them()?.hand?.length ?? 0; // SOLO il numero: mai card_id o faccia delle carte dell'IA.
  root.replaceChildren(); root.style.setProperty('--n',String(Math.max(n,1)));
  root.setAttribute('aria-label',`L’IA ha ${n} ${n === 1 ? 'carta' : 'carte'} in mano`);
  // Solo dorsi: il conteggio testuale «N in mano» è ridondante (i dorsi bastano).
  const backs = document.createElement('span'); backs.className = 'oh-backs';
  for (let i = 0; i < n; i++) { const back = document.createElement('span'); back.className = 'card-back'; backs.append(back); }
  root.append(backs);
}
function cardHTML(d, mini = false, cell = null) {
  const f = faction(d);
  const cls = `faction-${f}`;
  const isMostrissimo = d.card_type === 'mostrissimo';
  const costNum = isMostrissimo ? Number(d.sacrifice_cost ?? 0) : Number(d.mana_cost ?? 0);
  const costIcon = isMostrissimo ? '✦' : '';
  const art = d.image_url
    ? `<img src="${escape(d.image_url)}" alt="Illustrazione di ${escape(d.name)}" loading="lazy">`
    : '<span class="game-card-art-placeholder">🎴</span>';
  const atk = cell?.attack ?? d.attack ?? 0;
  const hp = cell?.hp ?? d.hp ?? 0;
  const subtype = d.subtype ? String(d.subtype) : '';
  const factionLabel = deckFactionNames[f.toUpperCase()] || f.toUpperCase();
  const typeLabel = types[d.card_type] ?? d.card_type;
  const isCreature = creature(d);
  // Stesso layout delle mini (fan/cell): badge rotondi agli angoli + effetto sotto l’arte.
  const fxShort = effectPreview(d, mini ? 90 : 160);
  const rulesFull = escape(d.effect_text || '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');

  if (mini) {
    return `<article class="board-card fan-like ${cls}${isCreature ? '' : ' no-stats'}">
      <div class="fc-nameband"><span class="fc-name">${escape(d.name)}</span></div>
      <div class="fc-art">${art}</div>
      <span class="fc-cost shape-${f}" title="Costo">${costIcon}${costNum}</span>
      ${fxShort ? `<div class="fc-fx">${escape(fxShort)}</div>` : ''}
      ${isCreature ? `<span class="fc-stat atk">${atk}</span><span class="fc-stat hp">${hp}</span>` : ''}
    </article>`;
  }

  return `<article class="game-card fan-like ${cls}${isCreature ? '' : ' no-stats'}">
    <div class="fc-nameband"><span class="fc-name">${escape(d.name)}</span></div>
    <div class="fc-art">${art}</div>
    <span class="fc-cost shape-${f}" title="Costo">${costIcon}${costNum}</span>
    <div class="gc-type">${escape(typeLabel)}${subtype ? ' · ' + escape(subtype) : ''} · ${escape(factionLabel)}</div>
    <div class="game-card-rules">${rulesFull || '<em>Nessun effetto.</em>'}</div>
    ${d.flavor_text ? `<div class="game-card-flavor">${escape(d.flavor_text)}</div>` : ''}
    ${isCreature ? `<span class="fc-stat atk">${atk}</span><span class="fc-stat hp">${hp}</span>` : ''}
    <div class="gc-rarity">${escape(rarities[d.rarity] ?? d.rarity ?? 'Comune')}</div>
  </article>`;
}
// Durante monster_etb la Trappola mirata può colpire soltanto la fonte
// dell'ETB. Le altre finestre conservano le regole ordinarie di bersaglio.
function targetAllowed(d,c,event=null) {
  if (!isCreatureCell(c)) return false;
  if (d.card_type === 'aura') return true;
  const e = targetEffect(d);
  if (!e) return false;
  if (event?.kind === 'monster_etb' && c.instance_id !== event.source_instance_id) return false;
  if (e.target === 'any_target') return true;
  if (['damage','damage_creature'].includes(e.type) && e.timing !== 'instant') return c.owner_index === 0;
  if (e.type === 'heal' && e.timing !== 'instant') return c.owner_index === 1;
  return true;
}
function targets(d) {
  const found = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const cell = at({row,col});
    if (targetAllowed(d,cell)) found.push(cell);
  }
  return found;
}
function permanents() {
  const found = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const c = at({row,col});
    if (!c) continue;
    if (c.owner_index === 1) found.push({id:c.instance_id,card_id:c.card_id,type:c.kind === 'terraforma' ? 'Terraforma' : 'Creatura'});
    if (isCreatureCell(c)) for (const a of c.auras ?? []) if (a.owner_index === 1) found.push({id:a.instance_id,card_id:a.card_id,type:'Aura'});
  }
  return found;
}
function summonCells(p) {
  if (!p) return [];
  const found = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const pos = {row,col};
    if (!at(pos) && (row === 2 || (row === 1 && (p.freed_positions ?? []).some(x => eq(x,pos))))) found.push(pos);
  }
  return found;
}
let noticeTimer = null;
let noticeResolver = null;
let noticeOpen = false;

function dismissNotice() {
  const el = $('phase-banner');
  if (!el) {
    const r0 = noticeResolver; noticeResolver = null; noticeOpen = false;
    if (r0) r0();
    return;
  }
  clearTimeout(noticeTimer);
  el.classList.remove('is-visible');
  setTimeout(() => {
    if (!noticeOpen) {
      el.hidden = true;
      el.innerHTML = '';
    }
  }, 200);
  noticeOpen = false;
  document.body.classList.remove('notice-open');
  const r = noticeResolver;
  noticeResolver = null;
  if (r) r();
}

/** Mostra un messaggio e mette in pausa finché l’utente non clicca «Ho capito» o fuori. */
function notice(text, type = '') {
  const msg = String(text ?? '').trim();
  if (!msg) return Promise.resolve();

  const el = $('phase-banner');
  if (!el) return Promise.resolve();

  // Chiude eventuale notice precedente
  if (noticeResolver) {
    const prev = noticeResolver;
    noticeResolver = null;
    prev();
  }

  return new Promise(resolve => {
    noticeResolver = resolve;
    noticeOpen = true;
    document.body.classList.add('notice-open');
    clearTimeout(noticeTimer);
    el.hidden = false;
    el.className = `phase-banner${type ? ' ' + type : ''}`;
    el.innerHTML =
      `<span class="phase-banner-text">${escape(msg)}</span>` +
      `<button type="button" class="phase-banner-ok" id="phase-banner-ok">Ho capito</button>`;
    void el.offsetWidth;
    el.classList.add('is-visible');

    const ok = $('phase-banner-ok');
    if (ok) ok.onclick = e => { e.stopPropagation(); dismissNotice(); };
    el.onclick = e => {
      // click sul banner (anche fuori dal bottone) chiude
      if (e.target === el || e.target.classList?.contains('phase-banner-text')) dismissNotice();
    };

    // Auto «Ho capito»: chiude da solo dopo una breve pausa (solo questi banner, non i dialoghi Mummia)
    if (isAutoNotice()) {
      noticeTimer = setTimeout(() => { dismissNotice(); }, 900);
    }
  });
}

function wireNoticeDismiss() {
  if (document.body.dataset.noticeWire) return;
  document.body.dataset.noticeWire = 'true';
  document.addEventListener('click', e => {
    if (!noticeOpen) return;
    // click ovunque fuori dai controlli del banner chiude
    const el = $('phase-banner');
    if (el && el.contains(e.target)) return; // gestito dal banner
    dismissNotice();
  }, true);
}

function fail(e) { console.error(e); notice(e instanceof Error ? e.message : 'Errore inatteso','error'); }
function close() {
  view = null;
  $('card-detail-overlay')?.classList.add('hidden');
  document.body.classList.remove('detail-open');
  // Su desktop l'anteprima resta sull'ultima carta vista; non la svuotiamo.
}
/** ID stabile di questo browser (per sessione unica cross-device). */
function getDeviceId() {
  const KEY = 'bellum:device-id';
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) || `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch (_) {
    return `dev-tmp-${Date.now()}`;
  }
}

/** Etichetta leggibile del device (non è un MAC: i browser non lo espongono). */
function getDeviceLabel() {
  try {
    const ua = navigator.userAgent || '';
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPod/i.test(ua)) return 'iPhone';
    if (/iPad/i.test(ua)) return 'iPad';
    if (/Mobile/i.test(ua)) return 'Cellulare';
    if (/Macintosh|Mac OS/i.test(ua)) return 'Mac';
    if (/Windows/i.test(ua)) return 'PC Windows';
    if (/Linux/i.test(ua)) return 'PC Linux';
    return 'Computer';
  } catch (_) {
    return 'Dispositivo';
  }
}

async function api(path,options={}) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessione scaduta, accedi di nuovo.');
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(),45000);
  try {
    const res = await fetch(`${API}${path}`,{
      method:options.method ?? 'GET',
      headers:{
        Authorization:`Bearer ${token}`,
        'X-Device-Id': getDeviceId(),
        ...(options.body !== undefined ? {'Content-Type':'application/json'} : {}),
      },
      body:options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal:abort.signal,cache:'no-store',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (json.code === 'session_replaced' || (res.status === 401 && /altro dispositivo|session_replaced|sostituita/i.test(String(json.error || '')))) {
        try { await signOut(); } catch (_) { /* ignore */ }
        try { showAuthScreen({ forceLoginForm: false }); } catch (_) { /* ignore */ }
        throw new Error('Hai effettuato l’accesso da un altro dispositivo. Qui devi accedere di nuovo.');
      }
      throw new Error(json.error ?? `HTTP ${res.status}`);
    }
    return json;
  } catch(e) {
    if (e?.name === 'AbortError') throw new Error('Render non risponde entro 45 secondi. Aggiorna prima di riprovare: la richiesta potrebbe essere stata salvata.');
    throw e;
  } finally { clearTimeout(timer); }
}

/** Sincronizza profilo server → localStorage (progressi + ultima partita). */
async function pullProfileFromServer() {
  try {
    const profile = await api('/me/profile');
    if (profile.story_progress && typeof profile.story_progress === 'object') {
      try { localStorage.setItem(STORY_KEY, JSON.stringify(profile.story_progress)); } catch (_) { /* ignore */ }
    }
    if (profile.last_match_id) {
      try { localStorage.setItem('bellum:last-match', String(profile.last_match_id)); } catch (_) { /* ignore */ }
    } else {
      try { localStorage.removeItem('bellum:last-match'); } catch (_) { /* ignore */ }
    }
    return profile;
  } catch (e) {
    console.warn('Profilo server non disponibile', e);
    return null;
  }
}

/** Claim device + pull profilo (dopo login / Sono io). */
async function claimDeviceAndSync() {
  try {
    await api('/me/claim-device', {
      method: 'POST',
      body: { deviceId: getDeviceId(), deviceLabel: getDeviceLabel() },
    });
  } catch (e) {
    console.warn('Claim device fallito', e);
  }
  return pullProfileFromServer();
}
// Le carte scadono dopo 5 minuti e a ogni nuova partita: una modifica dall'editor arriva ai giocatori
// senza ricaricare la pagina. Se il ricaricamento fallisce si usa la copia già in memoria.
const cardLoaded = new Map(), CARD_TTL = 5 * 60 * 1000;
async function card(id) {
  const fresh = cache.has(id) && Date.now() - (cardLoaded.get(id) ?? 0) < CARD_TTL;
  if (!fresh) {
    try { cache.set(id,(await api(`/cards/${encodeURIComponent(id)}`)).card); cardLoaded.set(id,Date.now()); }
    catch (error) { if (!cache.has(id)) throw error; }
  }
  return cache.get(id);
}
async function moveCost(cell) {
  for (const aura of cell?.auras ?? []) {
    const d = await card(aura.card_id);
    if (effects(d).some(e => e.type === 'movement_cost' && e.duration === 'while_attached' && e.target === 'enchanted_creature' && e.amount === 0)) return 0;
  }
  return 1;
}
function button(text,fn,disabled=false) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'primary-button'; b.textContent = text; b.disabled = disabled;
  b.onclick = () => Promise.resolve(fn()).catch(fail);
  return b;
}

/** Testo guida sotto la griglia durante la scelta bersaglio / attacco. */
function targetReminderText(cardDef) {
  const fx = cardDef ? (plainText(cardDef) || cardDef.name || 'effetto') : 'effetto';
  return `Stai attivando: «${fx}». Seleziona un bersaglio tra quelli evidenziati (bordo bianco).`;
}
function showTargetReminder(text) {
  const el = $('selection-instructions');
  if (!el) return;
  el.hidden = false;
  el.textContent = text || '';
}
function hideTargetReminder() {
  const el = $('selection-instructions');
  if (!el) return;
  el.hidden = true;
  el.textContent = '';
}

/**
 * Anteprima del permanente scelto come bersaglio → Conferma / Annulla.
 * Risolve true se confermato, false se annullato.
 */
function confirmTargetChoice(cell, cardDef, hint = '') {
  return new Promise(resolve => {
    let el = $('target-confirm-dialog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'target-confirm-dialog';
      el.className = 'card-detail-overlay';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.style.zIndex = '160';
      stageRoot().append(el);
    }
    el.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.cssText = 'width:min(92vw,360px);margin:auto;padding:1.1rem;text-align:center;border:1px solid #d5a758;box-shadow:0 12px 48px #000';
    const title = document.createElement('h2');
    title.style.cssText = 'margin:0 0 .5rem;font-size:1.15rem';
    title.textContent = 'Conferma bersaglio';
    const sub = document.createElement('p');
    sub.style.cssText = 'margin:0 0 .6rem;opacity:.9;line-height:1.4';
    const who = cell?.owner_index === 1 ? 'tua' : 'IA';
    const stats = isCreatureCell(cell)
      ? ` · ATK ${cell.attack} · HP ${cell.hp}`
      : (cell?.hp != null ? ` · PV ${cell.hp}` : '');
    sub.textContent = hint || `${cardDef?.name ?? 'Permanente'} (${who}${stats})`;
    const preview = document.createElement('div');
    preview.style.cssText = 'margin:.5rem auto;max-width:200px';
    if (cardDef) preview.innerHTML = cardHTML(cardDef, true);
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:.6rem;justify-content:center;flex-wrap:wrap;margin-top:.9rem';
    const done = (ok) => {
      el.classList.add('hidden');
      el.innerHTML = '';
      resolve(ok);
    };
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary-button';
    cancel.textContent = 'Annulla';
    cancel.onclick = () => done(false);
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'primary-button';
    confirm.textContent = 'Conferma';
    confirm.onclick = () => done(true);
    actions.append(cancel, confirm);
    panel.append(title, sub, preview, actions);
    el.append(panel);
    el.classList.remove('hidden');
  });
}
function overlay() {
  let el = $('card-detail-overlay');
  if (el) return el;
  el = document.createElement('div'); el.id = 'card-detail-overlay'; el.className = 'card-detail-overlay hidden';
  el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true');
  el.innerHTML = '<div class="detail-stage"><div class="detail-image" id="detail-image"></div><div class="detail-actions" id="detail-actions"></div></div>';
  el.onclick = e => { if (e.target === el) close(); };
  stageRoot().append(el); return el;
}
function reactionDialog() {
  let el = $('reaction-dialog');
  if (el) return el;
  el = document.createElement('div'); el.id = 'reaction-dialog'; el.className = 'card-detail-overlay hidden';
  el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true'); el.setAttribute('aria-label','Finestra reattiva');
  const stage = document.createElement('div'); stage.className = 'panel'; stage.style.cssText = 'width:min(94vw,720px);max-height:90dvh;overflow:auto;text-align:center;border-color:#d5a758;box-shadow:0 12px 48px #000';
  const title = document.createElement('h2'); title.id = 'reaction-title'; title.textContent = 'Finestra reattiva';
  const text = document.createElement('p'); text.id = 'reaction-description';
  const choices = document.createElement('div'); choices.id = 'reaction-choices'; choices.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap;justify-content:center;align-items:stretch;margin:.7rem 0';
  const actions = document.createElement('div'); actions.id = 'reaction-actions';
  stage.append(title,text,choices,actions); el.append(stage); stageRoot().append(el); return el;
}
function choiceDialog() {
  let el = $('death-choice-dialog');
  if (el) return el;
  el = document.createElement('div'); el.id = 'death-choice-dialog'; el.className = 'card-detail-overlay hidden';
  el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true'); el.setAttribute('aria-labelledby','death-choice-title');
  el.style.zIndex = '150';
  const panel = document.createElement('div'); panel.className = 'panel';
  panel.style.cssText = 'width:min(94vw,740px);max-height:90dvh;overflow:auto;text-align:center;border-color:#d5a758;box-shadow:0 12px 48px #000';
  const title = document.createElement('h2'); title.id = 'death-choice-title';
  const text = document.createElement('p'); text.id = 'death-choice-description';
  const choices = document.createElement('div'); choices.id = 'death-choice-options';
  choices.style.cssText = 'display:flex;gap:.6rem;flex-wrap:wrap;justify-content:center;margin:.8rem 0';
  const actions = document.createElement('div'); actions.id = 'death-choice-actions';
  panel.append(title,text,choices,actions); el.append(panel); stageRoot().append(el);
  // Nessun click sullo sfondo o Escape può annullare una scelta obbligatoria.
  return el;
}
async function renderDeathChoice() {
  const el = choiceDialog(), order = deathOrder(), selected = deathTarget();
  if (!state || state.status !== 'running' || busy || (!order && !selected)) { el.classList.add('hidden'); return; }
  close(); closeGraveyard(); reactionDialog().classList.add('hidden');
  const title = $('death-choice-title'), text = $('death-choice-description');
  const options = $('death-choice-options'), actions = $('death-choice-actions');
  options.replaceChildren(); actions.replaceChildren();
  if (order) {
    if (deathDraft.choiceId !== order.choice_id) deathDraft = {choiceId:order.choice_id,instanceIds:[]};
    const creatures = order.creatures ?? [], chosen = deathDraft.instanceIds;
    title.textContent = 'Ordine degli effetti alla morte';
    text.textContent = `Scegli la prossima creatura (${chosen.length + 1}/${creatures.length}). Gli effetti di ogni creatura restano nell’ordine scritto sulla carta.`;
    for (const source of creatures) {
      if (chosen.includes(source.instance_id)) continue;
      const d = await card(source.card_id);
      if (deathOrder()?.choice_id !== order.choice_id) return;
      const b = button(`${d.name} · ${source.owner_index === 1 ? 'tua' : 'IA'} · ${source.effect_indices?.length ?? 0} effetti`, async () => {
        if (busy || deathOrder()?.choice_id !== order.choice_id) return;
        deathDraft.instanceIds.push(source.instance_id);
        if (deathDraft.instanceIds.length === creatures.length) {
          const instanceIds = [...deathDraft.instanceIds];
          await request('death/order',{choiceId:order.choice_id,instanceIds},'Ordine degli effetti alla morte confermato.');
        } else await renderDeathChoice();
      });
      options.append(b);
    }
    if (chosen.length) actions.append(button('Ricomincia ordine',async () => {
      deathDraft = {choiceId:order.choice_id,instanceIds:[]}; await renderDeathChoice();
    }));
  } else if (selected) {
    deathDraft = {choiceId:null,instanceIds:[]};
    // ETB già confermato con «Ho capito»: non riaprire il dialog, resta la scelta sulla griglia.
    if (flow?.kind === 'etb-target' && flow.choiceId === selected.choice_id) {
      el.classList.add('hidden');
      return;
    }
    const d = await card(selected.task.card_id);
    if (deathTarget()?.choice_id !== selected.choice_id) return;
    const src = selected.task?.source;
    // on_play / terraforma / aura → scelta sulla griglia (creatura già in campo).
    // Solo on_death resta nel dialogo a lista, con testo corretto «alla morte».
    const useBoardPick = src === 'on_play' || src === 'terraforma_trigger' || src === 'aura_attack' || !src;
    if (useBoardPick) {
      el.classList.add('hidden');
      if (busy || deathTarget()?.choice_id !== selected.choice_id) return;
      flow = {
        kind: 'etb-target',
        choiceId: selected.choice_id,
        eligible: selected.eligible_instance_ids ?? [],
        sourceId: selected.task?.source_instance_id,
      };
      try { dismissNotice(); } catch (_) { /* ignore */ }
      await drawBoard();
      const sourceId = selected.task?.source_instance_id;
      if (sourceId) {
        for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
          const cell = at({ row, col });
          if (cell?.instance_id === sourceId) {
            const root = $('shared-board');
            const rowEl = root?.children?.[row];
            const btn = rowEl?.children?.[col];
            if (btn) {
              btn.classList.add('just-entered');
              btn.style.outline = '3px solid #2fe0c4';
              btn.style.boxShadow = '0 0 18px rgba(47,224,196,.55)';
            }
          }
        }
      }
      showTargetReminder(targetReminderText(d));
      return;
    } else {
      // Solo effetti davvero «alla morte»
      title.textContent = 'Bersaglio dell’effetto alla morte';
      text.textContent = `${d.name}: scegli il bersaglio dell’effetto alla morte.`;
      for (const instanceId of selected.eligible_instance_ids ?? []) {
        let found = null;
        for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
          const cell = at({row,col});
          if (cell?.kind === 'creature' && cell.instance_id === instanceId) found = {cell,row,col};
        }
        if (!found) continue;
        const targetCard = await card(found.cell.card_id);
        if (deathTarget()?.choice_id !== selected.choice_id) return;
        const b = button(`${targetCard.name} · ${found.cell.owner_index === 1 ? 'tua' : 'IA'} · [${found.row},${found.col}] · HP ${found.cell.hp}`,() => {
          if (busy || deathTarget()?.choice_id !== selected.choice_id) return;
          return request('death/target',{choiceId:selected.choice_id,targetInstanceId:instanceId},'Effetto alla morte risolto.');
        });
        options.append(b);
      }
      if ((selected.eligible_instance_ids ?? []).includes(AI_TARGET)) {
        options.append(button(`${opponentDisplayName()} · PV ${them()?.life ?? '?'}`,() => {
          if (busy || deathTarget()?.choice_id !== selected.choice_id) return;
          return request('death/target',{choiceId:selected.choice_id,targetInstanceId:AI_TARGET},'Effetto risolto.');
        }));
      }
      if (!options.childElementCount) text.textContent = 'Nessun bersaglio visibile: aggiorna la partita per recuperare lo stato.';
    }
  }
  el.classList.remove('hidden');
}
function reactionDescription(e) {
  const names = {
    upkeep_start:'Inizia il MANATENIMENTO avversario, prima di mana, risveglio e pesca.',
    upkeep_end:'Il MANATENIMENTO avversario sta terminando, prima della fase principale.',
    hand_card:'L’avversario ha dichiarato una carta dalla mano.',
    move:'L’avversario ha dichiarato un movimento.',attack:'L’avversario ha dichiarato un attacco.',
    mostrissimo_sacrifice:'L’avversario ha dichiarato un sacrificio.',
    mostrissimo_before_entry:'Il Mostrissimo ha pagato i sacrifici e sta per entrare nella cella scelta.',
    monster_etb:'Sta per risolversi un effetto all’entrata di una creatura avversaria.',
  };
  return names[e?.kind] ?? 'L’avversario ha dichiarato un’azione.';
}
// Il popup non modifica lo stato: la richiesta /advance parte solo dopo
// che il checkpoint server-side è stato presentato per un secondo.
function presentationLayer() {
  let layer = $('public-checkpoint-layer');
  if (layer) return layer;
  layer = document.createElement('div'); layer.id = 'public-checkpoint-layer';
  Object.assign(layer.style,{position:'absolute',inset:'0',zIndex:'200',display:'none',
    alignItems:'center',justifyContent:'center',background:'rgba(5,6,18,.78)',
    padding:'1.2rem',boxSizing:'border-box',pointerEvents:'auto'});
  stageRoot().append(layer); return layer;
}
/** Testo annuncio pubblico senza dump tecnici (UUID, monster_etb, [3e]). */
function humanizePublicText(a) {
  let t = String(a?.text ?? '');
  t = t.replace(/\[3e\]\s*/gi, '');
  t = t.replace(/\([^)]*fonte[^)]*\)/gi, '');
  t = t.replace(/monster_etb/gi, "effetto all’entrata");
  t = t.replace(/mostrissimo_before_entry/gi, 'ingresso del Mostrissimo');
  t = t.replace(/upkeep_start/gi, 'inizio manatenimento');
  t = t.replace(/upkeep_end/gi, 'fine manatenimento');
  t = t.replace(/hand_card/gi, 'carta dalla mano');
  t = t.replace(/;\s*evento da riprendere dopo gli effetti\.?/gi, '');
  t = t.replace(/;\s*evento contrastato\.?/gi, ' — effetto annullato');
  t = t.replace(/\s+/g, ' ').trim();
  // Se resta solo rumore e c'è una carta, titolo generico.
  if ((!t || t.length < 3) && a?.kind === 'card') {
    const who = a.actor === 0 ? opponentDisplayName() : a.actor === 1 ? 'Tu' : 'Qualcuno';
    return `${who} gioca una carta.`;
  }
  return t;
}

/** Mostra il popup di fase a ogni cambio turno/fase/giocatore, anche senza eventi. */
/** Popup di fase (Manatenimento / Svolgimento / Chiusura). */
async function presentPhase(phase, actor, turn, maxMana) {
  if (!state || state.status !== 'running') return;
  const ph = phase === 'main' ? 'main' : phase === 'end' ? 'end' : 'upkeep';
  await presentPublic({
    kind: 'phase',
    phase: ph,
    actor,
    turn: turn ?? state.current_turn ?? 1,
    max_mana: maxMana ?? state.players?.[actor]?.max_mana ?? 0,
    text: '',
  }, presentationGeneration);
}

/**
 * Scandisce le fasi richieste in ordine.
 * Ogni turno: manatenimento → svolgimento → (in fine turno) chiusura.
 */
async function scanPhases(phases, actor = null, turn = null) {
  if (!state || state.status !== 'running') return;
  const who = actor ?? state.active_player_index;
  const tnum = turn ?? state.current_turn ?? 1;
  const max = state.players?.[who]?.max_mana ?? 0;
  for (const phase of phases) {
    await presentPhase(phase, who, tnum, max);
  }
}

/** Allinea il banner alla fase corrente del motore (senza saltare se già mostrata). */
async function ensurePhaseBanner() {
  if (!state || state.status !== 'running') return;
  const phase = state.phase === 'main' ? 'main' : state.phase === 'end' ? 'end' : 'upkeep';
  await presentPhase(phase, state.active_player_index, state.current_turn ?? 1, state.players?.[state.active_player_index]?.max_mana ?? 0);
}

async function presentPublic(a, generation) {
  if (a?.kind === 'phase') {
    const ph = a.phase === 'main' ? 'main' : a.phase === 'end' ? 'end' : 'upkeep';
    const key = `${a.turn ?? state?.current_turn ?? 1}|${a.actor ?? state?.active_player_index}|${ph}`;
    if (key === lastPhaseKey) return; // già scandita
    lastPhaseKey = key;
  }
  const layer = presentationLayer(); layer.replaceChildren();
  const panel = document.createElement('div');
  Object.assign(panel.style,{width:'100%',maxHeight:'100%',overflowY:'auto',
    background:'#171426',color:'#f7eedc',border:'2px solid #a78355',borderRadius:'14px',
    padding:'1.2rem',boxShadow:'0 15px 60px #000',textAlign:'center',fontSize:'1.15rem',
    display:'flex',flexDirection:'column',alignItems:'center',gap:'12px'});
  const title = document.createElement('div');
  if (a.kind === 'phase') {
    const phaseName = a.phase === 'upkeep' ? 'MANATENIMENTO'
      : a.phase === 'main' ? 'SVOLGIMENTO'
      : a.phase === 'end' ? 'CHIUSURA' : 'INIZIO';
    let who = '—';
    if (a.actor === 0) who = opponentDisplayName();
    else if (a.actor === 1) {
      try { who = usernameFromEmail((await getCurrentUser())?.email) || 'Tu'; }
      catch { who = 'Tu'; }
    }
    title.style.cssText = 'text-align:center;line-height:1.55;font-family:"Nunito",system-ui,sans-serif;font-weight:800;letter-spacing:.02em';
    title.innerHTML =
      `TURNO: <strong>${a.turn ?? '—'}</strong><br>` +
      `GIOCATORE ATTIVO: <strong>${escape(who)}</strong><br>` +
      `FASE ATTUALE: <strong>${phaseName}</strong><br>` +
      `MANA MAX: <strong>${a.max_mana ?? 0}</strong>`;
  } else {
    title.textContent = humanizePublicText(a);
  }
  panel.append(title);
  if (a.kind === 'card' && a.card_id) {
    try { const d = await card(a.card_id); if (generation !== presentationGeneration) return;
      const box = document.createElement('div'); box.style.margin = '14px auto';
      box.innerHTML = cardHTML(d); panel.append(box);
    } catch(e) { console.warn('Anteprima della carta non disponibile',e); }
  }
  if (a.kind !== 'phase' && a.position) {
    const cell = document.createElement('div'); cell.textContent = `Cella [${a.position.row},${a.position.col}]`;
    panel.append(cell);
  }
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.textContent = 'Ho capito';
  ok.className = 'phase-banner-ok';
  Object.assign(ok.style,{
    minHeight:'44px',padding:'0 20px',cursor:'pointer',
    border:'3px solid #8a5a14',borderRadius:'14px',
    background:'linear-gradient(180deg,#e8c565,#e0a22a)',color:'#4a1f08',
    fontFamily:"'Lilita One', Georgia, serif",fontSize:'1.05rem'
  });
  panel.append(ok);
  layer.append(panel); layer.style.display = 'flex';
  document.body.classList.add('notice-open');
  // Pausa finché l’utente non conferma (bottone o click sullo sfondo del layer).
  // Se «Auto Ho capito» è attivo, chiude da solo dopo una breve pausa.
  await new Promise(resolve => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(autoTimer);
      if (generation !== presentationGeneration) { resolve(); return; }
      layer.style.display = 'none';
      layer.replaceChildren();
      document.body.classList.remove('notice-open');
      layer.onclick = null;
      resolve();
    };
    let autoTimer = null;
    ok.onclick = e => { e.stopPropagation(); done(); };
    layer.onclick = e => { if (e.target === layer) done(); };
    if (isAutoNotice()) {
      autoTimer = setTimeout(done, 900);
    }
  });
}
// Passo 3: ogni risultato pubblico ha il suo balloon (state.public_announcements, in ordine); /advance usa
// sempre l'ID dell'ultimo (state.public_announcement). Dopo refresh/recupero (onlyLast) si ripresenta solo l'ultimo.
function queuePresentation(onlyLast = false) {
  if (presentationRunning || !matchId || !state?.public_announcement) return;
  const generation = presentationGeneration;
  presentationRunning = true;
  let replay = onlyLast;
  void (async () => {
    try {
      while (generation === presentationGeneration && matchId && state?.public_announcement) {
        const a = state.public_announcement, id = matchId;
        const list = !replay && Array.isArray(state.public_announcements) && state.public_announcements.length > 1 ? state.public_announcements : [a];
        replay = false;
        for (let i = 0; i < list.length; i++) {
          await presentPublic(list[i],generation);
          if (generation !== presentationGeneration || matchId !== id) break;
          if (i < list.length - 1) await waitPresentation(180); // breve stacco: i balloon restano distinti
        }
        if (generation !== presentationGeneration || matchId !== id) break;

        // Partita finita durante il turno IA (es. sconfitta) → gestisci subito
        if (state.status === 'finished') {
          await handleMatchFinished();
          break;
        }

        if (state.status !== 'running' || state.pending_reaction || obligatory() || !state.work_queue?.length) break;
        busy = true; controls();
        try {
          state = (await api(`/match/${encodeURIComponent(id)}/advance`,
            {method:'POST',body:{expectedAnnouncementId:a.id}})).state;
          await render(); await logs();
          await ensurePhaseBanner().catch(fail);
          // Controlla di nuovo dopo advance (l’IA può averti ucciso)
          if (state.status === 'finished') {
            await handleMatchFinished();
            break;
          }
        } catch(e) {
          fail(e);
          try { state = (await api(`/match/${encodeURIComponent(id)}`)).state; await render(); } catch(refreshError) { console.warn(refreshError); }
          if (state?.status === 'finished') {
            await handleMatchFinished();
          }
          break;
        } finally { busy = false; await render().catch(fail); }
        if (state?.public_announcement?.id === a.id) break;
      }
    } finally { presentationRunning = false; }
  })();
}

/** Pulisce completamente la UI della partita (griglia, mani, overlay) senza toccare i progressi Storia. */
function clearMatchUI() {
  try { localStorage.removeItem('bellum:last-match'); } catch (_) { /* ignore */ }
  void api('/me/profile', { method: 'PUT', body: { last_match_id: null } }).catch(() => { /* ignore */ });
  matchId = null;
  state = null;
  flow = null;
  priorMatch = null;
  deathDraft = { choiceId: null, instanceIds: [] };
  busy = false; // importante: sblocca newMatch dopo una vittoria
  presentationGeneration++;
  try { presentationLayer().style.display = 'none'; } catch (_) { /* ignore */ }
  close();
  closeGraveyard();
  closeColorDialog();
  hideStoryStart();
  try { reactionDialog()?.classList.add('hidden'); } catch (_) { /* ignore */ }
  try { choiceDialog()?.classList.add('hidden'); } catch (_) { /* ignore */ }
  const medBanner = $('story-medallion-banner');
  if (medBanner) medBanner.classList.add('hidden');
  const storyProg = $('story-progress-badge');
  if (storyProg) storyProg.classList.add('hidden');
  $('player-medallion')?.classList.add('hidden');
  $('opponent-medallion')?.classList.add('hidden');
  // Svuota la griglia e la mano IA così non resta la partita vecchia a video
  const board = $('shared-board');
  if (board) board.innerHTML = '';
  const oppHand = $('opponent-hand');
  if (oppHand) oppHand.replaceChildren();
  const offer = $('offer-slot');
  if (offer) offer.innerHTML = '';
  // Reset HUD vita/mazzo (verranno aggiornati alla prossima partita)
  for (const id of ['opponent-life', 'player-life', 'opponent-deck-count', 'player-deck-count', 'opponent-graveyard-count', 'player-graveyard-count']) {
    const n = $(id);
    if (n) n.textContent = '–';
  }
}

/** Gestisce fine partita (vittoria o sconfitta) da qualsiasi punto del flusso. */
async function handleMatchFinished() {
  if (!state || state.status !== 'finished') return;
  const won = state.winner_index === 1;

  try { dismissNotice(); } catch (_) { /* ignore */ }
  await notice(won ? 'HAI VINTO!' : 'HAI PERSO!', won ? 'success' : 'error');

  if (won && currentMode === 'story') {
    await handleStoryVictory();
    return;
  }

  if (!won) {
    const wasStory = currentMode === 'story';
    clearMatchUI();
    hideHome();

    if (wasStory) {
      clearStoryProgress();
    }

    try { dismissNotice(); } catch (_) { /* ignore */ }
    showAuthScreen({ forceLoginForm: false });
  }
}
async function renderReaction() {
  const el = reactionDialog(), r = reaction();
  if (!r || busy || obligatory() || flow?.kind === 'trap-target') { el.classList.add('hidden'); return; }
  $('reaction-title').textContent = r.event?.kind === 'monster_etb' || r.event?.kind === 'mostrissimo_before_entry' ? 'Finestra NOPE / Trappola' : 'Finestra Trappola';
  const evt = r.event;
  let declared = '';
  if (evt?.card_id) {
    try { const d = await card(evt.card_id);
      declared = ` Carta: ${d.name}. Costo ${d.card_type === 'mostrissimo' ? d.sacrifice_cost + ' sacrifici' : d.mana_cost + ' mana'}. ${d.effect_text ?? ''}`;
    } catch(e) { console.warn(e); }
  }
  const position = evt?.options?.position ?? evt?.position;
  $('reaction-description').textContent = reactionDescription(evt) + declared
    + (position ? ` Cella [${position.row},${position.col}].` : '');
  const choices = $('reaction-choices'); choices.replaceChildren();
  for (const instId of r.eligible_instance_ids ?? []) {
    const inst = me()?.hand?.find(x => x.instance_id === instId);
    if (!inst) continue;
    const d = await card(inst.card_id);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'hand-card reaction-card';
    b.dataset.instanceId = inst.instance_id; b.dataset.cardId = d.id; b.innerHTML = handCardHTML(d);
    b.setAttribute('aria-label',`Gioca ${d.name} in risposta`);
    b.onclick = () => beginTrap(inst,d).catch(fail); choices.append(b);
  }
  const actions = $('reaction-actions'); actions.replaceChildren();
  actions.append(button('Passa',() => chooseTrap({windowId:r.window_id,action:'pass'})));
  el.classList.remove('hidden');
}
async function chooseTrap(choice) {
  const r = reaction();
  if (!r || r.window_id !== choice.windowId) return notice('Finestra scaduta: aggiorna la partita.','error');
  return request('trap/choice',choice,choice.action === 'pass' ? 'Hai passato la priorità.' : 'Trappola risolta.');
}
async function beginTrap(inst,d) {
  const r = reaction();
  if (!r || !r.eligible_instance_ids.includes(inst.instance_id) || busy) return;
  if (targetEffect(d)) {
    flow = {kind:'trap-target',windowId:r.window_id,instanceId:inst.instance_id,id:d.id};
    reactionDialog().classList.add('hidden');
    await render(); notice(r.event?.kind === 'monster_etb' ? 'Scegli la creatura che ha generato l’effetto all’entrata.' : `Scegli il bersaglio di ${d.name}${playerTargetEffect(d) ? ' (tocca i PV dell’IA per colpire il giocatore)' : ''}.`, 'success'); return;
  }
  await chooseTrap({windowId:r.window_id,action:'play',cardInstanceId:inst.instance_id});
}
function graveyardDialog() {
  let el = $('graveyard-dialog');
  if (el) return el;
  el = document.createElement('div'); el.id = 'graveyard-dialog'; el.className = 'card-detail-overlay hidden';
  el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true'); el.setAttribute('aria-labelledby','graveyard-title'); el.style.zIndex = '120';
  const panel = document.createElement('div'); panel.className = 'panel'; panel.style.cssText = 'width:min(94vw,720px);max-height:88dvh;overflow:auto;border-color:#c6a774;text-align:center;box-shadow:0 12px 48px #000';
  const title = document.createElement('h2'); title.id = 'graveyard-title';
  const list = document.createElement('div'); list.id = 'graveyard-cards'; list.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;gap:.55rem;margin:.7rem 0;max-height:60dvh;overflow:auto';
  const actions = document.createElement('div'); actions.style.cssText = 'display:flex;justify-content:center'; actions.append(button('Chiudi',closeGraveyard));
  panel.append(title,list,actions); el.append(panel);
  el.addEventListener('click',e => { if (e.target === el) closeGraveyard(); });
  stageRoot().append(el); return el;
}
function closeGraveyard() { $('graveyard-dialog')?.classList.add('hidden'); }
async function openGraveyard(owner) {
  if ((owner !== 0 && owner !== 1) || !state || busy || obligatory()) return;
  const el = graveyardDialog(), title = $('graveyard-title'), list = $('graveyard-cards');
  const cards = state.players?.[owner]?.graveyard ?? [];
  title.textContent = `${owner === 1 ? 'Il tuo cimitero' : 'Cimitero dell’IA'} · ${cards.length}`;
  list.replaceChildren();
  if (!cards.length) { const empty = document.createElement('p'); empty.textContent = 'Cimitero vuoto.'; list.append(empty); }
  else for (const inst of cards) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'hand-card grave-card';
    try {
      const d = await card(inst.card_id); b.innerHTML = handCardHTML(d);
      b.setAttribute('aria-label',`Apri ${d.name} nel cimitero`);
      b.onclick = () => { closeGraveyard(); inspect('grave',inst.card_id).catch(fail); };
    } catch (error) { b.textContent = 'Carta non caricabile'; b.disabled = true; console.warn(error); }
    list.append(b);
  }
  el.classList.remove('hidden');
}
function wireGraveyards() {
  for (const [id,owner] of [['opponent-graveyard-count',0],['player-graveyard-count',1]]) {
    const box = $(id)?.closest('.hud-value.grave');
    if (!box || box.dataset.graveyardReady) continue;
    box.dataset.graveyardReady = 'true'; box.setAttribute('role','button'); box.setAttribute('tabindex','0');
    box.setAttribute('aria-label',`Apri ${owner === 1 ? 'il tuo cimitero' : 'il cimitero dell’IA'}`);
    box.style.cursor = 'pointer'; box.addEventListener('click',() => openGraveyard(owner).catch(fail));
    box.addEventListener('keydown',e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGraveyard(owner).catch(fail); } });
  }
  const life = $('opponent-life')?.closest('.hud-value');
  if (life && !life.dataset.playerTargetReady) { life.dataset.playerTargetReady = 'true'; life.addEventListener('click',() => playerClick().catch(fail)); }
}
function updateCardPreview(d, cell = null) {
  const empty = $('card-preview-empty');
  const slot = $('card-preview-card');
  if (!empty || !slot) return;
  if (!d) {
    empty.classList.remove('hidden');
    slot.classList.add('hidden');
    slot.innerHTML = '';
    slot.setAttribute('aria-hidden', 'true');
    return;
  }
  const f = faction(d);
  const isMostrissimo = d.card_type === 'mostrissimo';
  const costNum = isMostrissimo ? Number(d.sacrifice_cost ?? 0) : Number(d.mana_cost ?? 0);
  const costIcon = isMostrissimo ? '✦' : '';
  const atk = cell?.attack ?? d.attack ?? 0;
  const hp = cell?.hp ?? d.hp ?? 0;
  const subtype = d.subtype ? String(d.subtype) : '';
  const factionLabel = deckFactionNames[f.toUpperCase()] || f.toUpperCase();
  const typeLabel = types[d.card_type] ?? d.card_type;
  const rules = escape(String(d.effect_text || 'Nessun effetto.').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim());
  const art = d.image_url
    ? `<img src="${escape(d.image_url)}" alt="">`
    : 'Illustrazione provvisoria';
  const showStats = creature(d) || (cell?.kind === 'terraforma' && cell?.hp !== undefined);
  slot.className = `card-preview-card faction-${f}`;
  slot.innerHTML = `
    <div class="cp-nameband">${escape(d.name)}</div>
    <div class="cp-art">${art}</div>
    <div class="cp-type">${escape(typeLabel)}${subtype ? ' · ' + escape(subtype) : ''} · ${escape(factionLabel)}</div>
    <div class="cp-rules">${rules}</div>
    <div class="cp-cost">${costIcon}${costNum}</div>
    ${showStats ? `<div class="cp-atk">${atk}</div><div class="cp-hp">${hp}</div>` : ''}`;
  empty.classList.add('hidden');
  slot.classList.remove('hidden');
  slot.setAttribute('aria-hidden', 'false');
}
async function inspect(kind,id,extra={}) {
  if (busy || noticeOpen || obligatory() || (reaction() && kind !== 'grave')) return;
  view = {kind,id,...extra};
  const current = view, d = await card(id);
  if (current !== view) return;
  updateCardPreview(d, current.cell ?? null);
  overlay(); $('detail-image').innerHTML = cardHTML(d,false,current.cell ?? null);
  const bar = $('detail-actions'); bar.replaceChildren();
  const add = (text,fn,disabled=false) => bar.append(button(text,fn,disabled));
  if (kind === 'hand' && active()) add(d.card_type === 'monster' ? 'Evoca' : d.card_type === 'terraforma' ? 'Colloca' : 'Gioca',() => beginCard(current.instanceId,d),!playable(d));
  if (kind === 'mostrissimo' && active() && state.last_mostrissimo_turn?.[1] !== state.current_turn) {
    const cost = Number(d.sacrifice_cost), own = board().flat().filter(c => isCreatureCell(c) && c.owner_index === 1).length;
    const legal = Number.isInteger(cost) && cost >= 0 && cost <= 6 && permanents().length >= cost && (board()[2].some(c => !c) || (cost > 0 && own > 0));
    add(`Evoca · ${cost} sacrifici`,() => request('mostrissimo/start',{cardId:id},'Evocazione iniziata: non puoi annullare.'),!legal);
  }
  if (kind === 'unit' && active() && isCreatureCell(current.cell) && current.cell.owner_index === 1 && !current.cell.tired) {
    const direct = foes(current.position).length === 0;
    const foeName = opponentDisplayName();
    add(direct ? `Attacca ${foeName}` : 'Attacca',() => {
      if (direct) return request('attack',{attackerPosition:current.position,target:{type:'player',playerIndex:0}},'Attacco dichiarato.');
      flow = {kind:'attack',from:current.position}; close(); render().catch(fail);
      showTargetReminder('Seleziona un nemico evidenziato (bordo bianco) per attaccare.');
    });
    if (direct && attackable(current.position).length) add('Attacca Terraforma',() => {
      flow = {kind:'attack',from:current.position}; close(); render().catch(fail);
      showTargetReminder('Seleziona la Terraforma nemica evidenziata (bordo bianco).');
    });
    const cost = await moveCost(current.cell);
    if (current !== view) return;
    add(`Muovi · ${cost} mana`,() => { flow = {kind:'move',from:current.position}; close(); render().catch(fail); notice('Tocca una cella libera adiacente.','success'); },Number(me()?.current_mana ?? 0) < cost || !steps(current.position).length);
  }
  if (kind === 'unit' && isCreatureCell(current.cell) && current.cell.auras?.length) {
    for (const aura of current.cell.auras) {
      const a = await card(aura.card_id);
      if (current !== view) return;
      add(`Aura ${a.name}${aura.owner_index === 1 ? ' · tua' : ' · IA'}`,() => { close(); return inspect('aura',aura.card_id,{instanceId:aura.instance_id}); });
    }
  }
  if (kind === 'tribute' && pending() && pending().stage === 'paying' && pending().paid.length < pending().required) {
    // Avviso se sacrifichi un mostro con una tua aura addosso
    const cell = current.cell || findCellByInstanceId(current.instanceId);
    const ownAuras = (cell?.auras || []).filter(a => a.owner_index === 1);
    if (isCreatureCell(cell) && ownAuras.length > 0) {
      add('Conferma sacrificio', async () => {
        const ok = window.confirm('Attenzione: stai sacrificando un mostro che ha una tua aura addosso. Sei sicuro di voler sacrificare il mostro e non l’aura?');
        if (!ok) return;
        return request('mostrissimo/sacrifice',{instanceId:current.instanceId},'Sacrificio dichiarato.');
      });
    } else {
      add('Conferma sacrificio',() => request('mostrissimo/sacrifice',{instanceId:current.instanceId},'Sacrificio dichiarato.'));
    }
  }
  add('Chiudi',close);
  $('card-detail-overlay').classList.remove('hidden'); document.body.classList.add('detail-open');
}

function findCellByInstanceId(instanceId) {
  if (!instanceId) return null;
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const cell = at({ row, col });
    if (cell?.instance_id === instanceId) return cell;
  }
  return null;
}
async function beginCard(instanceId,d) {
  if (!playable(d)) return;
  close(); flow = {kind:'hand',instanceId,id:d.id,step:(d.card_type === 'monster' || d.card_type === 'terraforma') ? 'cell' : (d.card_type === 'aura' || targetEffect(d)) ? 'target' : 'immediate'};
  if (flow.step === 'immediate') return request('play-card',{cardInstanceId:instanceId,options:{}},'Carta dichiarata.');
  await render(); notice(flow.step === 'cell' ? 'Scegli una cella libera della tua riga.' : 'Scegli una creatura bersaglio.','success');
}
function playable(d) {
  if (!active() || d.card_type === 'mostrissimo' || d.card_type === 'instant' || effectiveManaCost(d) > me().current_mana) return false;
  if ((d.card_type === 'monster' || d.card_type === 'terraforma') && !board()[2].some(c => !c)) return false;
  if (d.card_type === 'aura' && !targets(d).length) return false;
  if (!creature(d) && d.card_type !== 'aura' && targetEffect(d) && !hasTargets(d)) return false;
  return true;
}
/** Troppo cara rispetto al mana massimo del turno (bende mummia). Vale anche per trappole/instant. */
function tooExpensive(d) {
  if (!d || d.card_type === 'mostrissimo') return false;
  return effectiveManaCost(d) > Number(me()?.max_mana ?? 0);
}
async function drawBoard() {
  const root = $('shared-board'); if (!root) return;
  root.replaceChildren();
  const p = pending(), legal = p?.stage === 'paying' && p.paid.length === p.required ? summonCells(p) : [];
  const d = flow?.id ? cache.get(flow.id) : null;
  for (let row = 0; row < 3; row++) {
    const line = document.createElement('div'); line.className = `board-row ${['ai-row','center-row','human-row'][row]}`;
    for (let col = 0; col < 3; col++) {
      const pos = {row,col}, c = at(pos), b = document.createElement('button');
      b.type = 'button'; b.className = 'board-cell';
      if (row === 1 && col === 1) b.classList.add('center-cell');
      let definition = null;
      if (c) try { definition = await card(c.card_id); } catch(e) { console.warn(e); }
      b.classList.add(c ? c.owner_index === 1 ? 'human-card' : 'ai-card' : 'empty');
      if (c?.kind === 'terraforma') b.classList.add('terraforma-cell');
      if (isCreatureCell(c) && c.tired) b.classList.add('tired');
      if (flow?.kind === 'move' && steps(flow.from).some(x => eq(x,pos))) b.classList.add('valid-move');
      if (flow?.kind === 'attack' && attackable(flow.from).some(x => eq(x,pos))) b.classList.add('valid-target');
      if (flow?.kind === 'hand' && flow.step === 'cell' && row === 2 && !c) b.classList.add('valid-summon');
      if (flow?.kind === 'hand' && flow.step === 'target' && flow.position && eq(flow.position, pos) && !c) b.classList.add('valid-target');
      if (flow?.kind === 'mostrissimo-target' && flow.position && eq(flow.position, pos) && !c) b.classList.add('valid-target');
      if (flow?.kind === 'etb-target' && c && (flow.eligible ?? []).includes(c.instance_id)) b.classList.add('valid-target');
      if (['hand','mostrissimo-target','trap-target'].includes(flow?.kind) && (flow?.step === 'target' || flow?.kind !== 'hand') && d && targetAllowed(d,c,flow?.kind === 'trap-target' ? reaction()?.event : null)) b.classList.add('valid-target');
      if (legal.some(x => eq(x,pos))) b.classList.add('valid-summon');
      b.setAttribute('aria-label',c ? `${definition?.name ?? 'Permanente'} ${c.owner_index === 1 ? 'Tu' : 'IA'}${isCreatureCell(c) ? ` ATK ${c.attack} HP ${c.hp}` : `, Terraforma${c.hp !== undefined ? `, PV ${c.hp}` : ' non attaccabile'}`}${isCreatureCell(c) && c.auras?.length ? `, ${c.auras.length} Aura` : ''}` : `Cella [${row},${col}]`);
      const altar = (row === 1 && col === 1)
        ? `<svg class="altar-svg" aria-hidden="true" width="68" height="96" viewBox="0 0 68 100"><path d="M10 20Q22 8 34 16Q46 8 58 20" fill="none" stroke="#c9a043" stroke-width="2" stroke-linecap="round"/><circle cx="34" cy="14" r="6.5" fill="#e8c565"/><path d="M21 36Q34 26 47 36Q34 46 21 36Z" fill="#0b0806" stroke="#e8c565" stroke-width="1.6"/><circle cx="34" cy="36" r="3.4" fill="#2fe0c4"/><path d="M28 43Q27 49 22 51M34 45V51" fill="none" stroke="#e8c565" stroke-width="1.6" stroke-linecap="round"/><g class="flame"><path d="M34 52Q26 60 30 68Q32 64 33 62Q34 66 37 69Q43 61 34 52Z" fill="#2fe0c4"/><path d="M34 60Q31 64 33 68Q35 66 34 60Z" fill="#e8f9f5"/></g><path d="M24 70h20l-2 6H26Z" fill="#3a2e22" stroke="#c9a043" stroke-width="1.5"/><rect x="18" y="76" width="32" height="8" fill="#3a2e22" stroke="#c9a043" stroke-width="1.5"/><rect x="12" y="84" width="44" height="9" fill="#2a2016" stroke="#c9a043" stroke-width="1.5"/></svg>`
        : '';
      b.innerHTML = altar + (c && definition ? cellHTML(definition,c) + (isCreatureCell(c) && c.auras?.length ? `<span class="cell-aura-count" title="Aure assegnate">✧ ${c.auras.length}</span>` : '') + `<span class="cell-coordinate">[${row},${col}]</span>` : '');
      // Durante etb-target le celle eleggibili restano cliccabili anche se obligatory.
      const etbPick = flow?.kind === 'etb-target' && c && (flow.eligible ?? []).includes(c.instance_id);
      b.disabled = busy || (obligatory() && !etbPick);
      b.onclick = () => boardClick(pos).catch(fail); line.append(b);
    }
    root.append(line);
  }
}
async function drawHand() {
  const root = $('player-hand'); if (!root) return;
  root.replaceChildren();
  const hand = me()?.hand ?? [], g = handGeometry(hand.length);
  root.style.setProperty('--hw',String(g.w)); root.style.setProperty('--hh',String(g.h)); root.style.setProperty('--hs',g.step.toFixed(2));
  root.style.setProperty('--hr',g.rot.toFixed(2)); root.style.setProperty('--hk',g.k.toFixed(3)); root.style.setProperty('--hd',g.drop.toFixed(2));
  let index = 0;
  for (const inst of hand) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'hand-card';
    b.style.setProperty('--t',(index - (hand.length - 1) / 2).toFixed(3)); b.style.setProperty('--i',String(index + 1)); index++;
    try {
      const d = await card(inst.card_id); b.innerHTML = handCardHTML(d);
      b.disabled = !state || busy || !!reaction() || obligatory();
      // Stati visivi: playable = alzata + cornice lampeggiante; too-expensive = sole bende.
      if (playable(d)) b.classList.add('playable');
      else if (tooExpensive(d)) b.classList.add('too-expensive');
      b.setAttribute('aria-label',`Apri ${d.name}${playable(d) ? ', giocabile' : tooExpensive(d) ? ', troppo costosa' : ''}`);
      b.onclick = () => inspect('hand',inst.card_id,{instanceId:inst.instance_id});
    } catch(e) { b.textContent = 'Carta non caricabile'; b.disabled = true; console.warn(e); }
    root.append(b);
  }
}
async function drawMostrissimi() {
  let panel = $('mostrissimo-panel');
  if (!panel) {
    panel = document.createElement('section'); panel.id = 'mostrissimo-panel'; panel.className = 'panel'; panel.setAttribute('aria-label','Offerta Mostrissimi');
    const slot = $('offer-slot'), before = document.querySelector('.logs-panel');
    if (slot) slot.append(panel); else if (before?.parentNode) before.parentNode.insertBefore(panel,before); else document.body.append(panel);
  }
  panel.replaceChildren();
  if (!state) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const p = pending();
  // Durante i sacrifici: sostituisci l'offerta con un pannello chiaro di progresso
  if (p && p.stage === 'paying') {
    const h = document.createElement('h2');
    h.textContent = 'Sacrifici per il Mostrissimo';
    panel.append(h);
    const info = document.createElement('p');
    info.className = 'tribute-progress';
    info.style.cssText = 'font-size:1.05rem;line-height:1.45;margin:.4rem 0 .8rem';
    info.innerHTML = p.paid.length < p.required
      ? `Sacrifici <strong>${p.paid.length}/${p.required}</strong>.<br>Tocca un <strong>tuo permanente</strong> sul campo per sacrificarlo.<br><em>Non puoi annullare.</em>`
      : `Sacrifici completi (${p.paid.length}/${p.required}).<br>Tocca una <strong>cella libera evidenziata</strong> per evocare.`;
    panel.append(info);
    if (p.paid.length < p.required && !reaction() && !obligatory()) {
      const list = document.createElement('div');
      list.className = 'tribute-list';
      list.style.cssText = 'display:flex;flex-direction:column;gap:.35rem;';
      for (const item of permanents()) {
        const d = await card(item.card_id);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'secondary-button';
        b.style.cssText = 'width:100%;text-align:left';
        const cell = findCellByInstanceId(item.id);
        const auraCount = (cell?.auras || []).filter(a => a.owner_index === 1).length;
        b.textContent = `${item.type}: ${d.name}${auraCount ? ` · ${auraCount} aura` : ''}`;
        b.disabled = busy;
        b.onclick = () => {
          if (noticeOpen) return;
          // passa anche la cella per il controllo aure
          inspect('tribute', item.card_id, { instanceId: item.id, cell });
        };
        list.append(b);
      }
      panel.append(list);
    }
    return;
  }

  // Offerta normale (nessuna evocazione in corso)
  const h = document.createElement('h2'); h.textContent = 'Offerta'; panel.append(h);
  const rules = document.createElement('p');
  rules.className = 'mostrissimo-rules';
  rules.textContent = 'Max 1/turno · Mana 0 · Sacrifica permanenti (anche stanchi).';
  panel.append(rules);
  if (!state) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const strip = document.createElement('div'); strip.className = 'mostrissimo-offer'; panel.append(strip);
  for (const inst of state.shared_mostrissimi ?? []) {
    const d = await card(inst.card_id), b = document.createElement('button');
    b.type = 'button'; b.className = 'mostrissimo-card'; b.innerHTML = handCardHTML(d);
    const cost = Number(d.sacrifice_cost ?? 0);
    const own = board().flat().filter(c => isCreatureCell(c) && c.owner_index === 1).length;
    const canPay = Number.isInteger(cost) && cost >= 0 && permanents().length >= cost;
    const spaceOk = board()[2].some(c => !c) || (cost > 0 && own > 0);
    const onceOk = state.last_mostrissimo_turn?.[1] !== state.current_turn;
    const legal = active() && canPay && spaceOk && onceOk && cost <= 6;
    if (legal) b.classList.add('playable');
    else if (!canPay) b.classList.add('too-expensive');
    b.setAttribute('aria-label',`Apri ${d.name}, ${cost} sacrifici${legal ? ', evocabile' : !canPay ? ', sacrifici insufficienti' : ''}`);
    b.disabled = busy || noticeOpen || !!reaction() || obligatory();
    b.onclick = () => { if (noticeOpen) return; inspect('mostrissimo',inst.card_id); };
    strip.append(b);
  }
  if (p) {
    const zone = document.createElement('div'); zone.className = 'tribute-zone is-info'; panel.append(zone);
    const info = document.createElement('p'); info.className = 'tribute-progress';
    info.textContent = p.stage === 'etb' ? 'Risoluzione degli effetti all’entrata…' : p.stage === 'before_entry' ? 'Evocazione dichiarata: attendi la reazione.' : `Sacrifici ${p.paid.length}/${p.required}.`;
    zone.append(info);
  }
}
function controls() {
  const disable = (id,v) => { if ($(id)) $(id).disabled = !!v; };
  disable('end-turn-button',!active());
  disable('cancel-selection-button',busy || obligatory() || !flow || (!!pending() && flow?.kind !== 'trap-target'));
  // Reminder bersaglio/attacco: non svuotare se siamo in modalità scelta
  const keepReminder = flow && ['etb-target', 'mostrissimo-target', 'trap-target', 'attack', 'hand'].includes(flow.kind)
    && (flow.kind !== 'hand' || flow.step === 'target');
  if (!keepReminder) hideTargetReminder();
}
function showDeckColors() {
  const human = state?.deck_colors?.[1], ai = state?.deck_colors?.[0];
  if ($('player-deck-colors')) $('player-deck-colors').textContent = human ? `Mazzo: ${human.primary} · ${human.secondary} · ${human.tertiary}` : '';
  if ($('opponent-deck-colors')) $('opponent-deck-colors').textContent = ai ? `Mazzo: ${ai.primary} · ${ai.secondary} · ${ai.tertiary}` : '';
}
/** Evita render sovrapposti: se ne parte uno mentre un altro è in corso, ne schedula uno solo alla fine. */
let renderRunning = false;
let renderQueued = false;
async function render() {
  if (renderRunning) {
    renderQueued = true;
    return;
  }
  renderRunning = true;
  try {
    do {
      renderQueued = false;
      const set = (id,x) => { if ($(id)) $(id).textContent = String(x); };
      if (state) { hideStart(); hideHome(); hideStoryStart(); }
      set('player-life',me()?.life ?? 20); set('player-current-mana',me()?.current_mana ?? 0); set('player-max-mana',me()?.max_mana ?? 0);
      set('player-hand-count',me()?.hand?.length ?? 0); set('player-deck-count',me()?.deck?.length ?? 0); set('player-graveyard-count',me()?.graveyard?.length ?? 0);
      set('opponent-life',them()?.life ?? 20); set('opponent-current-mana',them()?.current_mana ?? 0); set('opponent-max-mana',them()?.max_mana ?? 0);
      set('opponent-hand-count',them()?.hand?.length ?? 0); set('opponent-deck-count',them()?.deck?.length ?? 0); set('opponent-graveyard-count',them()?.graveyard?.length ?? 0);
      updateOpponentName();
      showDeckColors(); drawOpponentHand();
      updateStoryMedallionBanner();
      updateStoryProgressBadge();
      // Board / mano / offerta in parallelo = meno attesa tra un click e l’altro
      await Promise.all([drawBoard(), drawHand(), drawMostrissimi()]);
      controls();
      await Promise.all([renderReaction(), renderDeathChoice(), markPlayerTarget()]);
    } while (renderQueued);
  } finally {
    renderRunning = false;
  }
}

/** Aggiorna i chip Medaglione sotto i nomi (tuo + boss) e nasconde il vecchio banner flottante. */
function updateStoryMedallionBanner() {
  // Nascondi il vecchio banner fisso in alto (non serve più)
  const old = $('story-medallion-banner');
  if (old) old.classList.add('hidden');

  const progress = currentMode === 'story' ? getStoryProgress() : null;
  const hasMatch = !!(state && matchId);
  const playerChip = $('player-medallion');
  const bossChip = $('opponent-medallion');

  // --- Medaglione del giocatore (dopo la 3ª scelta) ---
  if (playerChip) {
    const power = progress?.chosenPower;
    if (hasMatch && power && BOSS_DATA[power]?.medaglioneName) {
      const med = BOSS_DATA[power];
      const short = (deckFactionNames[power] || power);
      playerChip.textContent = `✦ ${short}`;
      playerChip.title = `${med.medaglioneName}: ${med.powerDesc}`;
      playerChip.setAttribute('aria-label', `${med.medaglioneName}: ${med.powerDesc}`);
      playerChip.onclick = e => {
        e.stopPropagation();
        notice(`${med.medaglioneName}\n${med.powerDesc}`, 'success');
      };
      playerChip.classList.remove('hidden');
    } else {
      playerChip.classList.add('hidden');
      playerChip.onclick = null;
    }
  }

  // --- Medaglione del boss (dalla 3ª partita in poi, non Indrazzico) ---
  if (bossChip) {
    const bossCode = progress?.currentBoss;
    const fightIndex = getStoryFightIndex(progress);
    // Boss «bara» dalla 3ª sfida (fightIndex >= 2) e ha un Medaglione
    const bossActive = hasMatch && bossCode && bossCode !== 'IND' && fightIndex >= 2 && BOSS_DATA[bossCode]?.medaglioneName;
    if (bossActive) {
      const med = BOSS_DATA[bossCode];
      const short = (deckFactionNames[bossCode] || bossCode);
      bossChip.textContent = `✦ ${short}`;
      bossChip.title = `${med.medaglioneName}: ${med.powerDesc}`;
      bossChip.setAttribute('aria-label', `Boss — ${med.medaglioneName}: ${med.powerDesc}`);
      bossChip.onclick = e => {
        e.stopPropagation();
        notice(`Boss — ${med.medaglioneName}\n${med.powerDesc}`, 'success');
      };
      bossChip.classList.remove('hidden');
    } else {
      bossChip.classList.add('hidden');
      bossChip.onclick = null;
    }
  }
}

/** Nome avversario: boss in Storia, altrimenti Mummy. Usato in HUD e popup di turno. */
function opponentDisplayName() {
  if (currentMode === 'story') {
    const code = getStoryProgress()?.currentBoss;
    if (code && BOSS_DATA[code]?.name) return BOSS_DATA[code].name;
  }
  return 'Mummy';
}

/** Nome dell'avversario sopra le carte (boss in Storia, altrimenti Mummy). */
function updateOpponentName() {
  const el = $('opponent-name');
  if (!el) return;
  el.textContent = opponentDisplayName();
}

/** Contatore Storia sotto il nome Mummy. Clic → elenco boss sconfitti. */
function updateStoryProgressBadge() {
  const badge = $('story-progress-badge');
  if (!badge) return;

  const inStory = currentMode === 'story' && !!(state && matchId);
  const progress = inStory ? getStoryProgress() : null;

  if (!inStory || !progress) {
    badge.classList.add('hidden');
    return;
  }

  const beaten = progress.beaten || [];
  const currentNum = Math.min(beaten.length + 1, 4);
  const total = 4;
  const label = progress.currentBoss === 'IND'
    ? `Storia ${total}/${total}`
    : `Storia ${currentNum}/${total}`;

  badge.textContent = label;
  badge.setAttribute('aria-label', `Progresso Storia ${label}: tocca per i boss sconfitti`);
  if (!badge.dataset.wired) {
    badge.dataset.wired = '1';
    badge.onclick = e => {
      e.stopPropagation();
      showStoryProgressDetail();
    };
  }
  badge.classList.remove('hidden');
}

/** Popup con i boss già sconfitti (nome + fazione/colore). */
function showStoryProgressDetail() {
  const progress = getStoryProgress();
  if (!progress) return;

  let el = $('story-progress-dialog');
  if (!el) {
    el = document.createElement('div');
    el.id = 'story-progress-dialog';
    el.className = 'card-detail-overlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.style.zIndex = '160';
    stageRoot().append(el);
  }
  el.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.style.cssText = 'width:min(92vw,400px);margin:auto;padding:1.2rem;text-align:center;border:1px solid #d5a758;box-shadow:0 12px 48px #000';

  const title = document.createElement('h3');
  title.style.cssText = 'margin:0 0 0.8rem;font-size:1.15rem;color:#e8c565';
  title.textContent = 'I tuoi trofei di guerra';

  const list = document.createElement('ul');
  list.style.cssText = 'list-style:none;margin:0 0 1rem;padding:0;text-align:left';

  const beaten = progress.beaten || [];
  if (beaten.length === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'margin:0 0 1rem;opacity:.85';
    empty.textContent = 'Nessun boss sconfitto ancora. Questa è la tua prima sfida!';
    panel.append(title, empty);
  } else {
    for (const code of beaten) {
      const data = BOSS_DATA[code] || { name: code };
      const faction = deckFactionNames[code] || code;
      const li = document.createElement('li');
      li.style.cssText = 'padding:0.55rem 0.4rem;border-bottom:1px solid #5a341044;line-height:1.35';
      li.innerHTML = `<strong>${escape(data.name)}</strong><br><span style="opacity:.85">Fazione: ${escape(faction)} (${escape(code)})</span>`;
      list.append(li);
    }
    panel.append(title, list);
  }

  if (progress.currentBoss) {
    const cur = document.createElement('p');
    cur.style.cssText = 'margin:0 0 1rem;font-size:0.95rem;color:#e8c565';
    const curData = BOSS_DATA[progress.currentBoss];
    const curName = curData?.name || progress.currentBoss;
    const curFac = deckFactionNames[progress.currentBoss] || progress.currentBoss;
    cur.textContent = `In corso: ${curName} · ${curFac}`;
    panel.append(cur);
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'primary-button';
  btn.textContent = 'Chiudi';
  btn.onclick = () => el.classList.add('hidden');
  panel.append(btn);
  el.append(panel);
  el.classList.remove('hidden');
}
async function logs() {
  if (!$('match-logs') || !matchId) return;
  const {logs:entries} = await api(`/match/${encodeURIComponent(matchId)}/logs?limit=1000`);
  $('match-logs').replaceChildren();
  const texts = [];
  for (const e of entries ?? []) {
    const li = document.createElement('li'), text = e.log_data?.description ?? e.log_data?.action_type ?? 'Evento';
    li.textContent = text; texts.push(text);
    $('match-logs').append(li);
  }
  const latest = $('log-latest');
  if (latest) { latest.replaceChildren(); for (const text of texts.slice(-3)) { const li = document.createElement('li'); li.textContent = text; latest.append(li); } }
}
/** Mostra gli annunci pubblici già presenti nello stato (senza /advance). */
async function presentPendingAnnouncements() {
  if (!state?.public_announcement) return;
  const a = state.public_announcement;
  const list = Array.isArray(state.public_announcements) && state.public_announcements.length > 1
    ? state.public_announcements
    : [a];
  const generation = presentationGeneration;
  for (let i = 0; i < list.length; i++) {
    await presentPublic(list[i], generation);
    if (generation !== presentationGeneration) return;
    if (i < list.length - 1) await waitPresentation(180);
  }
}

async function request(path, body, message) {
  if (busy || !matchId) return;
  close(); busy = true; controls(); reactionDialog().classList.add('hidden'); choiceDialog().classList.add('hidden');
  hideTargetReminder();
  let didRender = false;
  try {
    state = (await api(`/match/${encodeURIComponent(matchId)}/${path}`, { method: 'POST', body })).state;
    flow = null;
    // Log in background: non bloccare l’UI
    void logs().catch(e => console.warn(e));

    if (state.status === 'finished') {
      await render();
      didRender = true;
      await handleMatchFinished();
    } else {
      // ETB (on_play): prima creatura in campo + annunci, POI scelta bersaglio
      const etbSrc = deathTarget()?.task?.source;
      const isEtbPick = etbSrc === 'on_play' || etbSrc === 'terraforma_trigger' || etbSrc === 'aura_attack';

      if (isEtbPick) {
        await Promise.all([drawBoard(), drawHand()]);
        controls();
        updateOpponentName();
        updateStoryProgressBadge();
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        try { await presentPendingAnnouncements(); } catch (e) { console.warn(e); }
        await render();
        didRender = true;
      } else {
        await render();
        didRender = true;
        let text = null;
        let kind = 'success';
        if (state.mostrissimo_result?.outcome === 'failed') {
          text = state.mostrissimo_result.message; kind = 'error';
        } else if (deathOrder()) text = 'Scegli l’ordine delle creature morte.';
        else if (deathTarget()?.task?.source === 'on_death') text = 'Scegli il bersaglio dell’effetto alla morte.';
        else if (state.pending_reaction) text = reactionDescription(state.pending_reaction.event);
        else if (message && !(path === 'end-turn' && state.active_player_index !== 1)
          && !/dichiarat/i.test(message)) text = message;
        if (text) await notice(text, kind);
      }
    }
  } catch (e) {
    fail(e);
    try {
      state = (await api(`/match/${encodeURIComponent(matchId)}`)).state;
      flow = null;
      didRender = false;
    } catch (refreshError) {
      console.warn(refreshError);
    }
  } finally {
    busy = false;
    // Un solo render di chiusura se non l’abbiamo già fatto (evita doppio lavoro)
    if (!didRender) await render().catch(fail);
    else controls(); // sblocca subito i pulsanti
    if (!state || !matchId || state.status === 'finished') {
      return;
    }
    if (path === 'end-turn') {
      const endedTurn = state.active_player_index === 0
        ? Math.max(1, (state.current_turn ?? 1) - 1)
        : (state.current_turn ?? 1);
      await presentPhase('end', 1, endedTurn, state.players?.[1]?.max_mana ?? 0).catch(fail);
    } else {
      await ensurePhaseBanner().catch(fail);
    }
    const etbSrc = deathTarget()?.task?.source;
    const skipPres = etbSrc === 'on_play' || etbSrc === 'terraforma_trigger' || etbSrc === 'aura_attack';
    if (!skipPres) queuePresentation();
  }
}
// Il giocatore avversario come bersaglio (danni a scelta): si tocca il riquadro dei suoi PV.
async function playerTargetable() {
  if (!state || busy || obligatory()) return false;
  const r = reaction();
  if (r && flow?.kind === 'trap-target') return !!playerTargetEffect(await card(flow.id)) && r.event?.kind !== 'monster_etb';
  if (flow?.kind === 'mostrissimo-target') { const p = pending(); return !!p && !!playerTargetEffect(await card(p.card_id)); }
  if (flow?.kind === 'hand' && flow.step === 'target') return !!playerTargetEffect(await card(flow.id));
  return false;
}
async function markPlayerTarget() {
  const box = $('opponent-life')?.closest('.hud-value'); if (!box) return;
  const on = await playerTargetable();
  box.classList.toggle('valid-target',on);
  box.style.cursor = on ? 'pointer' : ''; box.style.outline = on ? '2px solid #e8c46a' : ''; box.style.pointerEvents = on ? 'auto' : '';
}
async function playerClick() {
  if (!(await playerTargetable())) return;
  const r = reaction();
  if (r && flow?.kind === 'trap-target') return chooseTrap({windowId:r.window_id,action:'play',cardInstanceId:flow.instanceId,targetInstanceId:AI_TARGET});
  if (flow?.kind === 'mostrissimo-target') return request('mostrissimo/complete',{position:flow.position,targetInstanceId:AI_TARGET},'Mostrissimo dichiarato.');
  if (flow?.kind === 'hand') {
    const d = await card(flow.id);
    return request('play-card',{cardInstanceId:flow.instanceId,options:{...(flow.position ? {position:flow.position} : {}),targetInstanceId:AI_TARGET}},creature(d) ? 'Creatura dichiarata.' : 'Carta dichiarata.');
  }
}
async function boardClick(pos) {
  // Durante scelta ETB / attacco / movimento non perdere i click se busy è ancora true un attimo.
  const allowWhileBusy = flow?.kind === 'etb-target' || flow?.kind === 'mostrissimo-target'
    || flow?.kind === 'attack' || flow?.kind === 'move' || flow?.kind === 'hand';
  if (busy && !allowWhileBusy) return;
  if (noticeOpen && flow?.kind !== 'etb-target' && flow?.kind !== 'attack' && flow?.kind !== 'move') return;
  if (obligatory() && flow?.kind !== 'etb-target') return;
  if (flow?.kind === 'etb-target') {
    const c = at(pos);
    if (!c || !(flow.eligible ?? []).includes(c.instance_id)) {
      return;
    }
    let def = null;
    try { def = await card(c.card_id); } catch (_) { /* ignore */ }
    const ok = await confirmTargetChoice(c, def);
    if (!ok) return; // resta in modalità scelta bersaglio
    if (deathTarget()?.choice_id !== flow.choiceId) return;
    const choiceId = flow.choiceId;
    flow = null;
    return request('death/target',{choiceId,targetInstanceId:c.instance_id},'Effetto in entrata risolto.');
  }
  const c = at(pos), r = reaction();
  if (r) {
    if (flow?.kind === 'trap-target') {
      if (flow.windowId !== r.window_id) { flow = null; await render(); return notice('Finestra reattiva scaduta.','error'); }
      const d = await card(flow.id);
      if (!targetAllowed(d,c,r.event)) return notice('Bersaglio della Trappola non valido.','error');
      let def = null;
      try { def = await card(c.card_id); } catch (_) { /* ignore */ }
      const ok = await confirmTargetChoice(c, def);
      if (!ok) return;
      return chooseTrap({windowId:r.window_id,action:'play',cardInstanceId:flow.instanceId,targetInstanceId:c.instance_id});
    }
    return notice('Scegli una Trappola oppure passa.','error');
  }
  if (!turn()) return;
  const p = pending();
  if (flow?.kind === 'mostrissimo-target') {
    if (!p || p.stage !== 'paying' || p.paid.length !== p.required) { flow = null; await render(); return notice('Evocazione non più valida.','error'); }
    const d = await card(p.card_id);
    // Cella di evocazione = se stessa (dopo l’ingresso).
    if (!c && flow.position && eq(flow.position, pos) && p.offered_instance_id) {
      return request('mostrissimo/complete',{position:flow.position,targetInstanceId:p.offered_instance_id},'Mostrissimo dichiarato.');
    }
    if (!targetAllowed(d,c)) return notice('Bersaglio dell’effetto all’entrata non valido.','error');
    let def = null;
    try { def = await card(c.card_id); } catch (_) { /* ignore */ }
    const ok = await confirmTargetChoice(c, def);
    if (!ok) return;
    return request('mostrissimo/complete',{position:flow.position,targetInstanceId:c.instance_id},'Mostrissimo dichiarato.');
  }
  if (p) {
    if (p.stage !== 'paying') return;
    if (p.paid.length < p.required) {
      if (c?.owner_index === 1) return inspect('tribute', c.card_id, { instanceId: c.instance_id, cell: c });
      return notice('Scegli un tuo permanente nell’elenco dei sacrifici.','error');
    }
    if (c || !summonCells(p).some(x => eq(x,pos))) return notice('Cella non valida.','error');
    const d = await card(p.card_id);
    // Buff/cura: completa SENZA bersaglio → creatura in campo → poi scelta (come i mostri normali).
    // Danno/altro mirato: il server esige ancora il bersaglio prima dell’ingresso.
    const etbAimed = effects(d).filter(e =>
      !e?.trigger && (e?.target === 'any_creature' || e?.target === 'any_target' || e?.type === 'return_hand')
    );
    const onlyBuffHeal = etbAimed.length > 0 && etbAimed.every(e => e.type === 'buff' || e.type === 'heal');
    if (etbAimed.length && !onlyBuffHeal) {
      flow = { kind: 'mostrissimo-target', position: pos, id: d.id };
      await render();
      showTargetReminder(targetReminderText(d));
      return;
    }
    return request('mostrissimo/complete', { position: pos }, 'Mostrissimo dichiarato.');
  }
  if (flow?.kind === 'hand') {
    const d = await card(flow.id);
    if (flow.step === 'cell') {
      if (c || pos.row !== 2) return notice('Scegli una cella libera della tua riga.','error');
      flow.position = pos;
      // Mostri con danno/rimozione mirati: il server ESIGE il bersaglio già in play-card.
      // (Buff/cura possono essere scelti dopo l’ingresso; maledizioni usano già lo step target.)
      const needsTargetNow = creature(d) && effects(d).some(e =>
        !e?.trigger
        && (e?.target === 'any_creature' || e?.target === 'any_target' || e?.type === 'return_hand')
        && e.type !== 'heal'
        && e.type !== 'buff'
      );
      if (needsTargetNow && hasTargets(d)) {
        flow.step = 'target';
        await render();
        showTargetReminder(targetReminderText(d));
        return;
      }
      return request('play-card',{cardInstanceId:flow.instanceId,options:{position:pos}},'Carta dichiarata.');
    }
    if (flow.step === 'target') {
      if (!targetAllowed(d,c)) return notice('Bersaglio non valido.','error');
      let def = null;
      try { def = await card(c.card_id); } catch (_) { /* ignore */ }
      const ok = await confirmTargetChoice(c, def);
      if (!ok) return;
      return request('play-card',{cardInstanceId:flow.instanceId,options:{...(flow.position ? {position:flow.position} : {}),targetInstanceId:c.instance_id}},creature(d) ? 'Creatura dichiarata.' : 'Carta dichiarata.');
    }
  }
  if (flow?.kind === 'move') {
    if (!steps(flow.from).some(x => eq(x,pos))) return notice('Scegli una cella libera adiacente.','error');
    hideTargetReminder();
    return request('move',{from:flow.from,to:pos},'Movimento dichiarato.');
  }
  if (flow?.kind === 'attack') {
    if (!attackable(flow.from).some(x => eq(x,pos))) return notice('Scegli un nemico adiacente evidenziato.','error');
    hideTargetReminder();
    return request('attack',{attackerPosition:flow.from,target:{type:'creature',position:pos}},'Attacco dichiarato.');
  }
  if (c) return inspect('unit',c.card_id,{position:pos,cell:c});
}
/** Colori iris per gli occhi della maledizione (fallback cerchi). */
const FACTION_EYE = {
  CHI: '#c9b88a', INF: '#5a8dc2', PES: '#8a72b8',
  BUL: '#c4684f', GRO: '#5aa87c', CLO: '#e0a22a', IND: '#8a96a3',
};

/** Overlay narrativo Mummy per scelta colori (anima / artefatto / maledizione).
 *  Home resta sullo sfondo (3 piramidi); Mummy in primo piano. */
function closeColorDialog() {
  const anima = $('anima-scene');
  if (anima) {
    anima.classList.add('hidden');
    anima.style.display = 'none';
  }
  $('deck-color-dialog')?.classList.add('hidden');
  if (currentMode === 'story') return;
  if ($('home-dialog') && !$('home-dialog').classList.contains('hidden')) return;
  if (!state && !busy && !matchId && !$('game-screen')?.classList.contains('hidden')) showStart();
}

function animaSceneEl() {
  let el = $('anima-scene');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'anima-scene';
  el.className = 'anima-scene hidden';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Scelta dell’anima');
  // Sopra la Home, sotto eventuali altri overlay di gioco
  el.style.cssText = 'position:fixed;inset:0;z-index:280;display:flex;align-items:center;justify-content:center;background:rgba(8,6,4,.72);padding:1rem;';
  document.body.append(el);
  return el;
}

function renderColorButtons(codes, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'anima-color-grid';
  wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:.55rem;justify-content:center;margin-top:.9rem;max-width:min(92vw,420px);';
  for (const code of codes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary-button anima-color-btn';
    btn.dataset.color = code;
    const name = deckFactionNames[code] || code;
    const iris = FACTION_EYE[code] || '#e8c565';
    btn.style.cssText = `min-width:7.2rem;padding:.7rem .85rem;border:2px solid ${iris};box-shadow:0 0 0 1px rgba(0,0,0,.35),0 0 14px ${iris}44;font-size:.95rem;`;
    btn.innerHTML = `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${iris};margin-right:.45rem;vertical-align:middle;box-shadow:0 0 6px ${iris}"></span>${name}`;
    btn.onclick = () => onPick(code);
    wrap.append(btn);
  }
  return wrap;
}

/** Scena a step: A anima → B artefatto → goodbye Mummy → occhi maledizione → newMatch. */
async function showAnimaScene() {
  if (busy || reaction() || pending() || obligatory()) return;
  close(); closeGraveyard();
  hideStart(); hideStoryStart();
  // Home resta visibile sotto (3 piramidi)

  const el = animaSceneEl();
  el.innerHTML = '';
  el.style.display = 'flex';
  el.classList.remove('hidden');

  const panel = document.createElement('div');
  panel.className = 'panel anima-panel';
  panel.style.cssText = 'width:min(94vw,460px);max-height:92dvh;overflow:auto;margin:auto;padding:1.15rem 1.1rem 1.3rem;text-align:center;border:1px solid #d5a758;box-shadow:0 16px 56px #000;background:linear-gradient(180deg,#1a1410 0%,#0e0b09 100%);';

  const med = document.createElement('div');
  med.className = 'narrator-medallion bob';
  med.style.cssText = 'width:150px;height:150px;margin:0 auto .7rem;border-radius:50%;overflow:hidden;border:2px solid #d5a758;';
  med.innerHTML = `<img class="narrator-img" src="img/mummy/mummy-base.png" alt="Mummy" width="150" height="150" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">`;

  const nameEl = document.createElement('div');
  nameEl.style.cssText = 'font-family:"Lilita One",Georgia,serif;color:#e8c565;font-size:1.15rem;margin-bottom:.35rem;letter-spacing:.03em;';
  nameEl.textContent = 'Mummy';

  const speech = document.createElement('p');
  speech.id = 'anima-speech';
  speech.style.cssText = 'margin:0 auto;line-height:1.5;font-size:1.08rem;max-width:36ch;white-space:pre-line;';

  const choices = document.createElement('div');
  choices.id = 'anima-choices';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary-button';
  cancel.style.cssText = 'margin-top:1rem;';
  cancel.textContent = 'Annulla';
  cancel.onclick = () => {
    el.classList.add('hidden');
    el.style.display = 'none';
    if (currentMode === 'story') showStoryStart();
    else if ($('home-dialog') && !$('home-dialog').classList.contains('hidden')) { /* resta home */ }
    else showStart();
  };

  panel.append(med, nameEl, speech, choices, cancel);
  el.append(panel);

  const allCodes = Object.keys(deckFactionNames);

  // —— Passo A: colore dell’anima ——
  speech.textContent = 'Benvenuto, coraggioso. Dimmi, com’è fatta la tua anima?';
  choices.innerHTML = '';
  const primary = await new Promise(resolve => {
    choices.append(renderColorButtons(allCodes, code => resolve(code)));
  });

  // —— Passo B: artefatto ——
  speech.textContent = 'Interessante… ti aiuterò: quale artefatto vuoi?';
  choices.innerHTML = '';
  const remaining = allCodes.filter(c => c !== primary);
  const secondary = await new Promise(resolve => {
    choices.append(renderColorButtons(remaining, code => resolve(code)));
  });

  // —— Goodbye Mummy ——
  let uname = 'coraggioso';
  try {
    const u = await getCurrentUser();
    uname = usernameFromEmail(u?.email) || 'coraggioso';
  } catch (_) { /* ignore */ }
  speech.textContent = `Bene. Sei pronto per la prima stanza. Buona fortuna, ${uname}.`;
  choices.innerHTML = '';
  cancel.style.display = 'none';
  await new Promise(resolve => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary-button';
    btn.textContent = 'Continua';
    btn.onclick = () => resolve();
    choices.append(btn);
  });

  // —— Maledizione: solo 2 occhi del terzo colore ——
  const candidates = allCodes.filter(c => c !== primary && c !== secondary);
  const tertiary = candidates[Math.floor(Math.random() * candidates.length)];
  const tName = deckFactionNames[tertiary] || tertiary;
  const iris = FACTION_EYE[tertiary] || '#e8c565';

  med.style.display = 'none';
  nameEl.style.display = 'none';
  speech.textContent = `Un’ombra ti sfiora. Ora ${tName} fa parte di te.`;
  choices.innerHTML = '';
  const eyes = document.createElement('div');
  eyes.setAttribute('aria-hidden', 'true');
  eyes.style.cssText = 'display:flex;gap:2.2rem;justify-content:center;align-items:center;margin:.6rem 0 1rem;';
  for (let i = 0; i < 2; i++) {
    const eye = document.createElement('div');
    eye.style.cssText = `width:52px;height:52px;border-radius:50%;background:#0b0806;border:3px solid #3a2e1a;box-shadow:0 0 18px ${iris}88, inset 0 0 12px #000;display:flex;align-items:center;justify-content:center;`;
    const pupil = document.createElement('div');
    pupil.style.cssText = `width:22px;height:22px;border-radius:50%;background:${iris};box-shadow:0 0 10px ${iris},0 0 2px #fff8;`;
    eye.append(pupil);
    eyes.append(eye);
  }
  choices.append(eyes);
  await new Promise(resolve => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary-button';
    btn.textContent = 'Affronto il destino';
    btn.onclick = () => resolve();
    choices.append(btn);
  });

  el.classList.add('hidden');
  el.style.display = 'none';
  // Avvia partita con tertiary già scelto (coerente con il messaggio); maledizione già mostrata
  await newMatch(primary, secondary, {
    isNewStory: currentMode === 'story',
    tertiaryColor: tertiary,
    curseAlreadyShown: true,
  });
}

function openColorDialog() {
  // Dalla Home / Storia non c’è partita: sblocca sempre eventuali flag residui
  if (!state && !matchId) busy = false;
  if (busy || reaction() || pending() || obligatory()) {
    console.warn('[anima] openColorDialog blocked', { busy, reaction: !!reaction(), pending: !!pending(), obligatory: !!obligatory() });
    return;
  }
  showAnimaScene().catch(fail);
}
function openColorDialogForStory() {
  openColorDialog();
}
async function submitColors() {
  // Legacy no-op: la scelta passa da showAnimaScene
}

// ---------- HOME PAGE: deserto + tre piramidi (Storia / Endless / Coming Soon) ----------
let currentMode = 'story'; // 'story' | 'endless'

// ---------- PROGRESSI STORIA (Fase 1) ----------
// Struttura salvata in localStorage:
// {
//   primary: 'CHI', secondary: 'INF', tertiary: 'PES',
//   beaten: ['BUL', 'GRO'],          // boss già sconfitti (i 3 intermedi)
//   indrazzicoBeaten: false,
//   chosenPower: null,               // potere scelto alla 3ª partita (es. 'CHI')
//   completed: false                 // true solo dopo aver battuto Indrazzico
// }

const STORY_KEY = 'bellum:story-progress';

function getStoryProgress() {
  try {
    const raw = localStorage.getItem(STORY_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveStoryProgress(progress) {
  try {
    localStorage.setItem(STORY_KEY, JSON.stringify(progress));
  } catch (e) {
    console.warn('Impossibile salvare i progressi Storia', e);
  }
  // Server (best-effort): così PC e telefono restano allineati
  void api('/me/profile', { method: 'PUT', body: { story_progress: progress } }).catch(e => {
    console.warn('Salvataggio progressi sul server fallito', e);
  });
}

function clearStoryProgress() {
  try {
    localStorage.removeItem(STORY_KEY);
    localStorage.removeItem('bellum:story-completed'); // vecchia chiave
  } catch { /* ignore */ }
  void api('/me/profile', { method: 'PUT', body: { story_progress: null } }).catch(() => { /* ignore */ });
}

function isStoryCompleted() {
  const p = getStoryProgress();
  return !!(p && p.completed);
}

/** Restituisce i colori ancora da battere (i 3 intermedi rimanenti). */
function getRemainingBosses(progress) {
  if (!progress) return [];
  const allSix = ['CHI', 'INF', 'PES', 'BUL', 'GRO', 'CLO'];
  const playerColors = [progress.primary, progress.secondary, progress.tertiary];
  return allSix.filter(c => !playerColors.includes(c) && !(progress.beaten || []).includes(c));
}

/** True se i 3 boss intermedi sono tutti battuti e manca solo Indrazzico. */
function isReadyForIndrazzico(progress) {
  if (!progress || progress.indrazzicoBeaten) return false;
  return getRemainingBosses(progress).length === 0;
}

// Dati placeholder dei boss (nomi, poteri/Medaglioni, frasi)
// Il Medaglione è un potere passivo fuori dal campo (non bersagliabile).
const BOSS_DATA = {
  CHI: {
    name: 'Sacerdote Ankh-Hotep',
    powerDesc: 'Le tue creature hanno +0/+1',
    threat: '«La luce della guarigione non ti salverà…»',
    mummyAfter: 'Hai sconfitto il Sacerdote. La piramide trema, ma il cammino continua.',
    medaglioneName: 'Medaglione della Chiericanza',
  },
  INF: {
    name: 'Ladra Neferet',
    powerDesc: 'All’inizio del tuo turno peschi 1 carta in più',
    threat: '«Rubo tutto… anche le tue speranze.»',
    mummyAfter: 'Neferet è caduta. Attenzione: le ombre diventano più dense.',
    medaglioneName: 'Medaglione dell’Infamia',
  },
  PES: {
    name: 'Verme del Nilo',
    powerDesc: 'All’inizio del tuo turno l’avversario scarta 1 carta',
    threat: '«La malattia avanza… e tu sei già infetto.»',
    mummyAfter: 'Il Verme è stato spezzato. L’aria è un po’ meno pesante.',
    medaglioneName: 'Medaglione della Pestilenza',
  },
  BUL: {
    name: 'Colosso di Khem',
    powerDesc: 'Le tue creature hanno +1/+0',
    threat: '«Schiaccerò le tue ossa sotto i miei piedi.»',
    mummyAfter: 'Il Colosso è a terra. La forza bruta non basta contro di te.',
    medaglioneName: 'Medaglione del Bullismo',
  },
  GRO: {
    name: 'Grande Ptah',
    powerDesc: 'All’inizio del tuo turno guadagni 1 vita',
    threat: '«Divento sempre più grande… tu sempre più piccolo.»',
    mummyAfter: 'Ptah è stato ridimensionato. La piramide osserva con interesse.',
    medaglioneName: 'Medaglione della Grossanza',
  },
  CLO: {
    name: 'Jester Ra',
    powerDesc: 'Le tue creature costano 1 mana in meno (minimo 1)',
    threat: '«Questa lotta sarà… ridicola.»',
    mummyAfter: 'Il Jester non ride più. Forse non era solo uno scherzo.',
    medaglioneName: 'Medaglione della Clownerie',
  },
  IND: {
    name: 'Indrazzico, l’Ombra Eterna',
    powerDesc: '(poteri speciali in arrivo)',
    threat: '«Io sono ciò che resta quando tutto è finito.»',
    mummyAfter: 'Hai sconfitto Indrazzico. Sei diventato un Abitante della Piramide.',
    medaglioneName: null,
  },
};

/** Quanti boss intermedi hai già battuto (0, 1 o 2 → vita 20/25/30). */
function getStoryFightIndex(progress) {
  return (progress?.beaten || []).length; // 0 = primo, 1 = secondo, 2 = terzo
}

function getBossLifeForFight(index) {
  if (index <= 0) return 20;
  if (index === 1) return 25;
  return 30; // terzo boss
}

/** Sceglie a caso uno dei boss ancora da battere. */
function pickNextBoss(progress) {
  const remaining = getRemainingBosses(progress);
  if (remaining.length === 0) return 'IND';
  return remaining[Math.floor(Math.random() * remaining.length)];
}

function homeDialog() {
  let el = $('home-dialog');
  if (el) return el;

  el = document.createElement('div');
  el.id = 'home-dialog';
  el.className = 'home-dialog hidden';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'home-title');

  // Sfondo deserto
  const bg = document.createElement('div');
  bg.className = 'home-desert';

  // Contenuto centrale
  const content = document.createElement('div');
  content.className = 'home-content';

  const title = document.createElement('h1');
  title.id = 'home-title';
  title.className = 'home-title';
  title.textContent = 'Scegli il tuo destino';

  const subtitle = document.createElement('p');
  subtitle.className = 'home-subtitle';
  subtitle.textContent = 'Tre piramidi sorgono all’orizzonte…';

  // Contenitore delle tre piramidi
  const pyramids = document.createElement('div');
  pyramids.className = 'home-pyramids';

  // Crea una piramide: se c’è imageSrc usa l’immagine, altrimenti SVG di fallback
  function makePyramid(id, label, locked, onClick, imageSrc) {
    const wrap = document.createElement('button');
    wrap.type = 'button';
    wrap.id = id;
    wrap.className = 'home-pyramid' + (locked ? ' is-locked' : '');
    wrap.setAttribute('aria-label', label);
    if (locked) wrap.disabled = true;

    if (imageSrc) {
      // Usa l’immagine caricata (es. piramide1.png)
      wrap.innerHTML = `
        <img class="pyramid-img" src="${imageSrc}" alt="" width="220" height="120" decoding="async" />
        <span class="pyramid-label">${label}</span>
      `;
    } else {
      // SVG di fallback (per le modalità senza immagine ancora)
      wrap.innerHTML = `
        <svg class="pyramid-svg" viewBox="0 0 120 110" width="140" height="128" aria-hidden="true">
          <defs>
            <linearGradient id="pg-${id}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#e8c565"/>
              <stop offset="55%" stop-color="#c9a043"/>
              <stop offset="100%" stop-color="#8a5a14"/>
            </linearGradient>
            <linearGradient id="ps-${id}" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="#00000055"/>
              <stop offset="100%" stop-color="#00000000"/>
            </linearGradient>
          </defs>
          <polygon points="60,8 112,100 8,100" fill="url(#pg-${id})" stroke="#5a3410" stroke-width="2.5"/>
          <polygon points="60,8 112,100 60,100" fill="url(#ps-${id})"/>
          <rect x="52" y="72" width="16" height="28" fill="#2a1a0a" opacity="0.85"/>
          <rect x="4" y="98" width="112" height="6" rx="1" fill="#6b4420"/>
        </svg>
        <span class="pyramid-label">${label}</span>
      `;
    }

    if (!locked && onClick) {
      wrap.onclick = onClick;
    }
    return wrap;
  }

  // Storia – piramide1.png (sempre cliccabile)
  const storyBtn = makePyramid('home-story', 'Modalità Storia', false, () => {
    currentMode = 'story';
    // NON hideHome: altrimenti resta la griglia vuota sotto il dialog
    hideStart();
    storyStartScreen().catch(fail);
  }, 'img/piramide1.png');

  // Endless – piramide2.png
  // Per ora BLOCCATA. Diventerà cliccabile solo dopo aver vinto la Modalità Storia.
  // Quando sarà sbloccata mostrerà «Modalità Endless», finché è bloccata mostra «???»
  const storyDone = isStoryCompleted();
  const endlessLabel = storyDone ? 'Modalità Endless' : '???';
  const endlessLocked = !storyDone; // bloccata finché non si vince la Storia
  const endlessBtn = makePyramid('home-endless', endlessLabel, endlessLocked, () => {
    currentMode = 'endless';
    hideHome();
    startScreen().catch(fail); // stessa logica di Storia (fotocopia per ora)
  }, 'img/piramide2.png');

  // Coming Soon – piramide3.png (sempre bloccata per ora)
  const soonBtn = makePyramid('home-soon', 'Coming Soon', true, null, 'img/piramide3.png');

  pyramids.append(storyBtn, endlessBtn, soonBtn);
  content.append(title, subtitle, pyramids);
  el.append(bg, content);

  // Aggiungi al body (copre tutto lo schermo dopo il login)
  document.body.append(el);
  return el;
}

function showHome() {
  if (state || busy) return;
  const el = homeDialog();

  // Aggiorna etichetta e stato di blocco di Endless
  const storyDone = isStoryCompleted();
  const endlessBtn = $('home-endless');
  if (endlessBtn) {
    const label = endlessBtn.querySelector('.pyramid-label');
    if (label) label.textContent = storyDone ? 'Modalità Endless' : '???';
    if (storyDone) {
      endlessBtn.classList.remove('is-locked');
      endlessBtn.disabled = false;
    } else {
      endlessBtn.classList.add('is-locked');
      endlessBtn.disabled = true;
    }
  }

  // Trofeo «Abitante della Piramide»
  let trophy = el.querySelector('.home-trophy');
  if (storyDone) {
    if (!trophy) {
      trophy = document.createElement('div');
      trophy.className = 'home-trophy';
      trophy.innerHTML = `
        <img src="img/Trofei/abitante.png" alt="Abitante della Piramide" width="96" height="96" decoding="async" />
        <span>Abitante della Piramide</span>
      `;
      const content = el.querySelector('.home-content');
      if (content) content.append(trophy);
    }
    trophy.classList.remove('hidden');
  } else if (trophy) {
    trophy.classList.add('hidden');
  }

  el.classList.remove('hidden');
  // Nascondi gli altri overlay di avvio (closeColorDialog non deve riaprire start)
  hideStart();
  hideStoryStart();
  closeColorDialog();
}

function hideHome() {
  $('home-dialog')?.classList.add('hidden');
}

// ---------- Schermata iniziale: recupera partita precedente / nuova partita ----------
let priorMatch = null, probing = false;
async function probePrior() {
  priorMatch = null;
  // Preferisci last_match_id dal server (cross-device), fallback localStorage
  let prior = null;
  try {
    const profile = await api('/me/profile');
    if (profile?.last_match_id) prior = String(profile.last_match_id);
  } catch (_) { /* ignore */ }
  if (!prior) {
    try { prior = localStorage.getItem('bellum:last-match'); } catch (_) { prior = null; }
  }
  if (!prior) return;
  try {
    const [user, result] = await Promise.all([getCurrentUser(), api(`/match/${encodeURIComponent(prior)}`)]);
    if (result.state?.state_version === 4 && user && result.state.players?.[1]?.user_id === user.id && result.state.status !== 'finished') {
      priorMatch = { id: prior };
      try { localStorage.setItem('bellum:last-match', prior); } catch (_) { /* ignore */ }
    } else if (result.state?.status === 'finished') {
      // Pulisci last_match sul server se la partita è finita
      void api('/me/profile', { method: 'PUT', body: { last_match_id: null } }).catch(() => {});
      try { localStorage.removeItem('bellum:last-match'); } catch (_) { /* ignore */ }
    }
  } catch (e) { console.warn('Ripristino non disponibile', e); }
}
function startDialog() {
  let el = $('start-dialog'); if (el) return el;
  el = document.createElement('div'); el.id = 'start-dialog'; el.className = 'card-detail-overlay start-dialog hidden';
  el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true'); el.setAttribute('aria-labelledby','start-title'); el.style.zIndex = '110';
  const panel = document.createElement('div'); panel.className = 'panel';
  const title = document.createElement('h2'); title.id = 'start-title'; title.textContent = 'Le spoglie e l’inizio';
  const text = document.createElement('p'); text.id = 'start-text';
  const actions = document.createElement('div'); actions.className = 'start-actions';
  const recover = document.createElement('button'); recover.type = 'button'; recover.id = 'start-recover-button'; recover.className = 'primary-button'; recover.textContent = 'RIPRENDI le tue spoglie';
  recover.onclick = () => recoverPrior().catch(fail);
  const fresh = document.createElement('button'); fresh.type = 'button'; fresh.id = 'start-new-button'; fresh.className = 'secondary-button'; fresh.textContent = 'Abbraccia un nuovo inizio';
  fresh.onclick = () => openColorDialog();  actions.append(recover,fresh); panel.append(title,text,actions); el.append(panel); stageRoot().append(el);
  return el;
}
function showStart() {
  if (state || busy) return;
  if ($('anima-scene') && !$('anima-scene').classList.contains('hidden')) return;
  const el = startDialog(), has = !!priorMatch;
  $('start-recover-button').classList.toggle('hidden',!has);
  $('start-new-button').className = has ? 'secondary-button' : 'primary-button';
  $('start-text').textContent = has
    ? 'Un’ombra precedente ti attende. Vuoi riprendere le tue spoglie o abbracciare un nuovo inizio?'
    : 'Nessuna spoglia da recuperare. Puoi solo abbracciare un nuovo inizio.';
  el.classList.remove('hidden');
}
function hideStart() { $('start-dialog')?.classList.add('hidden'); }
async function startScreen() {
  if (state || busy || probing) return;
  probing = true;
  try { await probePrior(); } finally { probing = false; }
  showStart();
}

// ---------- STORIA: schermata di avvio (RIPRENDI / NUOVO INIZIO) ----------
function storyStartDialog() {
  let el = $('story-start-dialog');
  if (el) return el;

  el = document.createElement('div');
  el.id = 'story-start-dialog';
  el.className = 'story-start-dialog start-dialog hidden';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'story-start-title');

  const panel = document.createElement('div');
  panel.className = 'panel';

  const title = document.createElement('h2');
  title.id = 'story-start-title';
  title.textContent = 'Il Cammino nella Piramide';

  const text = document.createElement('p');
  text.id = 'story-start-text';

  const actions = document.createElement('div');
  actions.className = 'start-actions';

  const recover = document.createElement('button');
  recover.type = 'button';
  recover.id = 'story-recover-button';
  recover.className = 'primary-button';
  recover.textContent = 'RIPRENDI le tue spoglie';
  recover.onclick = () => resumeStory().catch(fail);

  const fresh = document.createElement('button');
  fresh.type = 'button';
  fresh.id = 'story-new-button';
  fresh.className = 'secondary-button';
  fresh.textContent = 'Abbraccia un nuovo destino';
  fresh.onclick = () => {
    clearStoryProgress();
    hideStoryStart();
    // Home resta sullo sfondo (3 piramidi); Mummy in primo piano nella scena anima
    openColorDialogForStory();
  };

  actions.append(recover, fresh);
  panel.append(title, text, actions);
  el.append(panel);
  // Sul body (sopra Home), non dentro stage: evita flash della griglia
  document.body.append(el);
  return el;
}

function showStoryStart() {
  const el = storyStartDialog();
  const progress = getStoryProgress();
  const hasProgress = !!(progress && !progress.completed && (
    (progress.beaten && progress.beaten.length > 0) || progress.primary
  ));
  // Partita interrotta: da probePrior oppure già in memoria su questo device
  const hasMatch = !!priorMatch || !!(state && matchId && state.status !== 'finished');
  if (state && matchId && state.status !== 'finished' && !priorMatch) {
    priorMatch = { id: matchId };
  }

  // Mostra sempre RIPRENDI se c’è progresso O partita da recuperare
  const canRecover = hasProgress || hasMatch;
  $('story-recover-button').classList.toggle('hidden', !canRecover);
  $('story-new-button').className = canRecover ? 'secondary-button' : 'primary-button';

  if (canRecover) {
    $('story-start-text').textContent = 'Vuoi continuare il tuo percorso, o preferisci ricominciare?';
  } else {
    $('story-start-text').textContent = 'Nessuna spoglia da recuperare. Puoi solo abbracciare un nuovo destino e iniziare il Cammino.';
  }

  el.classList.remove('hidden');
}

function hideStoryStart() {
  $('story-start-dialog')?.classList.add('hidden');
}

/** Schermata scelta Storia: SEMPRE chiede RIPRENDI o nuovo destino (mai auto-start). */
async function storyStartScreen() {
  busy = false;
  try { await probePrior(); } catch (_) { /* ignore */ }
  // Se c’è già una partita aperta in questa scheda, resta recuperabile ma non si entra da soli
  if (state && matchId && state.status !== 'finished') {
    priorMatch = { id: matchId };
  }
  showStoryStart();
}

/**
 * «RIPRENDI le tue spoglie» in Storia:
 * 1) se c’è una partita in corso (browser chiuso a metà) → la ripristina;
 * 2) altrimenti → avvia il prossimo boss con i colori già salvati.
 */
async function resumeStory() {
  const progress = getStoryProgress();
  if (!progress) {
    notice('Nessun progresso trovato. Inizia un nuovo destino.', 'error');
    return;
  }
  busy = true;
  hideStoryStart();
  hideStart();
  currentMode = 'story';

  // C’è una partita non finita? Ripristinala invece di crearne una nuova.
  try {
    await probePrior();
  } catch (_) { /* ignore */ }

  if (priorMatch) {
    const id = priorMatch.id;
    try {
      const result = await api(`/match/${encodeURIComponent(id)}`);
      if (result.state?.state_version !== 4) throw new Error('Partita non più compatibile.');
      if (result.state.status === 'finished') {
        // Partita già conclusa: passa al prossimo boss
        priorMatch = null;
        try { localStorage.removeItem('bellum:last-match'); } catch (_) { /* ignore */ }
        busy = false;
        await startNextStoryFight(progress);
        return;
      }
      matchId = id;
      state = result.state;
      flow = null;
      priorMatch = null;
      deathDraft = { choiceId: null, instanceIds: [] };
      localStorage.setItem('bellum:last-match', matchId);
      hideHome();
      close();
      closeGraveyard();
      closeColorDialog();
      busy = false;
      await render().catch(fail);
      try { await logs(); } catch (e) { console.warn(e); }
      await notice('Partita precedente ripristinata.', 'success');
      queuePresentation(true);
      return;
    } catch (e) {
      console.warn('Ripristino partita fallito, avvio il prossimo boss', e);
      priorMatch = null;
    }
  }

  // Nessuna partita da ripristinare → prossimo boss
  busy = false;
  await startNextStoryFight(progress);
}

/** Avvia la prossima lotta della Storia (boss rimanente o Indrazzico). */
async function startNextStoryFight(progress) {
  if (!progress) return;
  // Sblocca sempre: dopo una vittoria busy può essere ancora true (coda presentazioni)
  busy = false;
  currentMode = 'story';
  // I dialoghi e la scelta del Medaglione vengono gestiti dentro newMatch
  await newMatch(progress.primary, progress.secondary);
}

/** Scelta del cheat code (1 potere tra i 3 colori del mazzo del giocatore). */
function showCheatCodeChoice(progress) {
  return new Promise(resolve => {
    const colors = [progress.primary, progress.secondary, progress.tertiary].filter(Boolean);
    let el = $('cheat-code-dialog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cheat-code-dialog';
      el.className = 'card-detail-overlay';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.style.zIndex = '155';
      stageRoot().append(el);
    }
    el.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.cssText = 'width:min(94vw,480px);margin:auto;padding:1.3rem;text-align:center;border:1px solid #d5a758;box-shadow:0 12px 48px #000';

    const title = document.createElement('h2');
    title.style.cssText = 'margin:0 0 .8rem;font-family:"Lilita One",Georgia,serif;color:#e8c565';
    title.textContent = 'Scegli un Cheat Code';

    const subtitle = document.createElement('p');
    subtitle.style.cssText = 'margin:0 0 1.1rem;font-size:.98rem;line-height:1.4';
    subtitle.textContent = 'Attiva il Medaglione di uno dei tuoi colori. Resterà con te fino alla fine della Storia.';

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:.65rem;margin-bottom:1rem';

    colors.forEach(code => {
      const data = BOSS_DATA[code];
      if (!data) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'primary-button';
      btn.style.cssText = 'text-align:left;padding:.75rem 1rem;line-height:1.35';
      btn.innerHTML = `<strong>${data.medaglioneName}</strong><br><span style="font-size:.9em;opacity:.9">${data.powerDesc}</span>`;
      btn.onclick = () => {
        el.classList.add('hidden');
        resolve(code);
      };
      list.append(btn);
    });

    panel.append(title, subtitle, list);
    el.append(panel);
    el.classList.remove('hidden');
  });
}

/** Dialogo semplice della Mummia (testo + bottone Continua). */
function showMummyDialog(text) {
  return new Promise(resolve => {
    let el = $('mummy-story-dialog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mummy-story-dialog';
      el.className = 'card-detail-overlay';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.style.zIndex = '150';
      stageRoot().append(el);
    }
    el.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.cssText = 'width:min(92vw,440px);margin:auto;padding:1.3rem 1.2rem;text-align:center;border:1px solid #d5a758;box-shadow:0 12px 48px #000';

    const body = document.createElement('p');
    body.style.cssText = 'margin:0 0 1.2rem;line-height:1.5;font-size:1.08rem;white-space:pre-line';
    body.textContent = text;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary-button';
    btn.textContent = 'Continua';
    btn.onclick = () => { el.classList.add('hidden'); resolve(); };

    panel.append(body, btn);
    el.append(panel);
    el.classList.remove('hidden');
  });
}

/** Dopo una vittoria in Storia: aggiorna progressi e propone il prossimo passo.
 *  Prima pulisce la griglia, poi mostra la schermata di complimenti della Mummia. */
async function handleStoryVictory() {
  let progress = getStoryProgress();
  if (!progress) return;

  const justBeaten = progress.currentBoss;
  if (!justBeaten) return;

  // Segna il boss come battuto
  if (justBeaten === 'IND') {
    progress.indrazzicoBeaten = true;
    progress.completed = true;
    progress.currentBoss = null;
    saveStoryProgress(progress);
    // Marca anche la vecchia chiave per compatibilità
    try { localStorage.setItem('bellum:story-completed', '1'); } catch { /* ignore */ }

    // Schermata ad hoc: griglia via, solo complimenti della Mummia
    clearMatchUI();
    await showMummyDialog(BOSS_DATA.IND.mummyAfter + '\n\nHai ottenuto il trofeo «Abitante della Piramide»!\nLa Modalità Endless è ora sbloccata.');
    showHome();
    return;
  }

  // Boss intermedio
  if (!progress.beaten) progress.beaten = [];
  if (!progress.beaten.includes(justBeaten)) {
    progress.beaten.push(justBeaten);
  }
  progress.currentBoss = null;
  saveStoryProgress(progress);

  // Schermata ad hoc: togli la griglia vecchia, poi i complimenti della Mummia
  clearMatchUI();

  const boss = BOSS_DATA[justBeaten] || { mummyAfter: 'Hai vinto.' };
  await showMummyDialog(boss.mummyAfter);

  const remaining = getRemainingBosses(progress);
  if (remaining.length === 0) {
    // Prossimo è Indrazzico
    await showMummyDialog('Hai sconfitto tutti i guardiani dei colori.\nOra ti attende Indrazzico, l’Ombra Eterna.');
  }

  // Chiedi se continuare subito o tornare alla Home
  const continueNow = await showStoryContinueChoice(remaining.length === 0);
  if (continueNow) {
    // La griglia è già pulita: newMatch la ricostruirà da zero
    await startNextStoryFight(progress);
  } else {
    showHome();
  }
}

/** Chiede se continuare subito il prossimo boss. */
function showStoryContinueChoice(isIndrazzicoNext) {
  return new Promise(resolve => {
    let el = $('story-continue-dialog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'story-continue-dialog';
      el.className = 'card-detail-overlay';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.style.zIndex = '150';
      stageRoot().append(el);
    }
    el.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.cssText = 'width:min(92vw,420px);margin:auto;padding:1.3rem;text-align:center;border:1px solid #d5a758;box-shadow:0 12px 48px #000';

    const text = document.createElement('p');
    text.style.cssText = 'margin:0 0 1.2rem;line-height:1.45;font-size:1.05rem';
    text.textContent = isIndrazzicoNext
      ? 'Vuoi affrontare subito Indrazzico?'
      : 'Vuoi affrontare subito il prossimo boss?';

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:.8rem;justify-content:center;flex-wrap:wrap';

    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'primary-button';
    yes.textContent = 'Sì, continuo';
    yes.onclick = () => { el.classList.add('hidden'); resolve(true); };

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'secondary-button';
    no.textContent = 'Torna alla Home';
    no.onclick = () => { el.classList.add('hidden'); resolve(false); };

    actions.append(yes, no);
    panel.append(text, actions);
    el.append(panel);
    el.classList.remove('hidden');
  });
}

async function recoverPrior() {
  if (!priorMatch || busy) return;
  const id = priorMatch.id; busy = true; controls();
  try {
    const result = await api(`/match/${encodeURIComponent(id)}`);
    if (result.state?.state_version !== 4) throw new Error('Partita non più compatibile: avvia una nuova partita.');
    matchId = id; state = result.state; flow = null; priorMatch = null; deathDraft = {choiceId:null,instanceIds:[]};
    localStorage.setItem('bellum:last-match',matchId); hideStart(); hideHome(); close(); closeGraveyard(); closeColorDialog();
  } catch(e) { fail(e); }
  finally {
    busy = false; await render().catch(fail);
    if (state) { try { await logs(); } catch(e) { console.warn(e); } notice('Partita precedente ripristinata.','success'); queuePresentation(true); }
  }
}

function showCurseDialog(humanColors, aiColors) {
  return new Promise(resolve => {
    let el = $('curse-dialog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'curse-dialog';
      el.className = 'card-detail-overlay';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.style.zIndex = '140';
      stageRoot().append(el);
    }
    const tertiary = humanColors?.tertiary;
    const tName = deckFactionNames[tertiary] || tertiary || 'sconosciuto';
    const iris = (typeof FACTION_EYE !== 'undefined' && FACTION_EYE[tertiary]) || '#e8c565';
    el.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.cssText = 'width:min(92vw,440px);margin:auto;padding:1.3rem 1.2rem;text-align:center;border:1px solid #d5a758;box-shadow:0 12px 48px #000';
    const body = document.createElement('p');
    body.style.cssText = 'margin:0 0 .6rem;line-height:1.5;font-size:1.08rem;';
    body.textContent = `Un’ombra ti sfiora. Ora ${tName} fa parte di te.`;
    const eyes = document.createElement('div');
    eyes.setAttribute('aria-hidden', 'true');
    eyes.style.cssText = 'display:flex;gap:2.2rem;justify-content:center;align-items:center;margin:.7rem 0 1.1rem;';
    for (let i = 0; i < 2; i++) {
      const eye = document.createElement('div');
      eye.style.cssText = `width:52px;height:52px;border-radius:50%;background:#0b0806;border:3px solid #3a2e1a;box-shadow:0 0 18px ${iris}88, inset 0 0 12px #000;display:flex;align-items:center;justify-content:center;`;
      const pupil = document.createElement('div');
      pupil.style.cssText = `width:22px;height:22px;border-radius:50%;background:${iris};box-shadow:0 0 10px ${iris},0 0 2px #fff8;`;
      eye.append(pupil);
      eyes.append(eye);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary-button';
    btn.textContent = 'Affronto il destino';
    btn.onclick = () => { el.classList.add('hidden'); resolve(); };
    panel.append(body, eyes, btn);
    el.append(panel);
    el.classList.remove('hidden');
  });
}
/** Popup moneta egizia: chi inizia la partita (dopo la maledizione). */
function showCoinFlip(firstIsHuman) {
  return new Promise(resolve => {
    let el = $('coin-flip-dialog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'coin-flip-dialog';
      el.className = 'card-detail-overlay';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.style.zIndex = '145';
      stageRoot().append(el);
    }
    el.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.cssText = 'width:min(92vw,400px);margin:auto;padding:1.4rem 1.2rem;text-align:center;border:1px solid #d5a758;box-shadow:0 12px 48px #000';
    const label = document.createElement('p');
    label.style.cssText = 'margin:0 0 .6rem;font-family:"Nunito",system-ui,sans-serif;font-weight:700;color:#5a3410';
    label.textContent = 'La moneta del destino gira…';
    const coin = document.createElement('div');
    coin.className = 'coin-flip-disk';
    coin.setAttribute('aria-hidden', 'true');
    coin.innerHTML = `<svg viewBox="0 0 120 120" width="110" height="110">
      <circle cx="60" cy="60" r="56" fill="#e8c565" stroke="#8a5a14" stroke-width="6"/>
      <circle cx="60" cy="60" r="44" fill="none" stroke="#c9a043" stroke-width="3"/>
      <path d="M60 22 L66 48 L94 48 L72 64 L80 92 L60 76 L40 92 L48 64 L26 48 L54 48 Z" fill="#4a1f08" opacity=".85"/>
      <text x="60" y="108" text-anchor="middle" font-size="9" fill="#4a1f08" font-family="Georgia,serif">RA</text>
    </svg>`;
    const result = document.createElement('p');
    result.style.cssText = 'margin:1rem 0 .4rem;font-family:"Lilita One",Georgia,serif;font-size:1.35rem;color:#e8c565;letter-spacing:.02em';
    const foe = opponentDisplayName();
    result.textContent = firstIsHuman ? 'Inizi tu' : `Inizia ${foe}`;
    const sub = document.createElement('p');
    sub.style.cssText = 'margin:0 0 1.1rem;font-size:.95rem;line-height:1.4';
    sub.textContent = firstIsHuman
      ? 'Primo turno: mana massimo 1. Tocca una carta quando sei pronto.'
      : `${foe} muove per prima. Mana massimo 1. Osserva e preparati.`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary-button';
    btn.textContent = 'Continua';
    btn.onclick = () => { el.classList.add('hidden'); resolve(); };
    panel.append(label, coin, result, sub, btn);
    el.append(panel);
    el.classList.remove('hidden');
  });
}
async function newMatch(primaryColor, secondaryColor, options = {}) {
  cardLoaded.clear();
  lastPhaseKey = null;
  if (busy || obligatory()) return;
  busy = true; controls();
  if ($('deck-color-confirm')) $('deck-color-confirm').disabled = true;
  // Niente popup «Creazione partita / Ho capito»: solo feedback sul form.
  if ($('deck-color-validation')) $('deck-color-validation').textContent = 'Il patto si sta sigillando…';
  try {
    // Body base +, in Storia: vita boss, Medaglione, terziario stabile, colore del boss IA
    const createBody = { primaryColor, secondaryColor };
    if (options.tertiaryColor) createBody.tertiaryColor = options.tertiaryColor;
    /** Boss scelto prima della create (usato dopo per currentBoss e dialoghi). */
    let pendingStoryBoss = null;

    if (currentMode === 'story') {
      let progress = getStoryProgress();
      const allSix = ['CHI', 'INF', 'PES', 'BUL', 'GRO', 'CLO'];
      let tertiaryForCreate = null;
      let aiLife = 20;

      if (progress && progress.primary && progress.tertiary) {
        // —— Continua Storia già iniziata ——
        // Un solo sorteggio del boss (usato sia per dialoghi che per aiPrimary)
        pendingStoryBoss = pickNextBoss(progress);
        tertiaryForCreate = progress.tertiary;
        const remaining = getRemainingBosses(progress);
        const fightIndex = getStoryFightIndex(progress);
        aiLife = remaining.length === 0 ? 20 : getBossLifeForFight(fightIndex);

        // 3ª partita: scegli il Medaglione PRIMA di creare, così vale subito (una sola volta)
        if (fightIndex === 2 && !progress.chosenPower) {
          const bossPreview = BOSS_DATA[pendingStoryBoss] || { name: pendingStoryBoss };
          await showMummyDialog(
            `Oh no! ${bossPreview.name} sta barando!\nSta usando il suo Medaglione!\n\nTieni, prendi… usa uno di questi cheat code, presto!`
          );
          const chosen = await showCheatCodeChoice(progress);
          if (chosen) {
            progress = getStoryProgress() || progress;
            progress.chosenPower = chosen;
            saveStoryProgress(progress);
            const med = BOSS_DATA[chosen];
            await showMummyDialog(
              `Hai attivato il ${med.medaglioneName}!\n«${med.powerDesc}»`
            );
          }
          progress = getStoryProgress() || progress;
        }
      } else {
        // —— Nuova Storia: terziario + primo boss scelti lato client ——
        const candidates = allSix.filter(c => c !== primaryColor && c !== secondaryColor);
        tertiaryForCreate = options.tertiaryColor && candidates.includes(options.tertiaryColor)
          ? options.tertiaryColor
          : candidates[Math.floor(Math.random() * candidates.length)];
        const remainingForBoss = candidates.filter(c => c !== tertiaryForCreate);
        pendingStoryBoss = remainingForBoss[Math.floor(Math.random() * remainingForBoss.length)];
        aiLife = 20;
      }

      // Medaglione del boss: solo dalla 3ª lotta (fightIndex >= 2) e non su Indrazzico
      const bossFightIndex = progress && progress.tertiary
        ? getStoryFightIndex(progress)
        : 0;
      const aiMedallion =
        pendingStoryBoss &&
        pendingStoryBoss !== 'IND' &&
        bossFightIndex >= 2
          ? pendingStoryBoss
          : null;

      createBody.story = {
        aiStartingLife: aiLife,
        humanMedallion: progress?.chosenPower || null,
        aiMedallion,
        tertiaryColor: tertiaryForCreate,
        aiPrimary: pendingStoryBoss, // colore boss oppure 'IND'
        aiDisplayName: pendingStoryBoss && BOSS_DATA[pendingStoryBoss]?.name
          ? BOSS_DATA[pendingStoryBoss].name
          : null,
      };
    }
    const result = await api('/match/create', { method: 'POST', body: createBody });
    presentationGeneration++;
    presentationLayer().style.display = 'none';
    matchId = result.match_id;
    state = result.state;
    flow = null;
    deathDraft = { choiceId: null, instanceIds: [] };
    close();
    closeGraveyard();
    hideStart();
    hideStoryStart();
    hideHome(); // importante: dopo anima scene la Home resta aperta e copre stage/dialoghi
    closeColorDialog();
    localStorage.setItem('bellum:last-match', matchId);

    const humanColors = state?.deck_colors?.[1];
    const aiColors = state?.deck_colors?.[0];

    // --- Modalità Storia ---
    // Ordine corretto:
    //   Nuova Storia → Maledizione → Dialogo boss → Moneta → Partita
    //   Continua     → Dialogo boss → Moneta → Partita
    // Il boss (pendingStoryBoss) è già stato scelto PRIMA della create e passato come aiPrimary.
    const isStory = currentMode === 'story';
    const isNewStoryRun = isStory && (options.isNewStory || !getStoryProgress());

    if (isStory) {
      let progress = getStoryProgress();
      const nextBoss = pendingStoryBoss || (progress ? pickNextBoss(progress) : null);

      if (isNewStoryRun || !progress) {
        progress = {
          primary: humanColors?.primary || primaryColor,
          secondary: humanColors?.secondary || secondaryColor,
          tertiary: humanColors?.tertiary,
          beaten: [],
          indrazzicoBeaten: false,
          chosenPower: null,
          completed: false,
          currentBoss: nextBoss,
        };
        saveStoryProgress(progress);
      } else {
        // Continua: aggiorna currentBoss e allinea il terziario a quello del server
        progress.currentBoss = nextBoss;
        if (humanColors?.tertiary) progress.tertiary = humanColors.tertiary;
        saveStoryProgress(progress);
      }

      // 1) Maledizione solo se è una NUOVA Storia e non già mostrata nella scena anima
      if (isNewStoryRun && !options.curseAlreadyShown) {
        await showCurseDialog(humanColors, aiColors);
      }

      // 2) Presenta il boss (niente seconda scelta del Medaglione: già fatta prima della create)
      const fightIndex = getStoryFightIndex(progress);
      const boss = BOSS_DATA[nextBoss] || { name: nextBoss, threat: '…' };

      if (nextBoss === 'IND') {
        await showMummyDialog(`È arrivato il momento. Affronterai ${boss.name}.\n${boss.threat}`);
        await showMummyDialog(
          'Indrazzico appare con una forza spaventosa…\n\n«Ora stanno esagerando… ci penso io.»\n\nLa Mummia riduce i suoi punti vita a 20.\nLa lotta sarà comunque durissima.'
        );
        if (progress.chosenPower && BOSS_DATA[progress.chosenPower]) {
          const med = BOSS_DATA[progress.chosenPower];
          await showMummyDialog(`Il tuo ${med.medaglioneName} è ancora attivo:\n«${med.powerDesc}»`);
        }
      } else {
        await showMummyDialog(`Il prossimo avversario è ${boss.name}.\n${boss.threat}`);

        if (fightIndex < 2) {
          await showMummyDialog('Preparati, sarà una sfida impegnativa.');
        } else if (progress.chosenPower && BOSS_DATA[progress.chosenPower]) {
          // Fight 3+: ricorda solo il Medaglione già attivo (scelta fatta prima della create)
          const med = BOSS_DATA[progress.chosenPower];
          await showMummyDialog(`Il tuo ${med.medaglioneName} è attivo:\n«${med.powerDesc}»`);
        }
      }

      // 3) Moneta del destino
      await showCoinFlip(state?.active_player_index === 1);
    } else {
      // Modalità normale / Endless: maledizione + moneta (salta se già in scena anima)
      if (!options.curseAlreadyShown) {
        await showCurseDialog(humanColors, aiColors);
      }
      await showCoinFlip(state?.active_player_index === 1);
    }

    const uname = usernameFromEmail((await getCurrentUser())?.email) || 'coraggioso';
    const bless = `Che le bestie divine ti assistano, ${uname}.`;
    const desk = $('narrator-desk-speech');
    if (desk) desk.textContent = bless;
    await notice(bless, 'success');
    await render();
    await logs();
    // Ogni partita apre con Manatenimento + Svolgimento del primo giocatore (anche se il motore è già in main).
    lastPhaseKey = null;
    await scanPhases(['upkeep', 'main'], state.active_player_index, state.current_turn ?? 1);
  } catch (e) {
    fail(e);
    if ($('deck-color-validation')) {
      $('deck-color-validation').textContent = e instanceof Error ? e.message : 'Impossibile creare la partita.';
    }
  } finally {
    busy = false;
    if ($('deck-color-confirm')) $('deck-color-confirm').disabled = false;
    await render().catch(fail);
    queuePresentation();
  }
}
async function refreshMatch() {
  if (busy || !matchId) return; busy = true; controls();
  try {
    state = (await api(`/match/${encodeURIComponent(matchId)}`)).state;
    flow = null; close(); closeGraveyard(); await render(); await logs(); notice('Aggiornato.','success');
  } catch(e) { fail(e); }
  finally { busy = false; await render().catch(fail); queuePresentation(); }
}
async function init() {
  if (initialized) return;
  const user = await getCurrentUser(); if (!user) return;
  initialized = true;
  if ($('signed-in-user')) $('signed-in-user').textContent = `@${usernameFromEmail(user.email)}`;
  if ($('player-title')) $('player-title').textContent = usernameFromEmail(user.email) || 'Tu';
  overlay(); reactionDialog(); choiceDialog(); graveyardDialog(); wireGraveyards(); wireMenu(); wireSettings(); wireNoticeDismiss(); fitStage();
  $('cancel-selection-button')?.addEventListener('click',() => {
    if (obligatory()) return;
    if (flow?.kind === 'trap-target') { flow = null; render().catch(fail); notice('Scegli un’altra Trappola o passa.'); return; }
    if (!pending() && !reaction()) { flow = null; close(); render().catch(fail); notice('Selezione annullata.'); }
  });
  $('end-turn-button')?.addEventListener('click',() => { if (active()) request('end-turn',{},''); });
  $('logout-button')?.addEventListener('click',() => signOut().then(() => { presentationGeneration++; presentationLayer().style.display = 'none'; matchId = null; state = null; flow = null; priorMatch = null; deathDraft = {choiceId:null,instanceIds:[]}; close(); closeGraveyard(); closeColorDialog(); hideHome(); hideStart(); hideStoryStart(); reactionDialog().classList.add('hidden'); choiceDialog().classList.add('hidden'); }).catch(fail));
  document.addEventListener('keydown',e => { if (e.key === 'Escape' && !obligatory()) { if (!$('anima-scene')?.classList.contains('hidden') && !busy) closeColorDialog(); else if (!$('graveyard-dialog')?.classList.contains('hidden')) closeGraveyard(); else if (view) close(); } });
  await render();
  // NON mostriamo la Home qui: solo dopo che l’utente ha confermato «Sono io» o ha fatto login
  // (evento bellum:auth-ready).
}
// Solo dopo conferma identità (login o «Sono io») mostriamo la Home.
// Importante: showHome() SUBITO (sincrono) così non si vede la griglia vuota
// mentre claimDeviceAndSync parla col server.
window.addEventListener('bellum:auth-ready', () => {
  try { showHome(); } catch (_) { /* ignore */ }
  init()
    .then(() => claimDeviceAndSync())
    .then(() => showHome()) // aggiorna trofeo / endless dopo sync
    .catch(fail);
});
// Se c’è già sessione, prepariamo i listener ma NON mostriamo ancora la Home
// (l’utente deve prima cliccare «Sono io»)
getCurrentUser().then(user => {
  if (user) return init();
}).catch(fail);
wireStage();
// Impostazioni subito (anche sulla schermata login)
try { wireSettings(); } catch (_) { /* ignore */ }
