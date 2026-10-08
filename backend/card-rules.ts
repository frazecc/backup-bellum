// backend/card-rules.ts — regole di validità delle carte: unica fonte per mazzi, Mostrissimi
// e controllo di salvataggio dell'editor (POST /cards/validate). I messaggi sono quelli
// mostrati nell'editor. Regole di bilanciamento e nomi duplicati restano solo nell'editor.
type Json = Record<string, unknown>;

const TYPES = ['monster', 'mostrissimo', 'maledizione', 'instant', 'aura', 'terraforma'];
const CREATURES = ['monster', 'mostrissimo'];
const TRIGGERS = ['opponent_upkeep_start', 'opponent_upkeep_end', 'opponent_hand_card', 'monster_etb', 'mostrissimo_before_entry'];
const COUNTER_TRIGGERS = ['opponent_hand_card', 'monster_etb', 'mostrissimo_before_entry'];
const CREATURE_TARGETS = ['any_creature', 'all_creatures', 'all_creatures_self', 'all_creatures_opponent'];
const TARGETS = new Map<string, string[]>([
  ['draw', ['self', 'opponent']],
  ['discard', ['self', 'opponent']],
  ['heal', ['self', 'opponent', ...CREATURE_TARGETS]],
  // any_target: a scelta del proprietario, il giocatore avversario o una creatura (alleata o nemica).
  ['damage', [...CREATURE_TARGETS, 'any_target', 'opponent']],
  ['return_hand', ['any_creature']],
  ['destroy', ['any_creature']],
  // all_creatures escluso: il motore applica i bonus solo alle creature di chi gioca la carta.
  ['buff', ['any_creature', 'all_creatures_self', 'enchanted_creature', 'source_creature']],
]);
// Trigger ammessi per tipo di carta (Aure: attacco della creatura equipaggiata; Terraforme: evocazione di un Mostro).
const CARD_TRIGGERS: Record<string, string[]> = { aura: ['equipped_creature_attacks'], terraforma: ['own_monster_summoned', 'own_turn_start', 'own_creature_dies'] };
const DURATIONS = ['permanent', 'turn', 'while_attached', 'while_in_play'];
const FACTIONS = ['CHI', 'INF', 'PES', 'BUL', 'GRO', 'CLO'];

const object = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
function effectList(raw: unknown): Json[] {
  const o = object(raw);
  if (!o) return [];
  return Array.isArray(o.effects) ? o.effects.map(x => object(x) ?? {}) : [o];
}

function filterErrors(e: Json, type: string, t: string): string[] {
  const out: string[] = [];
  if (e.filter === undefined) return out;
  const f = object(e.filter);
  const creatureStatic = CREATURES.includes(type) && t === 'buff' && e.duration === 'while_in_play';
  if (!creatureStatic && (type !== 'terraforma' || (t !== 'buff' && e.trigger !== 'own_monster_summoned'))) out.push('I filtri per sottotipo o fazione valgono solo per i bonus continui di Terraforme, Mostri e Mostrissimi e per il trigger "evochi una creatura".');
  else if (!f || (f.subtype === undefined && f.faction === undefined) || Object.keys(f).some(k => k !== 'subtype' && k !== 'faction'))
    out.push('Filtro non valido: indica un sottotipo e/o una fazione.');
  else {
    if (f.subtype !== undefined && (typeof f.subtype !== 'string' || !f.subtype.trim() || f.subtype.length > 60)) out.push('Filtro: sottotipo non valido.');
    if (f.faction !== undefined && !FACTIONS.includes(String(f.faction))) out.push('Filtro: fazione non valida.');
  }
  return out;
}

