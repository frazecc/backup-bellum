import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const sb = createClient('https://dgsqxnmrjfvklnjliplh.supabase.co', 'sb_publishable_ZwwwsHnjEWNbe2CnDKsTSA_8ljXZlOG');
const BUCKET = 'card-images';
const FAC = { 1: ['CHI', 'Chiericanza'], 2: ['INF', 'Infamia'], 3: ['PES', 'Pestilenza'], 4: ['BUL', 'Bullismo'], 5: ['GRO', 'Grossanza'], 6: ['CLO', 'Clownerie'], 7: ['IND', 'Indrazzi'] };
const TYPES = { monster: 'Mostro', mostrissimo: 'Mostrissimo', maledizione: 'Maledizione', instant: 'Trappola', aura: 'Aura', terraforma: 'Terraforma' };
const RAR = { common: 'Comune', uncommon: 'Non comune', rare: 'Rara', ultra_rare: 'Ultra rara', legendary: 'Leggendaria' };
const CREA = ['monster', 'mostrissimo'];
const TRG = ['opponent_upkeep_start', 'opponent_upkeep_end', 'opponent_hand_card', 'monster_etb', 'mostrissimo_before_entry'];
const CTRG = ['opponent_hand_card', 'monster_etb', 'mostrissimo_before_entry'];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- Effetti: letti dai file in effects/ ---------- */
const CT = [['any_creature', 'Una creatura'], ['all_creatures', 'Tutte (di ENTRAMBI i campi)'], ['all_creatures_self', 'Tutte le tue'], ['all_creatures_opponent', 'Tutte le avversarie']];
const ENGINE = ['draw', 'discard', 'heal', 'damage', 'return_hand', 'destroy', 'buff', 'counter', 'movement_cost'];
const EF = {};
const REPO = localStorage.getItem('bpa_repo') || (location.hostname.endsWith('.github.io') ? `${location.hostname.split('.')[0]}/${location.pathname.split('/')[1]}` : '');
const BR = localStorage.getItem('bpa_br') || 'main';

function compile(s) {
  const fill = (t, n) => String(t).replace(/\{carte\}/g, n == 1 ? 'carta' : 'carte').replace(/\{n\}/g, n);
  return {
    l: s.label, for: s.for, when: s.when, a: !!s.amount, t: s.targets?.length ? s.targets : null, d: s.durations?.length ? s.durations : null, spec: s,
    json: (n, t, d) => Object.fromEntries(Object.entries(s.json).map(([k, v]) => [k, v === '{n}' ? n : v === '{t}' ? t : v === '{d}' ? d : v])),
    txt: (n, t, d) => { const x = fill(typeof s.text === 'string' ? s.text : s.text?.[t] ?? s.text?.default ?? '', n); return d === 'turn' && s.textTurn ? x + s.textTurn : x; }
  };
}

const keysFor = (ty) => Object.keys(EF).filter((k) => EF[k].for.includes(ty));
const defE = (key) => ({ key, n: 1, t: EF[key].t?.[0][0], d: EF[key].d?.[0][0] });

function build(e, ty) {
  if (e.raw) return e.raw;
  const j = EF[e.key].json(e.n, e.t, e.d);
  if ((ty === 'terraforma' || CREA.includes(ty)) && e.flt?.v) j.filter = { [e.flt.k]: e.flt.v };
  return ty === 'aura' || ty === 'terraforma' ? j : { ...j, timing: ty === 'instant' ? 'instant' : 'on_play' };
}

function parseEff(j, ty) {
  if (!j || typeof j !== 'object') return null;
  const t = j.type === 'damage_creature' ? 'damage' : j.type === 'nope' ? 'counter' : j.type;
  const key = Object.keys(EF).find((k) => { const s = EF[k].spec; return s.for.includes(ty) && s.json.type === t && (!s.json.stat || s.json.stat === j.stat) && (s.json.trigger ?? null) === (j.trigger ?? null) && ('keep' in s.json) === ('keep' in j) && ((s.json.duration === 'while_in_play') === (j.duration === 'while_in_play')); });
  if (!key) return { raw: j };
  const fk = j.filter ? Object.keys(j.filter) : [];
  if (j.filter && (!(ty === 'terraforma' || (CREA.includes(ty) && j.duration === 'while_in_play')) || fk.length !== 1 || !['subtype', 'faction'].includes(fk[0]))) return { raw: j };
  return { key, n: j.amount ?? j.keep ?? 1, t: j.target ?? EF[key].t?.[0][0], d: j.duration ?? EF[key].d?.[0][0], flt: fk.length ? { k: fk[0], v: j.filter[fk[0]] } : null };
}

/* ---------- Validazione ---------- */
const TG = {
  draw: ['self', 'opponent'], discard: ['self', 'opponent'],
  heal: ['self', 'opponent', ...CT.map((x) => x[0])], damage: [...CT.map((x) => x[0]), 'any_target', 'opponent'],
  return_hand: ['any_creature'], destroy: ['any_creature'],
  // all_creatures escluso: il motore applica i bonus solo alle creature di chi gioca la carta.
  buff: ['any_creature', 'all_creatures_self', 'enchanted_creature', 'triggering_creature', 'source_creature']
};

function specErr(s, id) {
  const E = [], T = s?.json?.type;
  if (!/^[a-z0-9_]+$/.test(id || '')) E.push('Il nome file può contenere solo lettere minuscole, numeri e _.');
  if (!s || typeof s !== 'object' || !s.label || !Array.isArray(s.for) || !s.for.length || !s.json || !s.text) { E.push('Servono label, for, json e text.'); return E; }
  if (s.for.some((t) => !TYPES[t])) E.push('Tipo carta non valido in "for".');
  if (!ENGINE.includes(T)) E.push(`Il motore non conosce l'effetto "${T}". Supportati: ${ENGINE.join(', ')}.`);
  else if (TG[T]) {
    if (s.targets?.some(([v]) => !TG[T].includes(v))) E.push(`Bersaglio non supportato per "${T}": bloccherebbe la partita.`);
    const f = s.json.target;
    if (f && !String(f).startsWith('{') && !TG[T].includes(f)) E.push(`Bersaglio fisso "${f}" non supportato per "${T}".`);
  }
  if (s.json.amount === '{n}' && !s.amount) E.push('Il json usa {n} ma "amount" non è true.');
  return E;
}

