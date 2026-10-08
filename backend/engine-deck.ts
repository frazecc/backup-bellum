// backend/engine-deck.ts — catalogo, mazzi a tre colori e regole di giocabilità.
import { randomUUID } from 'node:crypto';
import type {
  CardData, CardEffectJson, CardInstance, DeckColors, DeckFaction, EffectDefinition, PlayerIndex, PlayerState,
} from './types.js';
import { effects, shuffle, supported } from './engine-board.js';
import { db } from './engine-storage.js';
import { engineErrors } from './card-rules.js';

// Effetto con trigger valido per Aure ("equipped_creature_attacks") e Terraforme ("own_monster_summoned").
function triggeredOk(e: EffectDefinition, allowed: string[]) {
  if (!e.trigger || !allowed.includes(e.trigger) || !Number.isInteger(e.amount) || Number(e.amount) < 0 || Number(e.amount) > 20) return false;
  if (e.type === 'heal' || e.type === 'draw') return e.target === 'self';
  if (e.type === 'discard') return e.target === 'opponent';
  if (e.type === 'damage') return e.target === 'any_target' || e.target === 'opponent';
  if (e.type === 'buff') return e.target === 'triggering_creature' && (e.trigger === 'own_monster_summoned' || e.trigger === 'equipped_creature_attacks') && (e.stat === 'hp' || e.stat === 'attack')
    && (e.duration === 'permanent' || (e.duration === 'turn' && e.stat === 'attack'));
  return false;
}
// Bonus continuo di un Mostro o Mostrissimo: tutte le tue creature (con filtro opzionale) finché è in campo.
export function staticCreatureBuff(e: EffectDefinition) {
  return e.trigger === undefined && e.type === 'buff' && e.duration === 'while_in_play' && e.target === 'all_creatures_self'
    && (e.stat === 'hp' || e.stat === 'attack') && Number.isInteger(e.amount) && Number(e.amount) >= 0 && Number(e.amount) <= 20;
}
export function passiveAura(d: CardData) {
  const list = effects(d.effect_json);
  return list.length > 0 && list.every(e => triggeredOk(e, ['equipped_creature_attacks']) || e.trigger === undefined && (
    e.type === 'buff' && e.duration === 'while_attached' && (e.target === 'enchanted_creature' || e.target === 'all_creatures_self') && (e.stat === 'hp' || e.stat === 'attack') && Number.isInteger(e.amount) && Number(e.amount) >= 0 && Number(e.amount) <= 20
    || e.type === 'movement_cost' && e.duration === 'while_attached' && e.target === 'enchanted_creature' && e.amount === 0));
}
export function passiveLand(d: CardData) {
  const list = effects(d.effect_json);
  return list.length > 0 && list.every(e => triggeredOk(e, ['own_monster_summoned', 'own_turn_start', 'own_creature_dies']) || e.trigger === undefined
    && e.type === 'buff' && e.duration === 'while_in_play' && e.target === 'all_creatures_self' && (e.stat === 'hp' || e.stat === 'attack')
    && Number.isInteger(e.amount) && Number(e.amount) >= 0 && Number(e.amount) <= 20);
}
export function playableEffects(d: CardData) {
  const list = effects(d.effect_json);
  return d.card_type === 'aura' ? passiveAura(d) : d.card_type === 'terraforma' ? passiveLand(d) : list.every(e => supported.has(e.type) && e.duration !== 'while_attached' && e.duration !== 'while_in_play' || staticCreatureBuff(e));
}