function effectErrors(e: Json, type: string, trigger: unknown, death = false): string[] {
  const out: string[] = [];
  const t = e.type === 'damage_creature' ? 'damage' : e.type === 'nope' ? 'counter' : String(e.type);
  const amount = e.amount as number | undefined;
  if (amount !== undefined && !(Number.isInteger(amount) && amount >= 0 && amount <= 20))
    out.push(`${t}: la quantità deve essere tra 0 e 20.`);
  if (e.keep !== undefined && (t !== 'discard' || !Number.isInteger(e.keep) || (e.keep as number) < 0 || (e.keep as number) > 20 || e.trigger !== undefined))
    out.push('Scarto "tutta la mano tranne N": solo per lo scarto, con N tra 0 e 20 e senza trigger.');
  if (t === 'counter') {
    if (type !== 'instant' || !COUNTER_TRIGGERS.includes(String(trigger)))
      out.push('NOPE: serve una Trappola con evento "carta dalla mano", "ingresso mostro" o "prima del Mostrissimo".');
    return out;
  }
  if (t === 'movement_cost') {
    if (type !== 'aura' || amount !== 0) out.push('Il movimento a costo 0 vale solo per le Aure.');
    return out;
  }
  if (e.trigger !== undefined) {
    // Effetto con trigger: Aure ("quando la creatura equipaggiata attacca") e Terraforme ("ogni volta che evochi un tuo mostro").
    if (!CARD_TRIGGERS[type]?.includes(String(e.trigger)))
      out.push(type === 'aura' ? 'Le Aure usano il trigger "quando la creatura attacca".' : type === 'terraforma' ? 'Le Terraforme usano i trigger "evochi una creatura", "inizia il tuo turno" o "una tua creatura muore".' : 'I trigger valgono solo per Aure e Terraforme.');
    else if (!Number.isInteger(amount)) out.push('Serve la quantità.');
    else if (t === 'heal' || t === 'draw') { if (e.target !== 'self') out.push(`${t}: con un trigger il bersaglio è il proprietario.`); }
    else if (t === 'discard') { if (e.target !== 'opponent') out.push('Scarta: con un trigger scarta l\'avversario.'); }
    else if (t === 'damage') { if (e.target !== 'any_target' && e.target !== 'opponent') out.push('Danno: con un trigger il bersaglio è l\'avversario o a scelta.'); }
    else if (t === 'buff') {
      if (e.target !== 'triggering_creature') out.push('Un bonus con trigger colpisce la creatura che ha attivato il trigger.');
      if (e.trigger !== 'own_monster_summoned' && e.trigger !== 'equipped_creature_attacks') out.push('Il bonus alla creatura vale solo con "evochi una creatura" o "quando attacca".');
      if (e.stat !== 'hp' && e.stat !== 'attack') out.push('Bonus: scegli attacco o PV.');
      if (!(e.duration === 'permanent' || (e.duration === 'turn' && e.stat === 'attack')))
        out.push('Il bonus del trigger è permanente (a fine turno solo per l\'attacco).');
    } else out.push(`${t}: effetto non ammesso con un trigger.`);
    out.push(...filterErrors(e, type, t));
    return out;
  }
  if (e.target === 'triggering_creature') out.push('Il bersaglio "creatura che ha attivato il trigger" richiede un trigger.');
  if (e.target === 'any_target' && t !== 'damage') out.push('Il bersaglio a scelta tra giocatore e creature vale solo per i danni.');
  if (e.target === 'source_creature' && (t !== 'buff' || !CREATURES.includes(type) || death))
    out.push('"Questa creatura" vale solo per i bonus all\'ingresso di Mostri e Mostrissimi.');
  const allowed = TARGETS.get(t);
  if (!allowed) { out.push(`Effetto "${String(e.type)}" non supportato dal motore.`); return out; }
  if (type === 'aura' && t !== 'buff') out.push('Le Aure ammettono solo bonus o movimento a costo 0.');
  if (type === 'terraforma' && t !== 'buff') out.push('Le Terraforme ammettono solo bonus.');
  const target = (e.target as string | undefined) ?? (t === 'draw' ? 'self' : t === 'discard' ? 'opponent' : null);
  if (target && !allowed.includes(target)) out.push(`${t}: il bersaglio "${target}" blocca la partita.`);
  out.push(...filterErrors(e, type, t));
  if (t === 'buff') {
    const d = String(e.duration);
    if (!DURATIONS.includes(d)) out.push('Bonus: durata non supportata.');
    if (e.stat !== 'hp' && e.stat !== 'attack') out.push('Bonus: scegli attacco o PV.');
    if (e.stat === 'hp' && d === 'turn') out.push('Bonus PV a fine turno non supportato.');
    const passive = d === 'while_attached' || d === 'while_in_play';
    if (type === 'aura' && d !== 'while_attached') out.push('Le Aure usano solo bonus "finché è attaccata".');
    else if (type === 'terraforma' && d !== 'while_in_play') out.push('Le Terraforme usano solo bonus "finché è in campo".');
    else if (CREATURES.includes(type) && d === 'while_attached') out.push('Il bonus "finché attaccata" vale solo per le Aure.');
    else if (type !== 'aura' && type !== 'terraforma' && !CREATURES.includes(type) && passive)
      out.push('I bonus "finché attaccata" o "finché in campo" valgono solo per Aure, Terraforme, Mostri e Mostrissimi.');
    // Bonus continuo di un Mostro o Mostrissimo: a tutte le tue creature, non alla morte.
    if (CREATURES.includes(type) && d === 'while_in_play') {
      if (target !== 'all_creatures_self') out.push('Il bonus continuo di un Mostro va a tutte le tue creature.');
      if (death) out.push('Un bonus continuo non può essere un effetto alla morte.');
    }
    if (type === 'aura' && target && !['enchanted_creature', 'all_creatures_self'].includes(target))
      out.push('Le Aure danno bonus alla creatura incantata o a tutte le tue.');
    if (type === 'terraforma' && target !== 'all_creatures_self') out.push('Le Terraforme danno bonus a tutte le tue creature.');
    if (passive && !Number.isInteger(amount)) out.push('Bonus: serve la quantità.');
  }
  return out;
}