async function loadEffects() {
  S.badEff = [];
  let names = null;
  try {
    if (REPO) {
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/docs/admin/effects?ref=${BR}`);
      if (r.ok) names = (await r.json()).map((f) => f.name).filter((n) => n.endsWith('.json') && n !== 'index.json').map((n) => n.slice(0, -5));
    }
  } catch { /* si usa index.json */ }
  try { if (!names) names = await (await fetch('admin/effects/index.json', { cache: 'no-store' })).json(); } catch { names = []; }
  const L = await Promise.all(names.map(async (id) => {
    try {
      const r = await fetch(`admin/effects/${id}.json`, { cache: 'no-store' });
      if (!r.ok) throw new Error('file non trovato (se è appena stato creato, attendi un minuto)');
      const s = await r.json(), er = specErr(s, id);
      if (er.length) throw new Error(er[0]);
      return [id, s];
    } catch (e) { S.badEff.push(`${id}.json ignorato: ${e.message}`); return null; }
  }));
  Object.keys(EF).forEach((k) => delete EF[k]);
  L.filter(Boolean).sort((a, b) => (a[1].order || 99) - (b[1].order || 99) || a[0].localeCompare(b[0])).forEach(([id, s]) => { EF[id] = compile(s); });
  if (!Object.keys(EF).length) msg(['Nessun effetto caricato: controlla la cartella docs/admin/effects/.'], 'err');
}

const CARD_TRG = { aura: ['equipped_creature_attacks'], terraforma: ['own_monster_summoned', 'own_turn_start', 'own_creature_dies'] };
function filterErr(e, ty, t) {
  const E = [];
  if (e.filter === undefined) return E;
  const f = e.filter && typeof e.filter === 'object' && !Array.isArray(e.filter) ? e.filter : null;
  const creatureStatic = CREA.includes(ty) && t === 'buff' && e.duration === 'while_in_play';
  if (!creatureStatic && (ty !== 'terraforma' || (t !== 'buff' && e.trigger !== 'own_monster_summoned'))) E.push('I filtri per sottotipo o fazione valgono solo per i bonus continui di Terraforme, Mostri e Mostrissimi e per il trigger \"evochi una creatura\".');
  else if (!f || (f.subtype === undefined && f.faction === undefined) || Object.keys(f).some((k) => k !== 'subtype' && k !== 'faction')) E.push('Filtro non valido: indica un sottotipo e/o una fazione.');
  else {
    if (f.subtype !== undefined && (typeof f.subtype !== 'string' || !f.subtype.trim() || f.subtype.length > 60)) E.push('Filtro: sottotipo non valido.');
    if (f.faction !== undefined && !['CHI', 'INF', 'PES', 'BUL', 'GRO', 'CLO'].includes(f.faction)) E.push('Filtro: fazione non valida.');
  }
  return E;
}

// Stesse regole del backend (card-rules.ts): il controllo del motore prima del salvataggio è quello che decide.
function effErr(e, ty, trg, death = false) {
  const E = [];
  const t = e.type === 'damage_creature' ? 'damage' : e.type === 'nope' ? 'counter' : e.type;
  const amount = e.amount;
  if (amount !== undefined && !(Number.isInteger(amount) && amount >= 0 && amount <= 20)) E.push(`${t}: la quantità deve essere tra 0 e 20.`);
  if (e.keep !== undefined && (t !== 'discard' || !Number.isInteger(e.keep) || e.keep < 0 || e.keep > 20 || e.trigger !== undefined)) E.push('Scarto \"tutta la mano tranne N\": solo per lo scarto, con N tra 0 e 20 e senza trigger.');
  if (t === 'counter') {
    if (ty !== 'instant' || !CTRG.includes(trg)) E.push('NOPE: serve una Trappola con evento \"carta dalla mano\", \"ingresso mostro\" o \"prima del Mostrissimo\".');
    return E;
  }
  if (t === 'movement_cost') {
    if (ty !== 'aura' || amount !== 0) E.push('Il movimento a costo 0 vale solo per le Aure.');
    return E;
  }
  if (e.trigger !== undefined) {
    if (!CARD_TRG[ty]?.includes(e.trigger)) E.push(ty === 'aura' ? 'Le Aure usano il trigger \"quando la creatura attacca\".' : ty === 'terraforma' ? 'Le Terraforme usano i trigger \"evochi una creatura\", \"inizia il tuo turno\" o \"una tua creatura muore\".' : 'I trigger valgono solo per Aure e Terraforme.');
    else if (!Number.isInteger(amount)) E.push('Serve la quantità.');
    else if (t === 'heal' || t === 'draw') { if (e.target !== 'self') E.push(`${t}: con un trigger il bersaglio è il proprietario.`); }
    else if (t === 'discard') { if (e.target !== 'opponent') E.push('Scarta: con un trigger scarta l\'avversario.'); }
    else if (t === 'damage') { if (e.target !== 'any_target' && e.target !== 'opponent') E.push('Danno: con un trigger il bersaglio è l\'avversario o a scelta.'); }
    else if (t === 'buff') {
      if (e.target !== 'triggering_creature') E.push('Un bonus con trigger colpisce la creatura che ha attivato il trigger.');
      if (e.trigger !== 'own_monster_summoned' && e.trigger !== 'equipped_creature_attacks') E.push('Il bonus alla creatura vale solo con \"evochi una creatura\" o \"quando attacca\".');
      if (e.stat !== 'hp' && e.stat !== 'attack') E.push('Bonus: scegli attacco o PV.');
      if (!(e.duration === 'permanent' || (e.duration === 'turn' && e.stat === 'attack'))) E.push('Il bonus del trigger è permanente (a fine turno solo per l\'attacco).');
    } else E.push(`${t}: effetto non ammesso con un trigger.`);
    E.push(...filterErr(e, ty, t));
    return E;
  }
  if (e.target === 'triggering_creature') E.push('Il bersaglio \"creatura che ha attivato il trigger\" richiede un trigger.');
  if (e.target === 'any_target' && t !== 'damage') E.push('Il bersaglio a scelta tra giocatore e creature vale solo per i danni.');
  if (e.target === 'source_creature' && (t !== 'buff' || !CREA.includes(ty) || death)) E.push('\"Questa creatura\" vale solo per i bonus all\'ingresso di Mostri e Mostrissimi.');
  if (!TG[t]) { E.push(`Effetto \"${e.type}\" non supportato dal motore.`); return E; }
  if (ty === 'aura' && t !== 'buff') E.push('Le Aure ammettono solo bonus o movimento a costo 0.');
  if (ty === 'terraforma' && t !== 'buff') E.push('Le Terraforme ammettono solo bonus.');
  const tg = e.target ?? (t === 'draw' ? 'self' : t === 'discard' ? 'opponent' : null);
  if (tg && !TG[t].includes(tg)) E.push(`${t}: il bersaglio \"${tg}\" blocca la partita.`);
  E.push(...filterErr(e, ty, t));
  if (t === 'buff') {
    const d = String(e.duration);
    if (!['permanent', 'turn', 'while_attached', 'while_in_play'].includes(d)) E.push('Bonus: durata non supportata.');
    if (e.stat !== 'hp' && e.stat !== 'attack') E.push('Bonus: scegli attacco o PV.');
    if (e.stat === 'hp' && d === 'turn') E.push('Bonus PV a fine turno non supportato.');
    const passive = d === 'while_attached' || d === 'while_in_play';
    if (ty === 'aura' && d !== 'while_attached') E.push('Le Aure usano solo bonus \"finché è attaccata\".');
    else if (ty === 'terraforma' && d !== 'while_in_play') E.push('Le Terraforme usano solo bonus \"finché è in campo\".');
    else if (CREA.includes(ty) && d === 'while_attached') E.push('Il bonus \"finché attaccata\" vale solo per le Aure.');
    else if (ty !== 'aura' && ty !== 'terraforma' && !CREA.includes(ty) && passive) E.push('I bonus \"finché attaccata\" o \"finché in campo\" valgono solo per Aure, Terraforme, Mostri e Mostrissimi.');
    if (CREA.includes(ty) && d === 'while_in_play') {
      if (tg !== 'all_creatures_self') E.push('Il bonus continuo di un Mostro va a tutte le tue creature.');
      if (death) E.push('Un bonus continuo non può essere un effetto alla morte.');
    }
    if (ty === 'aura' && tg && !['enchanted_creature', 'all_creatures_self'].includes(tg)) E.push('Le Aure danno bonus alla creatura incantata o a tutte le tue.');
    if (ty === 'terraforma' && tg !== 'all_creatures_self') E.push('Le Terraforme danno bonus a tutte le tue creature.');
    if (passive && !Number.isInteger(amount)) E.push('Bonus: serve la quantità.');
  }
  return E;
}

function engineErrors(c) {
  const E = [], ty = c.card_type;
  if (!TYPES[ty]) E.push('Tipo non supportato.');
  if (!Number.isInteger(c.mana_cost) || c.mana_cost < 0) E.push('Costo mana non valido.');
  if (CREA.includes(ty) && (!Number.isInteger(c.attack) || !Number.isInteger(c.hp))) E.push('Attacco e PV sono obbligatori.');
  if (ty === 'mostrissimo' && !(Number.isInteger(c.sacrifice_cost) && c.sacrifice_cost >= 0)) E.push('Sacrifici non validi.');
  if (c.is_boss && !(ty === 'monster' && c.mana_cost === 6)) E.push('Un boss è un Mostro da 6 mana.');
  if (ty === 'terraforma' && !(Number.isInteger(c.hp) && c.hp >= 1)) E.push('Le Terraforme hanno PV (almeno 1): si possono attaccare e distruggere.');
  const j = c.effect_json, L = !j ? [] : j.effects || [j], trg = j?.reaction_trigger?.event;
  if (['maledizione', 'instant', 'aura', 'terraforma'].includes(ty) && !L.length) E.push('Questo tipo richiede almeno un effetto.');
  if (ty === 'instant' && !TRG.includes(trg)) E.push('La Trappola richiede un evento valido.');
  L.forEach((e) => E.push(...effErr(e, ty, trg)));
  const D = c.effect_on_death_json;
  (D ? D.effects || [D] : []).forEach((e) => E.push(...effErr(e, 'monster', undefined, true)));
  return E;
}

function balance(c, cards) {
  if (c.card_type !== 'monster' || !Number.isInteger(c.attack)) return [];
  const same = cards.filter((x) => x.card_type === 'monster' && x.mana_cost === c.mana_cost && x.id !== S.edit && x.attack != null);
  if (same.length < 3) return [];
  const avg = same.reduce((s, x) => s + x.attack + x.hp, 0) / same.length, tot = c.attack + c.hp;
  if (tot > avg * 1.35 + 0.5) return [`Statistiche alte per costo ${c.mana_cost}: ${tot} contro una media di ${avg.toFixed(1)}.`];
  if (tot < avg * 0.65 - 0.5) return [`Statistiche basse per costo ${c.mana_cost}: ${tot} contro una media di ${avg.toFixed(1)}.`];
  return [];
}

function check(c) {
  const err = [], warn = [];
  if (!c.name) err.push('Scrivi il nome.');
  if (!c.faction_id) err.push('Scegli la fazione.');
  if (!c.card_type) err.push('Scegli il tipo.');
  if (c.name && S.cards.some((x) => x.id !== S.edit && x.name.trim().toLowerCase() === c.name.toLowerCase())) err.push('Esiste già una carta con questo nome.');
  if (c.card_type) err.push(...engineErrors(c));
  if (c.faction_id === 7 && c.card_type !== 'mostrissimo') warn.push('Gli Indrazzi (7) non entrano mai nei mazzi.');
  warn.push(...balance(c, S.cards));
  if (c.effect_on_death_json?.effects) warn.push('Più effetti alla morte: la guida non conferma questo formato per la morte, prova la carta in partita.');
  if (!S.file && !isReal(S.cur)) warn.push('Nessuna immagine caricata: al salvataggio verrà caricata un\'immagine provvisoria, la carta sarà giocabile e potrai sostituirla quando vuoi.');
  return { err, warn };
}

/* ---------- Stato ---------- */
const S = { cards: [], subs: [], edit: null, eff: [], deaths: [], subIds: [], kwo: [], file: null, img: null, cur: null, dirty: false, view: 'grid', sel: null, badEff: [] };
const isReal = (u) => !!u && !String(u).startsWith('data:');
// Immagine provvisoria: stesso percorso di una vera (<CODICE>/<id>.webp), riconoscibile da ph=1 nell'URL.
// Caricando poi l'immagine vera il file viene sovrascritto e il marcatore sparisce.
const isTemp = (u) => isReal(u) && /[?&]ph=1(&|$)/.test(String(u));
const isFinal = (u) => isReal(u) && !isTemp(u);
const placeholderImage = (c) => new Promise((ok, ko) => {
  let h = 0;
  for (const ch of c.name || 'x') h = (h * 31 + ch.charCodeAt(0)) % 360;
  const cv = document.createElement('canvas'), g = cv.getContext('2d');
  cv.width = 800; cv.height = 560;
  const bg = g.createLinearGradient(0, 0, 0, 560);
  bg.addColorStop(0, `hsl(${h},35%,28%)`); bg.addColorStop(1, `hsl(${h},35%,14%)`);
  g.fillStyle = bg; g.fillRect(0, 0, 800, 560);
  g.textAlign = 'center'; g.fillStyle = '#fff';
  g.font = '170px serif'; g.fillText(['🎴', '👹', '🕯️', '🦴', '🌀', '🔥'][h % 6], 400, 290);
  g.font = 'bold 44px sans-serif'; g.fillText(c.name || 'Carta', 400, 400, 720);
  g.font = '28px sans-serif'; g.globalAlpha = .7; g.fillText('IMMAGINE PROVVISORIA', 400, 460);
  cv.toBlob((b) => (b ? ok(b) : ko(new Error('Immagine provvisoria non creata.'))), 'image/webp', 0.75);
});
const subNames = () => S.subIds.map((id) => S.subs.find((s) => s.id === id)?.name).filter(Boolean);
const subsOf = (c) => (c.sn?.length ? c.sn.join(' ') : c.subtype || '');

function fallback(c) {
  let h = 0;
  for (const ch of c.name || 'x') h = (h * 31 + ch.charCodeAt(0)) % 360;
  const em = ['🎴', '👹', '🕯️', '🦴', '🌀', '🔥'][h % 6];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 70"><rect width="100" height="70" fill="hsl(${h},35%,22%)"/><text x="50" y="45" font-size="30" text-anchor="middle">${em}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

const fmt = (t) => esc(t || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

function cardHtml(c) {
  const cr = CREA.includes(c.card_type), real = S.img || isFinal(c.image_url);
  const cost = c.card_type === 'mostrissimo' ? `✦${c.sacrifice_cost ?? 0}` : `⚡${c.mana_cost ?? 0}`;
  const bad = c.id && engineErrors(c).length;
  return `<article class="gc f${c.faction_id || 7}" data-id="${c.id || ''}">
    <header><span>${esc(c.name || 'Nome carta')}</span><span>${cost}</span></header>
    <div class="art"><img src="${S.img && !c.id ? S.img : isReal(c.image_url) ? esc(c.image_url) : fallback(c)}" alt="">${real ? '' : `<span class="tag">${isTemp(c.image_url) ? 'Immagine provvisoria' : 'Immagine mancante'}</span>`}</div>
    <div class="tr">${TYPES[c.card_type] || 'Tipo'}${subsOf(c) ? ' – ' + esc(subsOf(c)) : ''}</div>
    <div class="rules">${fmt(c.effect_text)}</div>
    ${c.flavor_text ? `<div class="fl">${esc(c.flavor_text)}</div>` : ''}
    <footer><span>${RAR[c.rarity] || ''}</span><b>${cr ? `⚔ ${c.attack ?? 0}  ❤ ${c.hp ?? 0}` : c.card_type === 'terraforma' ? `❤ ${c.hp ?? 0}` : ''}</b></footer>
    ${bad ? '<span class="tag" style="top:auto;bottom:4px">Non valida</span>' : ''}</article>`;
}

function rowHtml(c) {
  const cost = c.card_type === 'mostrissimo' ? `✦${c.sacrifice_cost ?? 0}` : `⚡${c.mana_cost}`;
  const bd = (engineErrors(c).length ? '⚠️' : '') + (isFinal(c.image_url) ? '' : '🖼️');
  return `<div class="li f${c.faction_id}" data-id="${c.id}"><div><b>${esc(c.name)}</b><small>${FAC[c.faction_id]?.[1] || '?'} – ${TYPES[c.card_type] || c.card_type} – ${cost}${CREA.includes(c.card_type) ? ` – ${c.attack}/${c.hp}` : ''}</small></div><span class="bd">${bd}</span></div>`;
}

/* ---------- Caricamento e lista ---------- */
async function loadAll() {
  const [a, b] = await Promise.all([
    sb.from('cards').select('*,card_subtype_links(subtype_id,card_subtypes(id,name))').order('created_at', { ascending: false }),
    sb.from('card_subtypes').select('*').order('sort_order').order('name')
  ]);
  if (a.error) { $('cards').innerHTML = `<p class="hint">Errore database: ${esc(a.error.message)}</p>`; return; }
  S.cards = a.data.map((c) => ({ ...c, sn: (c.card_subtype_links || []).map((l) => l.card_subtypes?.name).filter(Boolean).sort() }));
  S.subs = b.data || [];
  draw(); stats(); decks();
}

const rng = (v, a, b) => { const lo = $(a).value, hi = $(b).value; if (lo === '' && hi === '') return true; if (v == null) return false; return (lo === '' || v >= +lo) && (hi === '' || v <= +hi); };
const inR = (c) => rng(c.mana_cost, 'cmin', 'cmax') && rng(c.attack, 'amin', 'amax') && rng(c.hp, 'hmin', 'hmax');

function draw() {
  const q = $('q').value.toLowerCase(), F = $('ff').value, T = $('ft').value, R = $('fr').value, St = $('fs').value;
  const L = S.cards.filter((c) => (!F || c.faction_id == F) && (!T || c.card_type === T) && (!R || c.rarity === R) && inR(c) &&
    (!St || (St === 'bad' ? engineErrors(c).length : !isFinal(c.image_url))) &&
    (!q || [c.name, c.effect_text, c.flavor_text, subsOf(c)].join(' ').toLowerCase().includes(q)));
  $('count').textContent = `${L.length} carte su ${S.cards.length}`;
  $('cards').className = S.view;
  $('cards').innerHTML = L.map((c) => (S.view === 'grid' ? cardHtml(c) : rowHtml(c))).join('') || '<p class="hint">Nessuna carta trovata.</p>';
}

/* ---------- Editor ---------- */
const sel = (f, opts, v) => `<select data-f="${f}">${opts.map(([a, b]) => `<option value="${a}"${a === v ? ' selected' : ''}>${b}</option>`).join('')}</select>`;
// Un solo elenco di effetti. Ogni riga: Quando (trigger) → Effetto → Quantità → Bersaglio → Durata.
// I Mostri scelgono il trigger (entra in campo / muore); per gli altri tipi il motore fissa il
// comportamento e la riga lo mostra solo come informazione.
const TRIG = [['etb', 'Quando entra in campo'], ['death', 'Quando muore']];
const FIXED = {
  maledizione: 'Una volta: alla giocata, poi va al cimitero', instant: 'Una volta: quando la Trappola si attiva',
  aura: 'Continuo: finché è equipaggiata', terraforma: 'Continuo: finché è in campo'
};
function rows(list, name, ty) {
  return list.map((e, i) => {
    const head = `<div class="row" data-l="${name}" data-i="${i}">`;
    if (e.raw) return `${head}<small>⚠️ Effetto non riconosciuto (viene conservato): ${esc(JSON.stringify(e.raw))}</small><button type="button" data-x class="sec">Rimuovi</button></div>`;
    const c = EF[e.key], when = CREA.includes(ty) && !c.when ? sel('trg', TRIG, name === 'death' ? 'death' : 'etb') : `<small><b>${esc(c.when || FIXED[ty] || 'Una volta')}</b></small>`;
    return `${head}${when}${sel('key', keysFor(name === 'death' ? 'monster' : ty).map((k) => [k, EF[k].l]), e.key)}${c.a ? `<input data-f="n" type="number" min="0" max="20" value="${e.n}" title="Quantità">` : ''}${c.t ? sel('t', c.t, e.t) : ''}${c.d ? sel('d', c.d, e.d) : ''}${(ty === 'terraforma' || CREA.includes(ty)) && (c.spec.json.duration === 'while_in_play' || c.spec.json.trigger === 'own_monster_summoned') ? sel('fk', [['all', c.spec.json.trigger ? 'Qualsiasi creatura evocata' : 'Tutte le tue creature'], ['subtype', 'Solo un sottotipo'], ['faction', 'Solo una fazione']], e.flt?.k ?? 'all') + (e.flt ? sel('fv', fltValues(e.flt.k), e.flt.v) : '') : ''}<button type="button" data-x class="sec">✕</button></div>`;
  }).join('');
}

function renderEff() {
  const ty = $('type').value;
  $('effs').innerHTML = rows(S.eff, 'eff', ty) + rows(S.deaths, 'death', ty);
  $('death').innerHTML = '';
  $('gdeath').hidden = true; // gli effetti alla morte stanno ora nello stesso elenco
}

function onRow(ev) {
  const r = ev.target.closest('.row');
  if (!r) return;
  const L = r.dataset.l, i = +r.dataset.i, e = L === 'eff' ? S.eff[i] : S.deaths[i];
  if (ev.target.dataset.x !== undefined) {
    if (ev.type !== 'click') return;
    (L === 'eff' ? S.eff : S.deaths).splice(i, 1);
    renderEff(); refresh(); return;
  }
  const f = ev.target.dataset.f;
  if (!f || ev.type === 'click') return;
  if (f === 'trg') {
    const toDeath = ev.target.value === 'death';
    if (toDeath !== (L === 'death')) {
      (L === 'eff' ? S.eff : S.deaths).splice(i, 1);
      (toDeath ? S.deaths : S.eff).push(e);
    }
    renderEff(); refresh(); return;
  }
  if (f === 'fk') {
    const k = ev.target.value;
    e.flt = k === 'all' ? null : { k, v: fltValues(k)[0]?.[0] ?? '' };
    renderEff(); refresh(); return;
  }
  if (f === 'fv') { e.flt = { ...e.flt, v: ev.target.value }; refresh(); return; }
  if (f === 'key') { Object.assign(e, defE(ev.target.value)); renderEff(); }
  else e[f] = f === 'n' ? Math.max(0, Math.min(20, parseInt(ev.target.value) || 0)) : ev.target.value;
  refresh();
}

function types() {
  const ty = $('type').value, c = CREA.includes(ty);
  $('gmana').hidden = ty === 'mostrissimo'; $('gsac').hidden = ty !== 'mostrissimo';
  $('gstats').hidden = !c && ty !== 'terraforma'; $('atk').disabled = ty === 'terraforma'; $('gkw').hidden = !c; $('gdeath').hidden = !c;
  if ($('gboss')) { $('gboss').hidden = ty !== 'monster'; if (ty !== 'monster') $('isboss').checked = false; }
  $('gtrap').hidden = ty !== 'instant';
  S.eff = S.eff.filter((e) => e.raw || (ty && EF[e.key].for.includes(ty)));
  if (!c) S.deaths = [];
  $('elab').textContent = 'Effetti (nessuno se vuoto)';
  $('addE').hidden = !ty;
  renderEff();
}

const fltText = (f) => f.k === 'subtype' ? `di tipo ${f.v}` : `di ${Object.values(FAC).find((x) => x[0] === f.v)?.[1] ?? f.v}`;
function fltValues(k) {
  return k === 'subtype' ? S.subs.filter((s) => s.is_active !== false).map((s) => [s.name, s.name])
    : Object.values(FAC).filter((x) => x[0] !== 'IND').map((x) => [x[0], x[1]]);
}

function draft() {
  const ty = $('type').value, tx = (L) => L.filter((e) => !e.raw).map((e) => {
    const t = EF[e.key].txt(e.n, e.t, e.d) || '';
    const from = EF[e.key].spec.json.trigger ? 'una creatura alleata' : 'Le tue creature';
    return e.flt?.v ? t.replace(from, `${from} ${fltText(e.flt)}`) : t;
  }).join('. ');
  const p = [];
  if (CREA.includes(ty) && $('kw').checked) p.push('**Iperattivo**');
  const a = tx(S.eff);
  if (a) p.push(CREA.includes(ty) ? `**Quando entra in campo:** ${a}.` : `${a}.`);
  const dd = tx(S.deaths);
  if (dd) p.push(`**Quando muore:** ${dd}.`);
  return p.join('\n');
}

function deathJson() {
  const L = S.deaths.map((e) => e.raw || { ...build(e, 'monster'), timing: 'on_death' });
  return L.length === 1 ? L[0] : { effects: L };
}

function collect() {
  const ty = $('type').value, cr = CREA.includes(ty), num = (id) => parseInt($(id).value);
  const eff = S.eff.map((e) => build(e, ty));
  let ej = eff.length ? (eff.length === 1 ? { ...eff[0] } : { effects: eff }) : null;
  if (ty === 'instant') ej = { ...(ej || {}), reaction_trigger: { event: $('trap').value } };
  return {
    name: $('name').value.trim(), faction_id: +$('fac').value || null, card_type: ty,
    mana_cost: ty === 'mostrissimo' ? 0 : num('mana'), sacrifice_cost: ty === 'mostrissimo' ? num('sac') : 0,
    attack: cr ? num('atk') : null, hp: cr || ty === 'terraforma' ? num('hp') : null,
    keywords: cr ? [...($('kw').checked ? ['iperattivo'] : []), ...S.kwo] : [],
    effect_json: ej, effect_on_death_json: cr && S.deaths.length ? deathJson() : null,
    effect_text: $('txt').value.trim(), flavor_text: $('fl').value.trim() || null,
    rarity: $('rar').value, subtype: subNames().join(' ') || null,
    is_boss: ty === 'monster' && !!$('isboss')?.checked
  };
}

function msg(lines, cls) { $('msg').innerHTML = lines.map((l) => `<p class="${cls}">${esc(l)}</p>`).join(''); }

function refresh() {
  if (!S.dirty) $('txt').value = draft();
  const c = collect();
  $('prev').innerHTML = cardHtml({ ...c, id: '', image_url: S.cur });
  const r = check(c);
  $('msg').innerHTML = r.err.map((l) => `<p class="err">${esc(l)}</p>`).join('') + r.warn.map((l) => `<p class="warn">${esc(l)}</p>`).join('');
}

function renderSubs() {
  $('subchips').innerHTML = S.subIds.map((id) => { const s = S.subs.find((x) => x.id === id); return s ? `<button type="button" class="chip" data-rm="${id}">${esc(s.name)} ✕</button>` : ''; }).join('');
  const raw = $('subin').value.trim(), q = raw.toLowerCase(), h = [];
  if (q) {
    S.subs.filter((s) => s.is_active !== false && !S.subIds.includes(s.id) && s.name.toLowerCase().includes(q))
      .sort((a, b) => b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)).slice(0, 6)
      .forEach((s) => h.push(`<button type="button" class="chip" data-add="${s.id}">${esc(s.name)}</button>`));
    if (!S.subs.some((s) => s.name.toLowerCase() === q)) h.push(`<button type="button" class="chip new" data-new>➕ Crea «${esc(raw)}»</button>`);
  }
  $('subsug').innerHTML = h.join('');
}

async function newSub() {
  const name = $('subin').value.trim();
  if (name.length < 2) return;
  const mx = S.subs.reduce((m, s) => Math.max(m, s.sort_order || 0), 0);
  const x = await sb.from('card_subtypes').insert({ name, normalized_name: name.toLowerCase(), sort_order: mx + 10, is_active: true }).select().single();
  if (x.error) { msg([`Sottotipo non creato: ${x.error.message}`], 'err'); return; }
  S.subs.push(x.data); S.subIds.push(x.data.id); $('subin').value = ''; renderSubs(); refresh();
}

const webp = (f) => new Promise((ok, ko) => {
  const i = new Image();
  i.onload = () => {
    const s = Math.min(1, 800 / Math.max(i.width, i.height)), cv = document.createElement('canvas');
    cv.width = Math.round(i.width * s); cv.height = Math.round(i.height * s);
    cv.getContext('2d').drawImage(i, 0, 0, cv.width, cv.height);
    cv.toBlob((b) => (b ? ok(b) : ko(new Error('Conversione WebP fallita.'))), 'image/webp', 0.75);
  };
  i.onerror = () => ko(new Error('Immagine non leggibile.'));
  i.src = URL.createObjectURL(f);
});

function resetForm(keep = true) {
  const fac = $('fac').value, ty = $('type').value;
  $('f').reset();
  if (keep) { $('fac').value = fac; $('type').value = ty; }
  Object.assign(S, { edit: null, eff: [], deaths: [], subIds: [], kwo: [], file: null, img: null, cur: null, dirty: false });
  $('et').textContent = 'Nuova carta'; $('save').textContent = 'Salva carta';
  types(); renderSubs(); refresh();
}

function fill(c, dup) {
  Object.assign(S, { edit: dup ? null : c.id, file: null, img: null, cur: dup ? null : c.image_url, dirty: true });
  $('et').textContent = dup ? 'Duplica carta: scrivi un nuovo nome' : `Modifica: ${c.name}`;
  $('save').textContent = dup ? 'Salva carta' : 'Salva modifiche';
  $('name').value = dup ? '' : c.name; $('fac').value = c.faction_id; $('type').value = c.card_type; $('rar').value = c.rarity || 'common';
  if ($('isboss')) $('isboss').checked = !dup && !!c.is_boss;
  $('mana').value = c.mana_cost ?? 0; $('sac').value = c.sacrifice_cost ?? 0; $('atk').value = c.attack ?? 0; $('hp').value = c.hp ?? 1;
  const kws = Array.isArray(c.keywords) ? c.keywords : [];
  $('kw').checked = kws.some((k) => String(k).toLowerCase() === 'iperattivo');
  S.kwo = kws.filter((k) => String(k).toLowerCase() !== 'iperattivo');
  $('fl').value = c.flavor_text || ''; $('txt').value = c.effect_text || '';
  S.subIds = (c.card_subtype_links || []).map((l) => l.subtype_id);
  const j = c.effect_json;
  S.eff = (!j ? [] : j.effects || [j]).map((x) => { const y = { ...x }; delete y.reaction_trigger; return parseEff(y, c.card_type); }).filter(Boolean);
  $('trap').value = j?.reaction_trigger?.event || TRG[0];
  const D = c.effect_on_death_json;
  S.deaths = (D ? D.effects || [D] : []).map((x) => parseEff(x, 'monster')).filter(Boolean);
  $('img').value = '';
  types(); renderSubs(); tab('editor'); refresh();
  if (dup) $('name').focus();
}

const API = 'https://bellum-penumbrum-api.onrender.com';
// Controllo finale col motore (stesse regole dei mazzi). Se il servizio non risponde in 8 secondi
// (ad esempio è in avvio) si prosegue col controllo locale e il salvataggio non viene bloccato.
async function remoteErrors(c) {
  try {
    const { data } = await sb.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return null;
    const res = await fetch(`${API}/cards/validate`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ card: c }), signal: AbortSignal.timeout(8000)
    });
    return res.ok ? (await res.json()).errors ?? null : null;
  } catch { return null; }
}