const deckFactions: DeckFaction[] = ['CHI', 'INF', 'PES', 'BUL', 'GRO', 'CLO'];
// Solo le fazioni con almeno 2 carte giocabili possono entrare in un mazzo: finché una fazione non ha carte
// non viene scelta a caso come terzo colore (né per l'IA) e il giocatore riceve un messaggio chiaro.
export function availableFactions(pool: DeckCard[]): DeckFaction[] {
  return deckFactions.filter(f => pool.filter(x => x.faction === f && !x.boss).length >= 2);
}
// Il mazzo ha un solo boss: un Mostro da 6 mana del colore principale. Solo le fazioni che ne hanno uno
// possono essere scelte come colore principale.
export function bossFactions(pool: DeckCard[]): DeckFaction[] {
  return deckFactions.filter(f => pool.some(x => x.boss && x.cost === 6 && x.faction === f));
}
export function chosenColors(primary: DeckFaction, secondary: DeckFaction, available: DeckFaction[] = deckFactions, bosses: DeckFaction[] = deckFactions): DeckColors {
  if (!deckFactions.includes(primary) || !deckFactions.includes(secondary) || primary === secondary)
    throw new Error('Seleziona due colori distinti tra le sei fazioni');
  for (const f of [primary, secondary]) if (!available.includes(f)) throw new Error(`La fazione ${f} non ha ancora abbastanza carte: scegli un altro colore`);
  if (!bosses.includes(primary)) throw new Error(`La fazione ${primary} non ha un boss da 6 mana: scegli un altro colore principale`);
  const tertiary = shuffle(available.filter(x => x !== primary && x !== secondary))[0];
  if (!tertiary) throw new Error('Servono almeno tre fazioni con carte per costruire i mazzi');
  return { primary, secondary, tertiary };
}
export function randomColors(available: DeckFaction[] = deckFactions, bosses: DeckFaction[] = deckFactions): DeckColors {
  const primary = shuffle(available.filter(f => bosses.includes(f)))[0];
  const [secondary, tertiary] = shuffle(available.filter(f => f !== primary));
  if (!primary || !secondary || !tertiary) throw new Error('Servono almeno tre fazioni con carte, e una con un boss da 6 mana, per costruire i mazzi');
  return { primary, secondary, tertiary };
}
type DeckCard = { id: string; cost: number; type: string; faction: DeckFaction; raw: CardEffectJson | null; death: CardEffectJson | null; boss: boolean };
// Gli effetti alla morte partono a metà partita: un tipo non implementato (counter, nope,
// custom, movement_cost) lancia un errore e blocca la mossa. Stesse regole dei Mostri.
function deathPlayable(raw: CardEffectJson | null): boolean {
  return effects(raw).every(e => supported.has(e.type) && e.duration !== 'while_attached' && e.duration !== 'while_in_play');
}
function deckPlayable(x: DeckCard): boolean { return effectsPlayable(x) && deathPlayable(x.death); }
function effectsPlayable(x: DeckCard): boolean {
  const d = { card_type: x.type, effect_json: x.raw } as CardData;
  const list = effects(x.raw);
  if (x.type === 'aura') return passiveAura(d);
  if (x.type === 'terraforma') return passiveLand(d);
  if (x.type === 'instant') return list.length > 0 && !!x.raw?.reaction_trigger && list.every(e => supported.has(e.type) || e.type === 'counter' || e.type === 'nope');
  return list.every(e => supported.has(e.type) && e.duration !== 'while_attached' && e.duration !== 'while_in_play' || x.type === 'monster' && staticCreatureBuff(e));
}
export async function deckPool(): Promise<DeckCard[]> {
  const { data, error } = await db.from('cards').select('id,card_type,mana_cost,attack,hp,sacrifice_cost,effect_json,effect_on_death_json,is_boss,factions!inner(code)')
    .in('card_type', ['monster', 'instant', 'aura', 'terraforma', 'maledizione']);
  if (error || !data) throw new Error(`Catalogo non disponibile: ${error?.message ?? 'nessun risultato'}`);
  const pool: DeckCard[] = [], skipped: string[] = [];
  for (const row of data) {
    const problems = engineErrors(row);
    if (problems.length) { skipped.push(`${row.id}: ${problems[0]}`); continue; }
    const linked = Array.isArray(row.factions) ? row.factions[0] : row.factions;
    const code = linked && typeof linked === 'object' && 'code' in linked ? String(linked.code).toUpperCase() : '';
    if (!deckFactions.includes(code as DeckFaction)) continue;
    const x: DeckCard = { id: String(row.id), cost: Number(row.mana_cost), type: String(row.card_type),
      faction: code as DeckFaction, raw: row.effect_json as CardEffectJson | null,
      death: row.effect_on_death_json as CardEffectJson | null, boss: row.is_boss === true };
    if (Number.isInteger(x.cost) && x.cost >= 0 && deckPlayable(x)) pool.push(x);
  }
  if (skipped.length) console.warn(`Carte escluse dai mazzi (${skipped.length}):\n${skipped.join('\n')}`);
  return pool;
}
export function deck(pool: DeckCard[], colors: DeckColors): CardInstance[] {
  // Regola del boss: il mazzo ha esattamente un boss, un Mostro da 6 mana del colore principale; gli altri boss non entrano.
  const bosses = pool.filter(x => x.boss && x.cost === 6 && x.faction === colors.primary);
  if (!bosses.length) throw new Error(`Il colore principale ${colors.primary} non ha un boss da 6 mana`);
  const selected = pool.filter(x => !x.boss && (x.faction === colors.primary || x.faction === colors.secondary || x.faction === colors.tertiary));
  const by = (faction: DeckFaction) => selected.filter(x => x.faction === faction);
  if (by(colors.primary).length < 1 || by(colors.secondary).length < 2 || by(colors.tertiary).length < 1)
    throw new Error(`Catalogo insufficiente per il mazzo ${colors.primary}/${colors.secondary}/${colors.tertiary}`);
  const unique = new Map<string, DeckCard>();
  for (const x of selected) unique.set(x.id, x);
  const cards = [...unique.values()];
  if (cards.length < 9) throw new Error(`Catalogo insufficiente: meno di 9 carte distinte, oltre al boss, per ${colors.primary}/${colors.secondary}/${colors.tertiary}`);
  const counts = (xs: DeckCard[], faction: DeckFaction) => xs.filter(x => x.faction === faction).length;
  const validDeck = (xs: DeckCard[]) => {
    const sum = xs.reduce((n, x) => n + x.cost, 0);
    return xs.length === 10 && sum >= 25 && sum <= 40
      && counts(xs, colors.primary) >= 2 && counts(xs, colors.secondary) >= 2 && counts(xs, colors.tertiary) >= 1
      && xs.filter(x => x.boss).length === 1;
  };
  let best: DeckCard[] | null = null, bestScore = -Infinity;
  for (let attempt = 0; attempt < 1500; attempt++) {
    const picked: DeckCard[] = [];
    const used = new Set<string>();
    const take = (options: DeckCard[]) => {
      const available = options.filter(x => !used.has(x.id));
      if (!available.length) return false;
      const x = available[Math.floor(Math.random() * available.length)];
      picked.push(x); used.add(x.id); return true;
    };
    const boss = bosses[Math.floor(Math.random() * bosses.length)];
    picked.push(boss); used.add(boss.id);
    if (!take(by(colors.primary)) || !take(by(colors.secondary)) || !take(by(colors.secondary)) || !take(by(colors.tertiary))) continue;
    while (picked.length < 10 && take(cards)) { /* riempimento casuale senza duplicati */ }
    if (!validDeck(picked)) continue;
    const differentTypes = new Set(picked.map(x => x.type)).size;
    const nonMonsters = picked.filter(x => x.type !== 'monster').length;
    const score = differentTypes * 4 + Math.min(nonMonsters, 4) * 2 + Math.random() * 12;
    if (score > bestScore) { best = picked; bestScore = score; }
  }
  if (!best) throw new Error(`Nessun mazzo valido per ${colors.primary}/${colors.secondary}/${colors.tertiary}: controlla il catalogo e la curva mana 2,5–4`);
  return shuffle(best.map(x => ({ instance_id: randomUUID(), card_id: x.id })));
}
export async function offer() {
  const { data, error } = await db.from('cards').select('id,card_type,mana_cost,attack,hp,sacrifice_cost,effect_json,effect_on_death_json').eq('card_type', 'mostrissimo');
  if (error || !data) throw new Error(`Catalogo Mostrissimi non disponibile: ${error?.message ?? 'nessun risultato'}`);
  // Se troppi Mostrissimi risultassero non validi si usa l'elenco completo: meglio una partita che non parte mai.
  const valid = data.filter(x => engineErrors(x).length === 0);
  if (valid.length < data.length) console.warn(`Mostrissimi non validi: ${data.filter(x => !valid.includes(x)).map(x => x.id).join(', ')}`);
  const ids = shuffle((valid.length >= 3 ? valid : data).map(x => String(x.id)));
  // Senza Mostrissimi in catalogo la partita parte comunque, con l'offerta condivisa vuota.
  return { shared: ids.slice(0, 3).map(card_id => ({ card_id, instance_id: randomUUID() })), remaining: ids.slice(3) };
}
export function player(index: PlayerIndex, userId: string | null, deckCards: CardInstance[]): PlayerState {
  return { player_index: index, user_id: userId, life: 20, max_mana: 0, current_mana: 0, deck: deckCards, hand: [], graveyard: [], extra_deck: [], color_counters: { CHI: 0, INF: 0, PES: 0, BUL: 0, GRO: 0, CLO: 0, IND: 0 } };
}
