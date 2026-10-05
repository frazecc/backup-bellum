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
  ['damage', CREATURE_TARGETS],
  ['return_hand', ['any_creature']],
  ['destroy', ['any_creature']],
  // all_creatures escluso: il motore applica i bonus solo alle creature di chi gioca la carta.
  ['buff', ['any_creature', 'all_creatures_self', 'enchanted_creature']],
]);
const DURATIONS = ['permanent', 'turn', 'while_attached', 'while_in_play'];

const object = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
function effectList(raw: unknown): Json[] {
  const o = object(raw);
  if (!o) return [];
  return Array.isArray(o.effects) ? o.effects.map(x => object(x) ?? {}) : [o];
}

function effectErrors(e: Json, type: string, trigger: unknown): string[] {
  const out: string[] = [];
  const t = e.type === 'damage_creature' ? 'damage' : e.type === 'nope' ? 'counter' : String(e.type);
  const amount = e.amount as number | undefined;
  if (amount !== undefined && !(Number.isInteger(amount) && amount >= 0 && amount <= 20))
    out.push(`${t}: la quantità deve essere tra 0 e 20.`);
  if (t === 'counter') {
    if (type !== 'instant' || !COUNTER_TRIGGERS.includes(String(trigger)))
      out.push('NOPE: serve una Trappola con evento "carta dalla mano", "ingresso mostro" o "prima del Mostrissimo".');
    return out;
  }
  if (t === 'movement_cost') {
    if (type !== 'aura' || amount !== 0) out.push('Il movimento a costo 0 vale solo per le Aure.');
    return out;
  }
  const allowed = TARGETS.get(t);
  if (!allowed) { out.push(`Effetto "${String(e.type)}" non supportato dal motore.`); return out; }
  if (type === 'aura' && t !== 'buff') out.push('Le Aure ammettono solo bonus o movimento a costo 0.');
  if (type === 'terraforma' && t !== 'buff') out.push('Le Terraforme ammettono solo bonus.');
  const target = (e.target as string | undefined) ?? (t === 'draw' ? 'self' : t === 'discard' ? 'opponent' : null);
  if (target && !allowed.includes(target)) out.push(`${t}: il bersaglio "${target}" blocca la partita.`);
  if (t === 'buff') {
    const d = String(e.duration);
    if (!DURATIONS.includes(d)) out.push('Bonus: durata non supportata.');
    if (e.stat !== 'hp' && e.stat !== 'attack') out.push('Bonus: scegli attacco o PV.');
    if (e.stat === 'hp' && d === 'turn') out.push('Bonus PV a fine turno non supportato.');
    const passive = d === 'while_attached' || d === 'while_in_play';
    if (type === 'aura' && d !== 'while_attached') out.push('Le Aure usano solo bonus "finché è attaccata".');
    else if (type === 'terraforma' && d !== 'while_in_play') out.push('Le Terraforme usano solo bonus "finché è in campo".');
    else if (type !== 'aura' && type !== 'terraforma' && passive)
      out.push('I bonus "finché attaccata" o "finché in campo" valgono solo per Aure e Terraforme.');
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
  const main = effectList(c.effect_json), trigger = object(c.effect_json)?.reaction_trigger;
  const event = object(trigger)?.event;
  if (['maledizione', 'instant', 'aura', 'terraforma'].includes(type) && !main.length) out.push('Questo tipo richiede almeno un effetto.');
  if (type === 'instant' && !TRIGGERS.includes(String(event))) out.push('La Trappola richiede un evento valido.');
  for (const e of main) out.push(...effectErrors(e, type, event));
  // Gli effetti alla morte si risolvono a metà partita, con le regole dei Mostri.
  for (const e of effectList(c.effect_on_death_json)) out.push(...effectErrors(e, 'monster', undefined));
  return out;
}