async function save(ev) {
  ev.preventDefault();
  const c = collect(), r = check(c);
  if (r.err.length) { refresh(); return; }
  const ok = (x) => { if (x.error) throw x.error; return x.data; };
  try {
    $('save').disabled = true;
    const remote = await remoteErrors(c);
    if (remote?.length) { msg(['Il motore rifiuta questa carta:', ...remote], 'err'); return; }
    const row = ok(S.edit ? await sb.from('cards').update(c).eq('id', S.edit).select().single() : await sb.from('cards').insert(c).select().single());
    ok(await sb.from('card_subtype_links').delete().eq('card_id', row.id));
    if (S.subIds.length) ok(await sb.from('card_subtype_links').insert(S.subIds.map((id) => ({ card_id: row.id, subtype_id: id }))));
    const temp = !S.file && !isReal(S.cur), file = temp ? await placeholderImage(c) : S.file;
    if (file) {
      const path = `${FAC[c.faction_id][0]}/${row.id}.webp`;
      ok(await sb.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: 'image/webp', cacheControl: '3600' }));
      const url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl + '?v=' + Date.now() + (temp ? '&ph=1' : '');
      ok(await sb.from('cards').update({ image_url: url }).eq('id', row.id));
    }
    const wasEdit = !!S.edit;
    await loadAll();
    resetForm(true);
    msg([`Salvata: ${c.name}.`, ...r.warn], 'ok');
    if (wasEdit) tab('list');
  } catch (e) {
    msg([`Errore di salvataggio: ${e.message}`], 'err');
  } finally { $('save').disabled = false; }
}