export function engineErrors(card: unknown): string[] {
  const c = object(card) ?? {}, out: string[] = [];
  const type = String(c.card_type);
  if (!TYPES.includes(type)) out.push('Tipo non supportato.');
  const cost = c.mana_cost as number;
  if (!Number.isInteger(cost) || cost < 0) out.push('Costo mana non valido.');
  if (CREATURES.includes(type) && (!Number.isInteger(c.attack) || !Number.isInteger(c.hp))) out.push('Attacco e PV sono obbligatori.');
  const sacrifice = c.sacrifice_cost as number;
  if (type === 'mostrissimo' && !(Number.isInteger(sacrifice) && sacrifice >= 0)) out.push('Sacrifici non validi.');
  if (c.is_boss === true && !(type === 'monster' && cost === 6)) out.push('Un boss è un Mostro da 6 mana.');
  if (type === 'terraforma' && !(Number.isInteger(c.hp) && (c.hp as number) >= 1)) out.push('Le Terraforme hanno PV (almeno 1): si possono attaccare e distruggere.');
  const main = effectList(c.effect_json), trigger = object(c.effect_json)?.reaction_trigger;
  const event = object(trigger)?.event;
  if (['maledizione', 'instant', 'aura', 'terraforma'].includes(type) && !main.length) out.push('Questo tipo richiede almeno un effetto.');
  if (type === 'instant' && !TRIGGERS.includes(String(event))) out.push('La Trappola richiede un evento valido.');
  for (const e of main) out.push(...effectErrors(e, type, event));
  // Gli effetti alla morte si risolvono a metà partita, con le regole dei Mostri.
  for (const e of effectList(c.effect_on_death_json)) out.push(...effectErrors(e, 'monster', undefined, true));
  return out;
}
