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
const costText = d => d.card_type === 'mostrissimo' ? `✦${Number(d.sacrifice_cost ?? 0)}` : `⚡${Number(d.mana_cost ?? 0)}`;
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
    if (t && t.id !== 'reduce-motion-toggle') setOpen(false);
  });
  document.addEventListener('click',e => { if (!panel.classList.contains('hidden') && !panel.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown',e => { if (e.key === 'Escape' && !panel.classList.contains('hidden')) setOpen(false); });
  wireReduceMotion();
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

  const el = $('phase-banner') || $('game-message');
  if (!el) return Promise.resolve();

  if (el.id === 'game-message') {
    el.textContent = msg;
    el.className = `game-message ${type}`;
    return Promise.resolve();
  }

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
async function api(path,options={}) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sessione scaduta, accedi di nuovo.');
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(),45000);
  try {
    const res = await fetch(`${API}${path}`,{
      method:options.method ?? 'GET',
      headers:{Authorization:`Bearer ${token}`,...(options.body !== undefined ? {'Content-Type':'application/json'} : {})},
      body:options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal:abort.signal,cache:'no-store',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  } catch(e) {
    if (e?.name === 'AbortError') throw new Error('Render non risponde entro 45 secondi. Aggiorna prima di riprovare: la richiesta potrebbe essere stata salvata.');
    throw e;
  } finally { clearTimeout(timer); }
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
    const isEtb = selected.task?.source === 'on_play';
    if (isEtb) {
      // ETB dopo ingresso: popup con anteprima + testo → «Ho capito» → griglia.
      title.textContent = 'Effetto in entrata';
      const fxText = plainText(d) || 'Nessun testo effetto.';
      text.innerHTML = `Hai evocato <strong>${escape(d.name)}</strong>.<br>Si attiva il suo effetto in entrata:<br><em>${escape(fxText)}</em>`;
      const preview = document.createElement('div');
      preview.style.cssText = 'margin:.6rem auto;max-width:200px';
      preview.innerHTML = cardHTML(d, true);
      options.append(preview);
      actions.append(button('Ho capito', async () => {
        if (busy || deathTarget()?.choice_id !== selected.choice_id) return;
        flow = {
          kind: 'etb-target',
          choiceId: selected.choice_id,
          eligible: selected.eligible_instance_ids ?? [],
          sourceId: selected.task?.source_instance_id,
        };
        el.classList.add('hidden');
        await drawBoard();
        notice('ora scegli il bersaglio', 'success');
      }));
    } else {
      title.textContent = 'Bersaglio dell’effetto';
      text.textContent = `${d.name}: scegli il bersaglio. La scelta è obbligatoria e si risolve prima dell’effetto successivo.`;
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
        options.append(button(`IA · giocatore avversario · PV ${them()?.life ?? '?'}`,() => {
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
    const who = a.actor === 0 ? 'Mummy' : a.actor === 1 ? 'Tu' : 'Qualcuno';
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
    if (a.actor === 0) who = 'Mummy';
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
  await new Promise(resolve => {
    const done = () => {
      if (generation !== presentationGeneration) { resolve(); return; }
      layer.style.display = 'none';
      layer.replaceChildren();
      document.body.classList.remove('notice-open');
      layer.onclick = null;
      resolve();
    };
    ok.onclick = e => { e.stopPropagation(); done(); };
    layer.onclick = e => { if (e.target === layer) done(); };
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
        if (state.status !== 'running' || state.pending_reaction || obligatory() || !state.work_queue?.length) break;
        busy = true; controls();
        try {
          state = (await api(`/match/${encodeURIComponent(id)}/advance`,
            {method:'POST',body:{expectedAnnouncementId:a.id}})).state;
          await render(); await logs();
          await ensurePhaseBanner().catch(fail);
        } catch(e) {
          fail(e);
          try { state = (await api(`/match/${encodeURIComponent(id)}`)).state; await render(); } catch(refreshError) { console.warn(refreshError); }
          break;
        } finally { busy = false; await render().catch(fail); }
        if (state.public_announcement?.id === a.id) break;
      }
    } finally { presentationRunning = false; }
  })();
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
    add(direct ? 'Attacca direttamente IA' : 'Attacca · 0 mana',() => {
      if (direct) return request('attack',{attackerPosition:current.position,target:{type:'player',playerIndex:0}},'Attacco dichiarato.');
      flow = {kind:'attack',from:current.position}; close(); render().catch(fail); notice('Tocca il nemico evidenziato.','success');
    });
    if (direct && attackable(current.position).length) add('Attacca Terraforma · 0 mana',() => { flow = {kind:'attack',from:current.position}; close(); render().catch(fail); notice('Tocca la Terraforma nemica evidenziata.','success'); });
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
  if (kind === 'tribute' && pending() && pending().stage === 'paying' && pending().paid.length < pending().required) add('Conferma sacrificio',() => request('mostrissimo/sacrifice',{instanceId:current.instanceId},'Sacrificio dichiarato.'));
  add('Chiudi',close);
  $('card-detail-overlay').classList.remove('hidden'); document.body.classList.add('detail-open');
}
async function beginCard(instanceId,d) {
  if (!playable(d)) return;
  close(); flow = {kind:'hand',instanceId,id:d.id,step:(d.card_type === 'monster' || d.card_type === 'terraforma') ? 'cell' : (d.card_type === 'aura' || targetEffect(d)) ? 'target' : 'immediate'};
  if (flow.step === 'immediate') return request('play-card',{cardInstanceId:instanceId,options:{}},'Carta dichiarata.');
  await render(); notice(flow.step === 'cell' ? 'Scegli una cella libera della tua riga.' : 'Scegli una creatura bersaglio.','success');
}
function playable(d) {
  if (!active() || d.card_type === 'mostrissimo' || d.card_type === 'instant' || Number(d.mana_cost) > me().current_mana) return false;
  if ((d.card_type === 'monster' || d.card_type === 'terraforma') && !board()[2].some(c => !c)) return false;
  if (d.card_type === 'aura' && !targets(d).length) return false;
  if (!creature(d) && d.card_type !== 'aura' && targetEffect(d) && !hasTargets(d)) return false;
  return true;
}
/** Troppo cara rispetto al mana massimo del turno (bende mummia). Vale anche per trappole/instant. */
function tooExpensive(d) {
  if (!d || d.card_type === 'mostrissimo') return false;
  return Number(d.mana_cost ?? 0) > Number(me()?.max_mana ?? 0);
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
    const slot = $('offer-slot'), before = document.querySelector('.logs-panel') ?? $('game-message');
    if (slot) slot.append(panel); else if (before?.parentNode) before.parentNode.insertBefore(panel,before); else document.body.append(panel);
  }
  panel.replaceChildren();
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
    // Stessa logica visiva della mano: bende se non puoi pagare; lampeggio se evocabile ora.
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
  const p = pending(); if (!p) return;
  const zone = document.createElement('div'); zone.className = 'tribute-zone is-info'; panel.append(zone);
  const info = document.createElement('p'); info.className = 'tribute-progress';
  info.textContent = p.stage === 'etb' ? 'Risoluzione degli effetti all’entrata…' : p.stage === 'before_entry' ? 'Evocazione dichiarata: attendi la reazione.' : `Sacrifici ${p.paid.length}/${p.required}. Non puoi annullare.`;
  zone.append(info);
  if (p.stage !== 'paying' || reaction() || obligatory()) return;
  if (p.paid.length < p.required) {
    zone.className = 'tribute-zone is-select';
    const list = document.createElement('div'); list.className = 'tribute-list';
    for (const item of permanents()) {
      const d = await card(item.card_id), b = document.createElement('button');
      b.type = 'button'; b.textContent = `${item.type}: ${d.name}`; b.disabled = busy;
      b.onclick = () => inspect('tribute',item.card_id,{instanceId:item.id}); list.append(b);
    }
    zone.append(list);
  } else {
    const msg = document.createElement('p'); msg.className = 'tribute-hint'; msg.textContent = flow?.kind === 'mostrissimo-target' ? 'Tocca il bersaglio dell’effetto all’entrata.' : 'Tocca una cella evidenziata.'; zone.append(msg);
  }
}
function controls() {
  const disable = (id,v) => { if ($(id)) $(id).disabled = !!v; };
  disable('new-match-button',busy || obligatory()); disable('end-turn-button',!active()); disable('refresh-button',busy || !matchId);
  disable('cancel-selection-button',busy || obligatory() || !flow || (!!pending() && flow?.kind !== 'trap-target'));
  // Riga sotto la griglia disabilitata: non fa «saltare» il layout.
  // Le indicazioni restano nei notice/popup (Ho capito).
  if ($('selection-instructions')) {
    $('selection-instructions').textContent = '';
    $('selection-instructions').hidden = true;
  }
}
function showDeckColors() {
  const human = state?.deck_colors?.[1], ai = state?.deck_colors?.[0];
  if ($('player-deck-colors')) $('player-deck-colors').textContent = human ? `Mazzo: ${human.primary} · ${human.secondary} · ${human.tertiary}` : '';
  if ($('opponent-deck-colors')) $('opponent-deck-colors').textContent = ai ? `Mazzo: ${ai.primary} · ${ai.secondary} · ${ai.tertiary}` : '';
}
async function render() {
  const set = (id,x) => { if ($(id)) $(id).textContent = String(x); };
  if (state) { hideStart(); hideHome(); }
  set('player-life',me()?.life ?? 20); set('player-current-mana',me()?.current_mana ?? 0); set('player-max-mana',me()?.max_mana ?? 0);
  set('player-hand-count',me()?.hand?.length ?? 0); set('player-deck-count',me()?.deck?.length ?? 0); set('player-graveyard-count',me()?.graveyard?.length ?? 0);
  set('opponent-life',them()?.life ?? 20); set('opponent-current-mana',them()?.current_mana ?? 0); set('opponent-max-mana',them()?.max_mana ?? 0);
  set('opponent-hand-count',them()?.hand?.length ?? 0); set('opponent-deck-count',them()?.deck?.length ?? 0); set('opponent-graveyard-count',them()?.graveyard?.length ?? 0);
  showDeckColors(); drawOpponentHand();
  await drawBoard(); await drawHand(); await drawMostrissimi(); controls(); await renderReaction(); await renderDeathChoice(); await markPlayerTarget();
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
async function request(path, body, message) {
  if (busy || !matchId) return;
  close(); busy = true; controls(); reactionDialog().classList.add('hidden'); choiceDialog().classList.add('hidden');
  try {
    state = (await api(`/match/${encodeURIComponent(matchId)}/${path}`, { method: 'POST', body })).state;
    flow = null;
    await render();
    try { await logs(); } catch (e) { console.warn(e); }

    if (state.status === 'finished') {
      const won = state.winner_index === 1;
      await notice(won ? 'HAI VINTO!' : 'HAI PERSO!', won ? 'success' : 'error');

      if (won && currentMode === 'story') {
        // ---------- VITTORIA IN STORIA ----------
        await handleStoryVictory();
      } else if (!won) {
        // Sconfitta: anima persa → torna alla mummia
        localStorage.removeItem('bellum:last-match');
        matchId = null;
        state = null;
        flow = null;
        priorMatch = null;
        deathDraft = { choiceId: null, instanceIds: [] };
        presentationGeneration++;
        presentationLayer().style.display = 'none';
        close();
        closeGraveyard();
        closeColorDialog();
        hideStoryStart();
        hideHome();
        reactionDialog().classList.add('hidden');
        choiceDialog().classList.add('hidden');

        // Se eravamo in Modalità Storia → azzera i progressi (morte del personaggio)
        if (currentMode === 'story') {
          clearStoryProgress();
          notice('Sei caduto nella piramide. Le tue spoglie sono state perdute.', 'error');
        }

        setTimeout(() => showAuthScreen(), 1200);
      }
    } else {
      // Un solo canale: phase-banner. Evita messaggi generici fuori tempo
      // (es. «È di nuovo il tuo turno» mentre è ancora il turno IA).
      let text = null;
      let kind = 'success';
      if (state.mostrissimo_result?.outcome === 'failed') {
        text = state.mostrissimo_result.message; kind = 'error';
      } else if (deathOrder()) text = 'Scegli l’ordine delle creature morte.';
      else if (deathTarget()) text = 'Scegli il bersaglio dell’effetto alla morte.';
      else if (state.pending_reaction) text = reactionDescription(state.pending_reaction.event);
      // Niente «Carta/Creatura dichiarata»: resta solo l'anteprima pubblica della carta.
      else if (message && !(path === 'end-turn' && state.active_player_index !== 1)
        && !/dichiarat/i.test(message)) text = message;
      if (text) await notice(text, kind);
    }
  } catch (e) {
    fail(e);
    try {
      state = (await api(`/match/${encodeURIComponent(matchId)}`)).state;
      flow = null;
    } catch (refreshError) {
      console.warn(refreshError);
    }
  } finally {
    busy = false;
    await render().catch(fail);
    // Fine turno umano: sempre popup CHIUSURA (anche se il motore è già passato all'IA).
    if (path === 'end-turn' && state) {
      // Se l'IA ha già avviato il suo turno, current_turn è avanzato → chiusura = turno precedente.
      const endedTurn = state.active_player_index === 0
        ? Math.max(1, (state.current_turn ?? 1) - 1)
        : (state.current_turn ?? 1);
      await presentPhase('end', 1, endedTurn, state.players?.[1]?.max_mana ?? 0).catch(fail);
    } else {
      await ensurePhaseBanner().catch(fail);
    }
    queuePresentation();
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
  // Durante scelta ETB post-ingresso il motore è in pending_target_choice (obligatory): i click restano attivi.
  if (busy || noticeOpen) return;
  if (obligatory() && flow?.kind !== 'etb-target') return;
  if (flow?.kind === 'etb-target') {
    const c = at(pos);
    if (!c || !(flow.eligible ?? []).includes(c.instance_id)) return notice('Bersaglio non valido.','error');
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
    return request('mostrissimo/complete',{position:flow.position,targetInstanceId:c.instance_id},'Mostrissimo dichiarato.');
  }
  if (p) {
    if (p.stage !== 'paying') return;
    if (p.paid.length < p.required) {
      if (c?.owner_index === 1) return inspect('tribute',c.card_id,{instanceId:c.instance_id});
      return notice('Scegli un tuo permanente nell’elenco dei sacrifici.','error');
    }
    if (c || !summonCells(p).some(x => eq(x,pos))) return notice('Cella non valida.','error');
    const d = await card(p.card_id);
    // Sempre chiedere il bersaglio ETB se la carta è mirata (anche solo se stessa).
    if (targetEffect(d)) {
      flow = {kind:'mostrissimo-target',position:pos,id:d.id}; await render(); notice('ora scegli il bersaglio','success'); return;
    }
    return request('mostrissimo/complete',{position:pos},'Mostrissimo dichiarato.');
  }
  if (flow?.kind === 'hand') {
    const d = await card(flow.id);
    if (flow.step === 'cell') {
      if (c || pos.row !== 2) return notice('Scegli una cella libera della tua riga.','error');
      flow.position = pos;
      // Mostro: entra in campo subito; l’ETB mirato apre la scelta bersaglio dopo (creatura già visibile).
      return request('play-card',{cardInstanceId:flow.instanceId,options:{position:pos}},'Carta dichiarata.');
    }
    if (flow.step === 'target') {
      if (!targetAllowed(d,c)) return notice('Bersaglio non valido.','error');
      return request('play-card',{cardInstanceId:flow.instanceId,options:{...(flow.position ? {position:flow.position} : {}),targetInstanceId:c.instance_id}},creature(d) ? 'Creatura dichiarata.' : 'Carta dichiarata.');
    }
  }
  if (flow?.kind === 'move') {
    if (!steps(flow.from).some(x => eq(x,pos))) return notice('Scegli una cella libera adiacente.','error');
    return request('move',{from:flow.from,to:pos},'Movimento dichiarato.');
  }
  if (flow?.kind === 'attack') {
    if (!attackable(flow.from).some(x => eq(x,pos))) return notice('Scegli un nemico adiacente evidenziato.','error');
    return request('attack',{attackerPosition:flow.from,target:{type:'creature',position:pos}},'Attacco dichiarato.');
  }
  if (c) return inspect('unit',c.card_id,{position:pos,cell:c});
}
function colorDialog() {
  let el = $('deck-color-dialog');
  if (el) return el;
  el = document.createElement('div'); el.id = 'deck-color-dialog'; el.className = 'card-detail-overlay hidden';
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'deck-color-title');
  el.style.zIndex = '130';
  const panel = document.createElement('div'); panel.className = 'panel';
  panel.style.cssText = 'width:min(92vw,440px);max-height:88dvh;overflow:auto;margin:auto;padding:1.2rem;text-align:center;border:1px solid #d5a758;box-shadow:0 12px 48px #000';
  const title = document.createElement('h2'); title.id = 'deck-color-title'; title.textContent = 'Scegli i tuoi poteri';
  const form = document.createElement('form'); form.id = 'deck-color-form'; form.style.cssText = 'display:grid;gap:.8rem';
  const makeSelect = (id, text) => {
    const label = document.createElement('label'); label.textContent = text; label.style.cssText = 'display:grid;gap:.3rem;text-align:left';
    const select = document.createElement('select'); select.id = id; select.required = true;
    select.style.cssText = 'width:100%;padding:.65rem;background:#171924;color:#fff;border:1px solid #d5a758;border-radius:6px';
    for (const [code, name] of Object.entries(deckFactionNames)) {
      const option = document.createElement('option'); option.value = code; option.textContent = `${name} (${code})`; select.append(option);
    }
    label.append(select); return label;
  };
  form.append(
    makeSelect('deck-primary-color', 'Il colore dell’anima'),
    makeSelect('deck-secondary-color', 'Il potere dell’amuleto'),
  );
  const validation = document.createElement('p'); validation.id = 'deck-color-validation';
  validation.setAttribute('role', 'alert'); validation.style.color = '#ffbd92'; form.append(validation);
  const actions = document.createElement('div'); actions.style.cssText = 'display:flex;justify-content:center;flex-wrap:wrap;gap:.6rem';
  const confirm = document.createElement('button'); confirm.type = 'submit'; confirm.className = 'primary-button';
  confirm.textContent = 'Sigilla il patto'; confirm.id = 'deck-color-confirm';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary-button';
  cancel.textContent = 'Annulla'; cancel.onclick = () => closeColorDialog();
  actions.append(confirm, cancel); form.append(actions);
  form.addEventListener('submit', e => { e.preventDefault(); submitColors().catch(fail); });
  panel.append(title, form); el.append(panel); stageRoot().append(el);
  return el;
}
function closeColorDialog() {
  $('deck-color-dialog')?.classList.add('hidden');
  // Solo se non c’è partita in corso e non stiamo creando: evita «Le spoglie…» dopo moneta/maledizione.
  if (!state && !busy && !matchId && !$('game-screen')?.classList.contains('hidden')) showStart();
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
}

function clearStoryProgress() {
  try {
    localStorage.removeItem(STORY_KEY);
    localStorage.removeItem('bellum:story-completed'); // vecchia chiave
  } catch { /* ignore */ }
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
    hideHome();
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

  el.classList.remove('hidden');
  // Nascondi gli altri overlay di avvio
  hideStart();
  closeColorDialog();
}

function hideHome() {
  $('home-dialog')?.classList.add('hidden');
}

// ---------- Schermata iniziale: recupera partita precedente / nuova partita ----------
let priorMatch = null, probing = false;
async function probePrior() {
  priorMatch = null;
  const prior = localStorage.getItem('bellum:last-match'); if (!prior) return;
  try {
    const [user,result] = await Promise.all([getCurrentUser(),api(`/match/${encodeURIComponent(prior)}`)]);
    if (result.state?.state_version === 4 && user && result.state.players?.[1]?.user_id === user.id && result.state.status !== 'finished') priorMatch = {id:prior};
  } catch(e) { console.warn('Ripristino non disponibile',e); }
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
  if ($('deck-color-dialog') && !$('deck-color-dialog').classList.contains('hidden')) return;
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
  el.className = 'card-detail-overlay start-dialog hidden';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'story-start-title');
  el.style.zIndex = '120';

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
    // Inizia una nuova Storia → scelta colori
    openColorDialogForStory();
  };

  actions.append(recover, fresh);
  panel.append(title, text, actions);
  el.append(panel);
  stageRoot().append(el);
  return el;
}

function showStoryStart() {
  if (state || busy) return;
  const el = storyStartDialog();
  const progress = getStoryProgress();
  const hasProgress = !!(progress && !progress.completed && (
    (progress.beaten && progress.beaten.length > 0) || progress.primary
  ));

  $('story-recover-button').classList.toggle('hidden', !hasProgress);
  $('story-new-button').className = hasProgress ? 'secondary-button' : 'primary-button';

  if (hasProgress) {
    const remaining = getRemainingBosses(progress);
    const beatenCount = (progress.beaten || []).length;
    let msg = `Hai già sconfitto ${beatenCount} boss.`;
    if (remaining.length > 0) {
      msg += ` Ti restano ${remaining.length} boss + Indrazzico.`;
    } else if (!progress.indrazzicoBeaten) {
      msg += ` Ti resta solo Indrazzico, l’Ombra Eterna.`;
    }
    msg += ' Vuoi riprendere le tue spoglie o abbracciare un nuovo destino?';
    $('story-start-text').textContent = msg;
  } else {
    $('story-start-text').textContent = 'Nessuna spoglia da recuperare. Puoi solo abbracciare un nuovo destino e iniziare il Cammino.';
  }

  el.classList.remove('hidden');
}

function hideStoryStart() {
  $('story-start-dialog')?.classList.add('hidden');
}

async function storyStartScreen() {
  if (state || busy) return;
  showStoryStart();
}

/** Continua una Storia già iniziata (progressi salvati). */
async function resumeStory() {
  const progress = getStoryProgress();
  if (!progress) {
    notice('Nessun progresso trovato. Inizia un nuovo destino.', 'error');
    return;
  }
  hideStoryStart();
  // Avvia direttamente il prossimo boss (stessi colori già scelti)
  currentMode = 'story';
  await startNextStoryFight(progress);
}

/** Avvia la prossima lotta della Storia (boss rimanente o Indrazzico). */
async function startNextStoryFight(progress) {
  if (!progress) return;
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

/** Dopo una vittoria in Storia: aggiorna progressi e propone il prossimo passo. */
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

    await showMummyDialog(BOSS_DATA.IND.mummyAfter + '\n\nHai ottenuto il trofeo «Abitante della Piramide»!\nLa Modalità Endless è ora sbloccata.');
    
    // Pulisci la partita e torna alla Home
    localStorage.removeItem('bellum:last-match');
    matchId = null;
    state = null;
    flow = null;
    priorMatch = null;
    deathDraft = { choiceId: null, instanceIds: [] };
    presentationGeneration++;
    presentationLayer().style.display = 'none';
    close();
    closeGraveyard();
    closeColorDialog();
    hideStoryStart();
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
    await startNextStoryFight(progress);
  } else {
    // Torna alla Home
    localStorage.removeItem('bellum:last-match');
    matchId = null;
    state = null;
    flow = null;
    priorMatch = null;
    deathDraft = { choiceId: null, instanceIds: [] };
    presentationGeneration++;
    presentationLayer().style.display = 'none';
    close();
    closeGraveyard();
    closeColorDialog();
    hideStoryStart();
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

/** Apre la scelta colori specificamente per una nuova Storia. */
function openColorDialogForStory() {
  // Per ora riusiamo la scelta colori normale.
  // In Fase 2 collegheremo la creazione partita alla Storia.
  openColorDialog();
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

function openColorDialog() {
  if (busy || reaction() || pending() || obligatory()) return;
  close(); closeGraveyard();
  hideStart(); hideHome(); // non deve restare sotto e riapparire dopo moneta/maledizione
  const el = colorDialog();
  $('deck-color-validation').textContent = '';
  if ($('deck-primary-color').value === $('deck-secondary-color').value) $('deck-secondary-color').value = 'INF';
  el.classList.remove('hidden'); $('deck-primary-color').focus();
}
async function submitColors() {
  if (busy || obligatory()) return;
  const primaryColor = $('deck-primary-color')?.value, secondaryColor = $('deck-secondary-color')?.value;
  if (!deckFactionNames[primaryColor] || !deckFactionNames[secondaryColor] || primaryColor === secondaryColor) {
    $('deck-color-validation').textContent = 'Scegli due colori diversi.'; return;
  }
  $('deck-color-validation').textContent = '';

  // Se siamo in Modalità Storia e non c’è ancora un progresso, creiamo la nuova Storia
  if (currentMode === 'story') {
    const existing = getStoryProgress();
    if (!existing || existing.completed) {
      // Nuova Storia: salveremo primary/secondary dopo la creazione partita (serve il tertiary)
      await newMatch(primaryColor, secondaryColor, { isNewStory: true });
      return;
    }
  }

  await newMatch(primaryColor, secondaryColor);
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
    el.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.style.cssText = 'width:min(92vw,440px);margin:auto;padding:1.2rem;text-align:center;border:1px solid #d5a758;box-shadow:0 12px 48px #000';
    const body = document.createElement('p');
    body.style.cssText = 'margin:0 0 .8rem;line-height:1.45;font-size:1.05rem';
    body.innerHTML = `Oh no. Un’ombra ti afferra e ti marchia.<br><strong>${tName}</strong> fa parte di te ora.`;
    const glyph = document.createElement('img');
    glyph.src = 'img/geroglifico.png';
    glyph.alt = 'Marchio geroglifico';
    glyph.width = 120;
    glyph.height = 280;
    glyph.style.cssText = 'display:block;margin:.6rem auto 1rem;max-width:120px;height:auto;filter:drop-shadow(0 0 12px rgba(232,197,101,.35))';
    glyph.onerror = () => { glyph.style.display = 'none'; };
    const wait = document.createElement('p');
    wait.style.cssText = 'margin:0 0 1.1rem;font-family:"Lilita One",Georgia,serif;font-size:1.25rem;color:#e8c565;letter-spacing:.02em';
    wait.textContent = 'La piramide ti attende';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'primary-button';
    btn.textContent = 'Affronto il destino';
    btn.onclick = () => { el.classList.add('hidden'); resolve(); };
    panel.append(body, glyph, wait, btn);
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
    result.textContent = firstIsHuman ? 'Inizi tu' : 'Inizia Mummy';
    const sub = document.createElement('p');
    sub.style.cssText = 'margin:0 0 1.1rem;font-size:.95rem;line-height:1.4';
    sub.textContent = firstIsHuman
      ? 'Primo turno: mana massimo 1. Tocca una carta quando sei pronto.'
      : 'Mummy muove per prima. Mana massimo 1. Osserva e preparati.';
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
    const result = await api('/match/create', { method: 'POST', body: { primaryColor, secondaryColor } });
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
    closeColorDialog();
    localStorage.setItem('bellum:last-match', matchId);

    const humanColors = state?.deck_colors?.[1];
    const aiColors = state?.deck_colors?.[0];

    // --- Modalità Storia ---
    // Ordine corretto:
    //   Nuova Storia → Maledizione → Dialogo boss → Moneta → Partita
    //   Continua     → Dialogo boss → Moneta → Partita
    const isStory = currentMode === 'story';
    const isNewStoryRun = isStory && (options.isNewStory || !getStoryProgress());

    if (isStory) {
      let progress = getStoryProgress();

      if (isNewStoryRun || !progress) {
        progress = {
          primary: humanColors?.primary || primaryColor,
          secondary: humanColors?.secondary || secondaryColor,
          tertiary: humanColors?.tertiary,
          beaten: [],
          indrazzicoBeaten: false,
          chosenPower: null,
          completed: false,
          currentBoss: null,
        };
        saveStoryProgress(progress);
      }

      // 1) Maledizione solo se è una NUOVA Storia
      if (isNewStoryRun) {
        await showCurseDialog(humanColors, aiColors);
      }

      // 2) Scegli e presenta il boss
      const nextBoss = pickNextBoss(progress);
      progress.currentBoss = nextBoss;
      saveStoryProgress(progress);

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
          await showMummyDialog(
            `Per ora ${boss.name} combatte senza il suo Medaglione.\nSfrutta questo vantaggio!`
          );
        }

        if (fightIndex === 2 && !progress.chosenPower) {
          await showMummyDialog(
            `Oh no! ${boss.name} sta barando!\nSta usando il suo Medaglione!\n\nTieni, prendi… usa uno di questi cheat code, presto!`
          );
          const chosen = await showCheatCodeChoice(progress);
          if (chosen) {
            progress.chosenPower = chosen;
            saveStoryProgress(progress);
            const med = BOSS_DATA[chosen];
            await showMummyDialog(
              `Hai attivato il ${med.medaglioneName}!\n«${med.powerDesc}»\n\nQuesto potere resterà attivo anche contro Indrazzico.`
            );
          }
        } else if (progress.chosenPower && BOSS_DATA[progress.chosenPower]) {
          const med = BOSS_DATA[progress.chosenPower];
          await showMummyDialog(`Il tuo ${med.medaglioneName} è attivo:\n«${med.powerDesc}»`);
        }
      }

      // 3) Moneta del destino
      await showCoinFlip(state?.active_player_index === 1);
    } else {
      // Modalità normale / Endless: maledizione + moneta come sempre
      await showCurseDialog(humanColors, aiColors);
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
  overlay(); reactionDialog(); choiceDialog(); graveyardDialog(); colorDialog(); wireGraveyards(); wireMenu(); wireNoticeDismiss(); fitStage();
  $('new-match-button')?.addEventListener('click',openColorDialog);
  $('cancel-selection-button')?.addEventListener('click',() => {
    if (obligatory()) return;
    if (flow?.kind === 'trap-target') { flow = null; render().catch(fail); notice('Scegli un’altra Trappola o passa.'); return; }
    if (!pending() && !reaction()) { flow = null; close(); render().catch(fail); notice('Selezione annullata.'); }
  });
  $('end-turn-button')?.addEventListener('click',() => { if (active()) request('end-turn',{},''); });
  $('refresh-button')?.addEventListener('click',() => refreshMatch().catch(fail));
  $('logout-button')?.addEventListener('click',() => signOut().then(() => { presentationGeneration++; presentationLayer().style.display = 'none'; matchId = null; state = null; flow = null; priorMatch = null; deathDraft = {choiceId:null,instanceIds:[]}; close(); closeGraveyard(); closeColorDialog(); hideHome(); hideStart(); hideStoryStart(); reactionDialog().classList.add('hidden'); choiceDialog().classList.add('hidden'); }).catch(fail));
  document.addEventListener('keydown',e => { if (e.key === 'Escape' && !obligatory()) { if (!$('deck-color-dialog')?.classList.contains('hidden') && !busy) closeColorDialog(); else if (!$('graveyard-dialog')?.classList.contains('hidden')) closeGraveyard(); else if (view) close(); } });
  await render();
  // NON mostriamo la Home qui: solo dopo che l’utente ha confermato «Sono io» o ha fatto login
  // (evento bellum:auth-ready).
}
// Solo dopo conferma identità (login o «Sono io») mostriamo la Home
window.addEventListener('bellum:auth-ready', () => {
  init().then(() => showHome()).catch(fail);
});
// Se c’è già sessione, prepariamo i listener ma NON mostriamo ancora la Home
// (l’utente deve prima cliccare «Sono io»)
getCurrentUser().then(user => {
  if (user) return init();
}).catch(fail);
wireStage();