/* ---------- Controllo: statistiche, mazzi, backup ---------- */
function stats() {
  const rows_ = Object.entries(FAC).map(([id, [, n]]) => {
    const L = S.cards.filter((c) => c.faction_id == id), m = L.filter((c) => c.card_type === 'monster'), nm = L.filter((c) => c.card_type !== 'mostrissimo');
    const avg = nm.length ? (nm.reduce((s, c) => s + (c.mana_cost || 0), 0) / nm.length).toFixed(1) : '-';
    return `<tr><td>${n}</td><td>${L.length}</td><td>${m.length}</td><td>${avg}</td><td>${L.filter((c) => engineErrors(c).length).length}</td><td>${L.filter((c) => !isFinal(c.image_url)).length}</td></tr>`;
  }).join('');
  $('stats').innerHTML = `<table><tr><th>Fazione</th><th>Carte</th><th>Mostri</th><th>Costo medio</th><th>Non valide</th><th>Senza img o provv.</th></tr>${rows_}</table>`;
  const none = S.cards.filter((c) => FAC[c.faction_id] && !isReal(c.image_url));
  if (none.length) {
    $('stats').insertAdjacentHTML('beforeend', `<p><button type="button" id="fillph">Carica l'immagine provvisoria alle ${none.length} carte senza immagine</button></p>`);
    $('fillph').onclick = () => fillPlaceholders(none);
  }
}

