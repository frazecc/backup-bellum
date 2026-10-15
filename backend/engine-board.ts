// backend/engine-board.ts — utilità pure per plancia, bersagli e regole condivise.
// Fase 3: supporto permanenti (creature, terraforme, aure) per return_hand e destroy.
import type {
  BoardCell, CardData, CardEffectJson, CardInstance, CreatureCell,
  EffectDefinition, GameState, PendingWork, PlayerIndex, Position,
  ReactionTriggerEvent, TurnPhase,
} from './types.js';

export const other = (p: PlayerIndex): PlayerIndex => p === 0 ? 1 : 0;
export const label = (p: PlayerIndex) => p === 1 ? 'Tu' : 'L’IA';
export const home = (p: PlayerIndex) => p === 0 ? 0 : 2;
export const allowed = (p: PlayerIndex, row: number) => row !== home(other(p));
export const valid = (p: Position) => Number.isInteger(p.row) && Number.isInteger(p.col) && p.row >= 0 && p.row < 3 && p.col >= 0 && p.col < 3;
export const adjacent = (a: Position, b: Position) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1;
export const around = (p: Position) => [{ row: p.row - 1, col: p.col }, { row: p.row + 1, col: p.col }, { row: p.row, col: p.col - 1 }, { row: p.row, col: p.col + 1 }].filter(valid);
export const blank = (): GameState['board'] => ({ rows: [[null, null, null], [null, null, null], [null, null, null]] });
export const at = (s: GameState, p: Position) => valid(p) ? s.board.rows[p.row][p.col] : null;
export const put = (s: GameState, p: Position, c: BoardCell | null) => { s.board.rows[p.row][p.col] = c; };
export const instance = (c: CardInstance): CardInstance => ({ instance_id: c.instance_id, card_id: c.card_id });
export const effects = (raw: CardEffectJson | null): EffectDefinition[] => raw && 'effects' in raw && Array.isArray(raw.effects) ? raw.effects : raw && 'type' in raw ? [raw] : [];
export const reactionTrigger = (d: CardData): ReactionTriggerEvent | undefined => d.effect_json?.reaction_trigger?.event;

/** Effetti che richiedono scelta di un bersaglio permanente/creatura */
export const targeted = (e: EffectDefinition) =>
  e.target === 'any_creature' ||
  e.target === 'any_target' ||
  e.type === 'return_hand' ||
  e.type === 'destroy';

export const supported = new Set(['draw', 'discard', 'heal', 'damage', 'damage_creature', 'return_hand', 'destroy', 'buff']);
export const phaseNumber = (p: TurnPhase) => ({ start: 0, upkeep: 1, main: 2, end: 3 })[p];

export function shuffle<T>(input: T[]) {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
export function cells(s: GameState) {
  const out: { position: Position; cell: BoardCell }[] = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const cell = s.board.rows[row][col];
    if (cell) out.push({ position: { row, col }, cell });
  }
  return out;
}
export function units(s: GameState, owner?: PlayerIndex) {
  return cells(s).filter((x): x is { position: Position; cell: CreatureCell } => x.cell.kind === 'creature' && (owner === undefined || x.cell.owner_index === owner));
}
export function find(s: GameState, id: string) { return cells(s).find(x => x.cell.instance_id === id) ?? null; }
export function findCreature(s: GameState, id: string) {
  const x = find(s, id);
  return x?.cell.kind === 'creature' ? { position: x.position, cell: x.cell } : null;
}
export function findAura(s: GameState, id: string) {
  for (const host of units(s)) {
    const aura = host.cell.auras.find(a => a.instance_id === id);
    if (aura) return { ...host, aura };
  }
  return null;
}

/** Tutti i permanenti sulla plancia: creature + terraforme + aure (come oggetti con kind e id) */
export type PermanentRef =
  | { kind: 'creature'; position: Position; cell: CreatureCell; instance_id: string; card_id: string; owner_index: PlayerIndex }
  | { kind: 'terraforma'; position: Position; cell: BoardCell; instance_id: string; card_id: string; owner_index: PlayerIndex }
  | { kind: 'aura'; position: Position; host: CreatureCell; aura: CardInstance & { owner_index: PlayerIndex }; instance_id: string; card_id: string; owner_index: PlayerIndex };

