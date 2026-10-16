/**
 * tools/sim-ai-vs-ai.ts — Simulatore IA vs IA (MVP)
 *
 * Lato 0 = IA motore esistente.
 * Lato 1 = euristica “umana” (stesse azioni API: play / attack / move / end-turn).
 *
 * Uso (dalla cartella backend, con .env Supabase):
 *   npx tsx tools/sim-ai-vs-ai.ts --n 50 --out ../sims/run.jsonl
 *   npx tsx tools/sim-ai-vs-ai.ts --n 20 --max-turns 40
 *
 * Output: JSONL (una riga = un match) + riepilogo su stderr.
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  attack,
  createNewMatch,
  endHumanTurn,
  getCardData,
  getMatchState,
  moveCreature,
  playCard,
  resolveDeathOrder,
  resolveTargetChoice,
  resolveTrapChoice,
} from '../engine.js';
import type { DeckFaction, GameState, PlayerIndex, Position } from '../types.js';

const FACTIONS: DeckFaction[] = ['CHI', 'INF', 'PES', 'BUL', 'GRO', 'CLO'];

type SimMatchResult = {
  match_id: string;
  winner_index: PlayerIndex | null;
  status: string;
  turns: number;
  steps: number;
  duration_ms: number;
  colors: {
    p0: { primary: string; secondary: string; tertiary: string };
    p1: { primary: string; secondary: string; tertiary: string };
  };
  end_life: [number, number];
  cards_played: { turn: number; player: number; card_id: string; name?: string }[];
  truncated: boolean;
  error?: string;
};

function parseArgs(argv: string[]) {
  let n = 20;
  let maxTurns = 60;
  let out = resolve(process.cwd(), `sims/run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  let seedUser = `sim-${randomUUID().slice(0, 8)}@bellum.local`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n' && argv[i + 1]) n = Math.max(1, Number(argv[++i]) || 20);
    else if (a === '--max-turns' && argv[i + 1]) maxTurns = Math.max(5, Number(argv[++i]) || 60);
    else if (a === '--out' && argv[i + 1]) out = resolve(argv[++i]);
    else if (a === '--user' && argv[i + 1]) seedUser = argv[++i];
    else if (a === '--help') {
      console.error(`Usage: npx tsx tools/sim-ai-vs-ai.ts [--n 50] [--max-turns 60] [--out path.jsonl]`);
      process.exit(0);
    }
  }
  return { n, maxTurns, out, seedUser };
}

function pickTwoColors(): { primary: DeckFaction; secondary: DeckFaction } {
  const shuffled = [...FACTIONS].sort(() => Math.random() - 0.5);
  return { primary: shuffled[0], secondary: shuffled[1] };
}

function unitsOf(s: GameState, p: PlayerIndex) {
  const out: { row: number; col: number; cell: NonNullable<(typeof s.board.rows)[0][0]> }[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const cell = s.board.rows[row][col];
      if (cell && cell.kind === 'creature' && cell.owner_index === p) out.push({ row, col, cell });
    }
  }
  return out;
}

function emptyHomeCells(s: GameState, p: PlayerIndex): Position[] {
  const row = p === 1 ? 2 : 0;
  const pos: Position[] = [];
  for (let col = 0; col < 3; col++) {
    if (!s.board.rows[row][col]) pos.push({ row, col });
  }
  return pos;
}

function adjacent(a: Position, b: Position) {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1;
}

/** Una mossa euristica per il giocatore 1 (o passa). Ritorna true se ha fatto qualcosa. */
async function heuristicStepP1(matchId: string, s: GameState): Promise<GameState> {
  const p = 1 as PlayerIndex;
  const me = s.players[p];

  // 1) Attacco: prioritizza face se libera, altrimenti creatura a più ATK
  for (const u of unitsOf(s, p)) {
    if (u.cell.tired || (u.cell.attack ?? 0) <= 0) continue;
    const from = { row: u.row, col: u.col };
    const enemies = unitsOf(s, 0);
    const blocked = enemies.some(e => adjacent(from, { row: e.row, col: e.col }));
    try {
      if (!blocked) {
        return await attack(matchId, p, from, { type: 'player', playerIndex: 0 });
      }
      const victim = [...enemies].sort((a, b) => (b.cell.attack ?? 0) - (a.cell.attack ?? 0))[0];
      if (victim && adjacent(from, { row: victim.row, col: victim.col })) {
        return await attack(matchId, p, from, {
          type: 'creature',
          position: { row: victim.row, col: victim.col },
        });
      }
    } catch {
      /* prova altra unità */
    }
  }

  // 2) Gioca una carta dalla mano (mostro/terraforma/aura se possibile)
  for (const inst of [...me.hand]) {
    let d;
    try {
      d = await getCardData(inst.card_id);
    } catch {
      continue;
    }
    if (d.card_type === 'instant' || d.card_type === 'mostrissimo') continue;
    const cost = Number(d.mana_cost ?? 0);
    if (cost > me.current_mana) continue;
    const options: { position?: Position; targetInstanceId?: string } = {};
    if (d.card_type === 'monster' || d.card_type === 'terraforma') {
      const cells = emptyHomeCells(s, p);
      if (!cells.length) continue;
      options.position = cells[0];
    }
    if (d.card_type === 'aura') {
      const host = unitsOf(s, p).sort((a, b) => (b.cell.hp ?? 0) - (a.cell.hp ?? 0))[0];
      if (!host) continue;
      options.targetInstanceId = host.cell.instance_id;
    }
    try {
      return await playCard(matchId, p, inst.instance_id, options);
    } catch {
      continue;
    }
  }

  // 3) Muovi verso il centro se possibile (semplice)
  for (const u of unitsOf(s, p)) {
    if (u.cell.tired) continue;
    const from = { row: u.row, col: u.col };
    for (const to of [
      { row: u.row - 1, col: u.col },
      { row: u.row, col: u.col - 1 },
      { row: u.row, col: u.col + 1 },
      { row: u.row + 1, col: u.col },
    ]) {
      if (to.row < 0 || to.row > 2 || to.col < 0 || to.col > 2) continue;
      if (s.board.rows[to.row][to.col]) continue;
      if (to.row === 0) continue; // non entrare in casa IA senza logica
      try {
        return await moveCreature(matchId, p, from, to);
      } catch {
        continue;
      }
    }
  }

  // 4) Fine turno → fa partire l’IA sul lato 0
  return endHumanTurn(matchId, p);
}