async function fillPlaceholders(list) {
  const b = $('fillph'), ok = (x) => { if (x.error) throw x.error; return x.data; };
  b.disabled = true;
  try {
    for (const [i, c] of list.entries()) {
      b.textContent = `Carico ${i + 1} di ${list.length}…`;
      const path = `${FAC[c.faction_id][0]}/${c.id}.webp`;
      ok(await sb.storage.from(BUCKET).upload(path, await placeholderImage(c), { upsert: true, contentType: 'image/webp', cacheControl: '3600' }));
      const url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl + '?v=' + Date.now() + '&ph=1';
      ok(await sb.from('cards').update({ image_url: url }).eq('id', c.id));
    }
    await loadAll();
  } catch (e) { b.disabled = false; b.textContent = `Errore: ${e.message}. Riprova.`; }
}

function decks() {
  const ok = S.cards.filter((c) => ['monster', 'instant', 'aura', 'terraforma', 'maledizione'].includes(c.card_type) && c.faction_id >= 1 && c.faction_id <= 6 && !engineErrors(c).length);
  const bad = [];
  for (let a = 1; a <= 6; a++) for (let b = a + 1; b <= 6; b++) {
    const L = ok.filter((c) => c.faction_id === a || c.faction_id === b), why = [];
    const costs = L.map((c) => c.mana_cost).sort((x, y) => x - y);
    if (L.length < 10) why.push(`solo ${L.length} carte valide`);
    else if (costs.slice(0, 10).reduce((s, x) => s + x, 0) > 40 || costs.slice(-10).reduce((s, x) => s + x, 0) < 25) why.push('somma costi fuori da 25–40');
    if (L.filter((c) => c.faction_id === a).length < 2 || L.filter((c) => c.faction_id === b).length < 2) why.push('meno di 2 carte per colore');
    if (!L.some((c) => c.card_type === 'monster')) why.push('nessun mostro');
    if (why.length) bad.push(`${FAC[a][1]} + ${FAC[b][1]}: ${why.join(', ')}`);
  }
  $('decks').innerHTML = (bad.length ? bad.map((x) => `<p class="hint">⚠️ ${esc(x)}</p>`).join('') : '<p class="hint">✅ Tutte le 15 coppie hanno carte a sufficienza.</p>')
    + '<p class="hint">Controllo semplificato (non conta il terzo colore). Per la verifica completa carica l\'export in chat.</p>';
}