export function permanentsOnBoard(s: GameState, owner?: PlayerIndex): PermanentRef[] {
  const out: PermanentRef[] = [];
  for (const { position, cell } of cells(s)) {
    if (owner !== undefined && cell.owner_index !== owner) continue;
    if (cell.kind === 'creature') {
      out.push({
        kind: 'creature',
        position,
        cell,
        instance_id: cell.instance_id,
        card_id: cell.card_id,
        owner_index: cell.owner_index,
      });
      for (const aura of cell.auras) {
        if (owner !== undefined && aura.owner_index !== owner) continue;
        out.push({
          kind: 'aura',
          position,
          host: cell,
          aura,
          instance_id: aura.instance_id,
          card_id: aura.card_id,
          owner_index: aura.owner_index,
        });
      }
    } else if (cell.kind === 'terraforma') {
      out.push({
        kind: 'terraforma',
        position,
        cell,
        instance_id: cell.instance_id,
        card_id: cell.card_id,
        owner_index: cell.owner_index,
      });
    }
  }
  return out;
}

export function findPermanent(s: GameState, id: string): PermanentRef | null {
  return permanentsOnBoard(s).find(p => p.instance_id === id) ?? null;
}

export function enemyNeighbours(s: GameState, p: Position, owner: PlayerIndex) {
  return around(p).filter(q => { const c = at(s, q); return c?.kind === 'creature' && c.owner_index === other(owner); });
}

export function eligible(s: GameState, owner: PlayerIndex, e: EffectDefinition) {
  // Per return_hand e destroy il bersaglio può essere un permanente: gestito a parte in targetChoices.
  if (e.target === 'any_target') return units(s);
  if ((e.type === 'damage' || e.type === 'damage_creature') && e.timing !== 'instant') return units(s, other(owner));
  if (e.type === 'heal' && e.timing !== 'instant') return units(s, owner);
  return units(s);
}

export function target(s: GameState, owner: PlayerIndex, effect: EffectDefinition, id: string | null) {
  const x = id ? findCreature(s, id) : null;
  return x && eligible(s, owner, effect).some(v => v.cell.instance_id === id) ? x : null;
}

// Bersaglio "giocatore" nelle scelte: l'avversario di chi gioca la carta, con id fittizio player:<indice>.
export const playerTargetId = (p: PlayerIndex) => `player:${p}`;
const isDamage = (e: EffectDefinition) => e.type === 'damage' || e.type === 'damage_creature';

/**
 * Tutti gli id scegliibili per un effetto mirato.
 * - danni any_target: creature + giocatore avversario
 * - return_hand / destroy: tutti i permanenti eleggibili (filtrati poi in validTarget / applyEffect)
 */
export function targetChoices(s: GameState, owner: PlayerIndex, e: EffectDefinition): string[] {
  if (e.type === 'return_hand' || e.type === 'destroy') {
    // Restituiamo tutti i permanenti; il filtro Mostrissimo per return_hand avviene in validTarget/applyEffect
    // (serve getCardData, quindi non puro). Qui restituiamo gli id disponibili.
    return permanentsOnBoard(s).map(p => p.instance_id);
  }
  const ids = eligible(s, owner, e).map(x => x.cell.instance_id);
  return isDamage(e) && e.target === 'any_target' ? [...ids, playerTargetId(other(owner))] : ids;
}

export function validTarget(s: GameState, owner: PlayerIndex, e: EffectDefinition, id: string | null) {
  if (!id) return false;
  if (isDamage(e) && e.target === 'any_target' && id === playerTargetId(other(owner))) return true;
  if (e.type === 'return_hand' || e.type === 'destroy') {
    return !!findPermanent(s, id);
  }
  return !!target(s, owner, e, id);
}

// Terraforme nemiche con PV, ortogonalmente adiacenti: si possono attaccare ma non bloccano l'attacco diretto.
export function enemyTerraformas(s: GameState, p: Position, owner: PlayerIndex) {
  return around(p).filter(q => { const c = at(s, q); return c?.kind === 'terraforma' && c.owner_index === other(owner) && c.hp !== undefined; });
}
export function prepend(s: GameState, ...items: PendingWork[]) { s.work_queue.unshift(...items); }
export function keyword(d: CardData, value: string) {
  const extra = d as CardData & { keywords?: unknown; keyword_json?: unknown };
  return [extra.keywords, extra.keyword_json].some(x => Array.isArray(x) && x.some(v => String(v).toLowerCase() === value));
}