async function resolvePendingForP1(matchId: string, s: GameState): Promise<GameState> {
  if (s.pending_reaction?.responder_index === 1) {
    try {
      return await resolveTrapChoice(matchId, 1, {
        window_id: s.pending_reaction.window_id,
        action: 'pass',
      });
    } catch {
      /* ignore */
    }
  }
  if (s.pending_death_order?.chooser_index === 1) {
    const ids = s.pending_death_order.instance_ids ?? [];
    try {
      return await resolveDeathOrder(matchId, 1, {
        choice_id: s.pending_death_order.choice_id,
        instance_ids: ids,
      });
    } catch {
      /* ignore */
    }
  }
  if (s.pending_target_choice?.chooser_index === 1) {
    const eligible = s.pending_target_choice.eligible_instance_ids ?? [];
    const pick = eligible[0] ?? null;
    try {
      return await resolveTargetChoice(matchId, 1, {
        choice_id: s.pending_target_choice.choice_id,
        target_instance_id: pick,
      });
    } catch {
      /* ignore */
    }
  }
  return s;
}

function extractPlaysFromState(prev: GameState | null, next: GameState, bag: SimMatchResult['cards_played']) {
  // Approssimazione: confronta graveyard / board non è banale; usiamo log se disponibili.
  // Qui registriamo solo da pending events consumati — fallback: skip.
  void prev;
  void next;
  void bag;
}