async function backup() {
  const x = await sb.from('cards').select('*');
  if (x.error) { alert(x.error.message); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(x.data, null, 2)], { type: 'application/json' }));
  a.download = `bellum-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

/* ---------- Scheda Effetti ---------- */
const NEWSPEC = { order: 50, label: '✨ Nuovo effetto', for: ['monster'], amount: true, targets: [['self', 'Tu'], ['opponent', 'Avversario']], json: { type: 'draw', amount: '{n}', target: '{t}' }, text: { self: 'Pesca {n} {carte}', opponent: "L'avversario pesca {n} {carte}" } };

function renderEffList() {
  $('elist').innerHTML = Object.entries(EF).map(([k, e]) => `<div class="li" data-eid="${k}"><div><b>${esc(e.l)}</b><small>${k} – ${e.for.map((t) => TYPES[t]).join(', ')}</small></div></div>`).join('')
    + S.badEff.map((x) => `<p class="hint">⚠️ ${esc(x)}</p>`).join('');
}

function openSpec(id, spec) {
  $('eid').value = id; $('eid').disabled = !!EF[id];
  $('ejs').value = JSON.stringify(spec, null, 1); $('eed').hidden = false; testSpec();
}

function testSpec() {
  let s;
  try { s = JSON.parse($('ejs').value); } catch (e) { $('etest').innerHTML = `<p class="err">JSON non valido: ${esc(e.message)}</p>`; return null; }
  const er = specErr(s, $('eid').value.trim());
  let h = er.map((x) => `<p class="err">${esc(x)}</p>`).join('');
  if (!er.length) {
    const c = compile(s), d = c.d?.[0][0];
    (c.t ? c.t.slice(0, 4) : [[undefined]]).forEach(([t]) => { h += `<p class="ok">${esc(c.txt(2, t, d))}<small>${esc(JSON.stringify(c.json(2, t, d)))}</small></p>`; });
  }
  $('etest').innerHTML = h;
  return er.length ? null : s;
}

/* ---------- Navigazione ed eventi ---------- */
function tab(t) {
  ['list', 'editor', 'effects', 'ctl'].forEach((k) => ($(`t-${k}`).hidden = k !== t));
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  window.scrollTo(0, 0);
}

function opts(el, entries, first) {
  el.innerHTML = (first ? `<option value="">${first}</option>` : '') + entries.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
}

function openCard(id) {
  const c = S.cards.find((x) => x.id === id);
  if (!c) return;
  S.sel = id;
  const pr = engineErrors(c);
  $('mdc').innerHTML = cardHtml(c) + pr.map((p) => `<p class="hint">⚠️ ${esc(p)}</p>`).join('');
  $('md').showModal();
}


/* ---------- Accesso riservato all'admin ---------- */
const ADMIN_ID = '51cf57f7-04a4-491e-b0a6-baabebce30dd';

function requireAdmin() {
  return new Promise((resolve) => {
    const show = (t) => { $('gmsg').textContent = t; };
    const open = () => { $('gate').hidden = true; $('app').hidden = false; resolve(true); };
    const check = async () => {
      const { data } = await sb.auth.getSession();
      const u = data.session?.user;
      if (u && u.id === ADMIN_ID) { open(); return; }
      $('gate').hidden = false; $('app').hidden = true;
      show(u ? 'L\'account collegato non è autorizzato. Esci e accedi come admin.' : '');
      $('gout').hidden = !u;
    };
    $('glogin').addEventListener('click', async () => {
      const raw = $('guser').value.trim().toLowerCase(), pw = $('gpass').value;
      if (!raw || !pw) { show('Inserisci utente e password.'); return; }
      show('Accesso in corso…');
      const r = await sb.auth.signInWithPassword({ email: raw.includes('@') ? raw : `${raw}@test.local`, password: pw });
      $('gpass').value = '';
      if (r.error) { show('Accesso non riuscito.'); return; }
      await check();
    });
    $('gout').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });
    check();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  if (!(await requireAdmin())) return;
  $('lo').addEventListener('click', async () => { await sb.auth.signOut(); location.reload(); });
  const fe = Object.entries(FAC).map(([k, v]) => [k, v[1]]), te = Object.entries(TYPES), re = Object.entries(RAR);
  opts($('ff'), fe, 'Tutte le fazioni'); opts($('ft'), te, 'Tutti i tipi'); opts($('fr'), re, 'Tutte le rarità');
  opts($('fac'), fe, 'Scegli…'); opts($('type'), te, 'Scegli…'); opts($('rar'), re);
  // Campo "Boss" (solo per i Mostri): il mazzo ha un solo boss, un Mostro da 6 mana del colore principale.
  if ($('gstats') && !$('gboss')) {
    const lab = document.createElement('label'); lab.id = 'gboss'; lab.hidden = true;
    lab.innerHTML = '<input type="checkbox" id="isboss"> Boss del colore (Mostro da 6 mana: uno solo nel mazzo, del colore principale)';
    $('gstats').insertAdjacentElement('afterend', lab);
    $('isboss').addEventListener('change', () => refresh());
  }
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => { tab(b.dataset.tab); if (b.dataset.tab === 'editor' && !S.edit) refresh(); }));
  ['q', 'ff', 'ft', 'fr', 'fs', 'cmin', 'cmax', 'amin', 'amax', 'hmin', 'hmax'].forEach((id) => $(id).addEventListener('input', draw));
  $('vw').addEventListener('click', () => { S.view = S.view === 'grid' ? 'list' : 'grid'; $('vw').textContent = `Vista: ${S.view === 'grid' ? 'griglia' : 'lista'}`; draw(); });
  $('cards').addEventListener('click', (e) => { const el = e.target.closest('[data-id]'); if (el) openCard(el.dataset.id); });
  $('m-x').addEventListener('click', () => $('md').close());
  $('m-edit').addEventListener('click', () => { $('md').close(); fill(S.cards.find((c) => c.id === S.sel), false); });
  $('m-dup').addEventListener('click', () => { $('md').close(); fill(S.cards.find((c) => c.id === S.sel), true); });
  $('m-del').addEventListener('click', async () => {
    const c = S.cards.find((x) => x.id === S.sel);
    if (!c || !confirm(`Eliminare definitivamente "${c.name}"?`)) return;
    const x = await sb.from('cards').delete().eq('id', c.id);
    if (x.error) { alert(x.error.message); return; }
    $('md').close(); loadAll();
  });
  $('type').addEventListener('change', () => { types(); refresh(); });
  ['name', 'fac', 'rar', 'mana', 'sac', 'atk', 'hp', 'kw', 'trap', 'fl'].forEach((id) => $(id).addEventListener('input', refresh));
  $('txt').addEventListener('input', () => { S.dirty = true; refresh(); });
  $('regen').addEventListener('click', () => { S.dirty = false; refresh(); });
  $('addE').textContent = '+ Aggiungi effetto';
  $('addE').addEventListener('click', () => { const ty = $('type').value; if (ty) { S.eff.push(defE(keysFor(ty)[0])); renderEff(); refresh(); } });
  $('addD').addEventListener('click', () => { S.deaths.push(defE(keysFor('monster')[0])); renderEff(); refresh(); });
  ['effs', 'death'].forEach((id) => ['input', 'click'].forEach((t) => $(id).addEventListener(t, onRow)));
  $('subin').addEventListener('input', renderSubs);
  $('subin').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('subsug').querySelector('[data-add]')?.click(); } });
  $('subsug').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.add) { S.subIds.push(b.dataset.add); $('subin').value = ''; renderSubs(); refresh(); }
    else if (b.dataset.new !== undefined) newSub();
  });
  $('subchips').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { S.subIds = S.subIds.filter((x) => x !== b.dataset.rm); renderSubs(); refresh(); } });
  $('img').addEventListener('change', async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { S.file = await webp(f); S.img = URL.createObjectURL(S.file); S.cur = S.img; refresh(); }
    catch (er) { S.file = null; msg([er.message], 'err'); }
  });
  $('f').addEventListener('submit', save);
  $('clear').addEventListener('click', () => resetForm(false));
  $('bk').addEventListener('click', backup);
  $('gr').value = REPO; $('gb').value = BR;
  $('elist').addEventListener('click', (e) => { const el = e.target.closest('[data-eid]'); if (el) openSpec(el.dataset.eid, EF[el.dataset.eid].spec); });
  $('enew').addEventListener('click', () => openSpec('', NEWSPEC));
  $('ejs').addEventListener('input', testSpec); $('eid').addEventListener('input', testSpec);
  $('ecopy').addEventListener('click', async () => { const s = testSpec(); if (!s) return; await navigator.clipboard.writeText(JSON.stringify(s, null, 1)); $('etest').insertAdjacentHTML('beforeend', '<p class="ok">Copiato.</p>'); });
  $('egh').addEventListener('click', () => {
    const s = testSpec(); if (!s) return;
    const id = $('eid').value.trim(), repo = $('gr').value.trim(), br = $('gb').value.trim() || 'main', txt = JSON.stringify(s, null, 1);
    localStorage.setItem('bpa_repo', repo); localStorage.setItem('bpa_br', br);
    if (!repo) { $('etest').insertAdjacentHTML('beforeend', '<p class="err">Scrivi il repository (utente/repo).</p>'); return; }
    if (EF[id]) { navigator.clipboard?.writeText(txt); window.open(`https://github.com/${repo}/edit/${br}/docs/admin/effects/${id}.json`, '_blank'); }
    else window.open(`https://github.com/${repo}/new/${br}?filename=docs/admin/effects/${id}.json&value=${encodeURIComponent(txt)}`, '_blank');
  });
  await loadEffects(); renderEffList();
  types(); renderSubs(); refresh();
  loadAll();
});