async function runOneMatch(userId: string, maxTurns: number): Promise<SimMatchResult> {
  const t0 = Date.now();
  const colors = pickTwoColors();
  const { matchId, state: initial } = await createNewMatch(userId, colors.primary, colors.secondary, {
    // vita standard; niente storia
  });

  const result: SimMatchResult = {
    match_id: matchId,
    winner_index: null,
    status: initial.status,
    turns: initial.current_turn,
    steps: 0,
    duration_ms: 0,
    colors: {
      p0: initial.deck_colors[0],
      p1: initial.deck_colors[1],
    },
    end_life: [initial.players[0].life, initial.players[1].life],
    cards_played: [],
    truncated: false,
  };

  let state: GameState = initial;
  let guard = 0;
  const maxSteps = maxTurns * 40;

  try {
    while (state.status === 'running' && guard < maxSteps) {
      guard++;
      result.steps = guard;
      result.turns = state.current_turn;

      // Pending del “umano” (P1)
      const before = state;
      state = await resolvePendingForP1(matchId, state);
      if (state !== before) continue;

      if (state.status !== 'running') break;

      // Turno P1: una azione euristica (o end-turn)
      if (
        state.active_player_index === 1 &&
        state.phase === 'main' &&
        !state.pending_reaction &&
        !state.pending_death_order &&
        !state.pending_target_choice &&
        !state.pending_mostrissimo
      ) {
        state = await heuristicStepP1(matchId, state);
        continue;
      }

      // Turno IA (P0) già gestito da endHumanTurn → advance_ai.
      // Se siamo ancora su P0 in main, forza un refresh: potrebbe servire un altro drain.
      if (state.active_player_index === 0 && state.phase === 'main') {
        // L’IA dovrebbe avanzare da sola se c’è work_queue; altrimenti stallo.
        if (state.work_queue?.length) {
          // advance via end-turn non applicabile; get state after internal — force endHumanTurn is wrong
          // Rileggi: a volte il commit ha lasciato work in coda non drenata dal client path.
          state = await getMatchState(matchId);
          if (state.work_queue?.length) {
            // Non abbiamo export di drain pubblico: prova a “toccare” con get e break se bloccati
            result.error = 'stall_work_queue_p0';
            result.truncated = true;
            break;
          }
          continue;
        }
        // IA senza progress: anomalia
        result.error = 'stall_ai_p0';
        result.truncated = true;
        break;
      }

      // Fasi non-main: aspetta che il motore avanzi (di solito già drenato)
      state = await getMatchState(matchId);
      if (state.current_turn > maxTurns) {
        result.truncated = true;
        break;
      }
    }

    state = await getMatchState(matchId);
    result.status = state.status;
    result.winner_index = state.winner_index;
    result.turns = state.current_turn;
    result.end_life = [state.players[0].life, state.players[1].life];
    if (state.status === 'running') result.truncated = true;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    result.truncated = true;
    try {
      const st = await getMatchState(matchId);
      result.status = st.status;
      result.winner_index = st.winner_index;
      result.end_life = [st.players[0].life, st.players[1].life];
      result.turns = st.current_turn;
    } catch {
      /* ignore */
    }
  }

  result.duration_ms = Date.now() - t0;
  return result;
}

async function main() {
  const { n, maxTurns, out, seedUser } = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(out), { recursive: true });
  // Truncate file
  writeFileSync(out, '', 'utf8');

  console.error(`Sim IA vs IA: ${n} match, maxTurns=${maxTurns}`);
  console.error(`Output: ${out}`);
  console.error(`User id seed: ${seedUser}`);

  // createNewMatch vuole uno user UUID reale in Supabase auth — se fallisce, messaggio chiaro
  const summary = {
    n: 0,
    wins_p0: 0,
    wins_p1: 0,
    draws: 0,
    truncated: 0,
    errors: 0,
    avg_turns: 0,
    avg_ms: 0,
  };
  let turnsSum = 0;
  let msSum = 0;

  for (let i = 0; i < n; i++) {
    const userId = seedUser; // stesso profilo; le partite restano distinte per match id
    process.stderr.write(`\r[${i + 1}/${n}] ...`);
    const r = await runOneMatch(userId, maxTurns);
    appendFileSync(out, JSON.stringify(r) + '\n', 'utf8');
    summary.n++;
    if (r.error) summary.errors++;
    if (r.truncated) summary.truncated++;
    if (r.winner_index === 0) summary.wins_p0++;
    else if (r.winner_index === 1) summary.wins_p1++;
    else if (r.status === 'finished') summary.draws++;
    turnsSum += r.turns;
    msSum += r.duration_ms;
  }

  summary.avg_turns = summary.n ? Math.round((turnsSum / summary.n) * 10) / 10 : 0;
  summary.avg_ms = summary.n ? Math.round(msSum / summary.n) : 0;

  console.error(`\nFatto.`);
  console.error(JSON.stringify(summary, null, 2));
  console.error(`\nFile: ${out}`);
  console.error('Passa il JSONL a Grok per analisi carte / win rate / bilanciamento.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
