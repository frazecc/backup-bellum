// backend/api.ts — API HTTP Bellum Penumbrum, registro 3e ordinato e checkpoint pubblici.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  attack, createNewMatch, createPvpMatch, forfeitMatch, endHumanTurn, getCardData, getMatchState, moveCreature,
  playCard, resolveTrapChoice, resolveDeathOrder, resolveTargetChoice,
  startMostrissimoSummon, payMostrissimoSacrifice, completeMostrissimoSummon,
} from './engine.js';
import {
  lobbyJoin, lobbyLeave, lobbyHeartbeat, lobbyList, lobbyCreateChallenge,
  lobbyGetChallenge, lobbyChallengesFor, lobbyDeclineChallenge, lobbyAcceptChallenge,
  lobbySubmitColors, lobbyBothColorsReady, lobbyAttachMatch, lobbySetIdle,
} from './lobby.js';
import { advancePublicCheckpoint } from './engine-core.js';
import { engineErrors } from './card-rules.js';
import type {
  AttackTarget, CardInstance, DeathOrderChoice, DeckFaction, GameState, PlayerIndex, PlayCardOptions,
  Position, TargetChoice, TrapChoice,
} from './types.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseServiceKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
const supabase: SupabaseClient = createClient(supabaseUrl, supabaseServiceKey);
export const apiRouter = Router();
const deckFactions: readonly DeckFaction[] = ['CHI','INF','PES','BUL','GRO','CLO'];
function deckFactionValue(value: unknown, label: string): DeckFaction {
  if (typeof value !== 'string' || !deckFactions.includes(value as DeckFaction))
    throw new Error(`${label} non valido: scegli CHI, INF, PES, BUL, GRO oppure CLO`);
  return value as DeckFaction;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Errore sconosciuto'; }
function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} obbligatorio`);
  return value.trim();
}
function playerIndexValue(value: unknown, label: string): PlayerIndex {
  const index = Number(value);
  if (index !== 0 && index !== 1) throw new Error(`${label} non valido`);
  return index;
}
function positionValue(value: unknown, label: string): Position {
  const object = objectValue(value), row = Number(object.row), col = Number(object.col);
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 2 || col < 0 || col > 2)
    throw new Error(`${label} non valida`);
  return { row, col };
}
function attackTargetValue(value: unknown): AttackTarget {
  const object = objectValue(value);
  if (object.type === 'player') return { type: 'player', playerIndex: playerIndexValue(object.playerIndex, 'Giocatore bersaglio') };
  if (object.type === 'creature') return { type: 'creature', position: positionValue(object.position, 'Posizione bersaglio') };
  throw new Error('Bersaglio non valido');
}
function playOptionsValue(value: unknown): PlayCardOptions {
  const object = objectValue(value), options: PlayCardOptions = {};
  if (object.position !== undefined) options.position = positionValue(object.position, 'Posizione');
  if (object.targetInstanceId !== undefined) options.targetInstanceId = requiredString(object.targetInstanceId, 'ID istanza bersaglio');
  return options;
}
function trapChoiceValue(value: unknown): TrapChoice {
  const body = objectValue(value), window_id = requiredString(body.windowId, 'ID finestra reattiva');
  if (body.action === 'pass') return { window_id, action: 'pass' };
  if (body.action === 'play') return {
    window_id, action: 'play', card_instance_id: requiredString(body.cardInstanceId, 'ID istanza Trappola'),
    ...(body.targetInstanceId === undefined || body.targetInstanceId === null ? {}
      : { target_instance_id: requiredString(body.targetInstanceId, 'ID istanza bersaglio') }),
  };
  throw new Error('Scelta reattiva non valida');
}
function deathOrderChoiceValue(value: unknown): DeathOrderChoice {
  const body = objectValue(value);
  if (!Array.isArray(body.instanceIds) || body.instanceIds.length < 2 || body.instanceIds.length > 9
    || body.instanceIds.some(id => typeof id !== 'string' || id.trim() === ''))
    throw new Error('Ordine delle creature non valido');
  return { choice_id: requiredString(body.choiceId, 'ID scelta ordine'),
    instance_ids: body.instanceIds.map(id => requiredString(id, 'ID creatura')) };
}
function targetChoiceValue(value: unknown): TargetChoice {
  const body = objectValue(value);
  return { choice_id: requiredString(body.choiceId, 'ID scelta bersaglio'),
    target_instance_id: requiredString(body.targetInstanceId, 'ID istanza bersaglio') };
}
// --- Limiti di richieste (S6) ---------------------------------------------
// In memoria, per utente: 300 richieste al minuto in generale (una partita normale ne usa
// meno di 200) e al massimo 10 nuove partite ogni 10 minuti.
class RateLimitError extends Error {}
const rateHits = new Map<string, number[]>();
function rateLimit(key: string, max: number, windowMs: number): void {
  const now = Date.now(), recent = (rateHits.get(key) ?? []).filter(t => now - t < windowMs);
  if (recent.length >= max) { rateHits.set(key, recent); throw new RateLimitError('Troppe richieste: aspetta qualche secondo e riprova'); }
  recent.push(now); rateHits.set(key, recent);
}
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of rateHits) if (!times.length || now - times[times.length - 1] > 15 * 60_000) rateHits.delete(key);
}, 60_000).unref();
class SessionReplacedError extends Error {
  constructor() {
    super('Sessione sostituita: hai effettuato l’accesso da un altro dispositivo');
    this.name = 'SessionReplacedError';
  }
}

/**
 * Autenticazione JWT. Di default controlla anche il device attivo.
 * claim-device DEVE usare skipDeviceCheck: altrimenti un nuovo device non può mai reclamare la sessione.
 */
async function requireAuth(req: Request, opts?: { skipDeviceCheck?: boolean }): Promise<string> {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) throw new Error('Sessione assente: autenticati di nuovo');
  const { data, error } = await supabase.auth.getUser(header.slice('Bearer '.length).trim());
  if (error || !data.user) throw new Error('Sessione Supabase non valida');
  rateLimit(`user:${data.user.id}`, 300, 60_000);
  if (!opts?.skipDeviceCheck) {
    const deviceId = req.header('x-device-id')?.trim();
    if (deviceId) {
      const { data: profile } = await supabase
        .from('player_profiles')
        .select('active_device_id')
        .eq('user_id', data.user.id)
        .maybeSingle();
      if (profile?.active_device_id && profile.active_device_id !== deviceId) {
        throw new SessionReplacedError();
      }
    }
  }
  return data.user.id;
}

async function upsertProfile(userId: string, patch: Record<string, unknown>) {
  const { error } = await supabase.from('player_profiles').upsert(
    { user_id: userId, updated_at: new Date().toISOString(), ...patch },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(`Profilo: ${error.message}`);
}
// Il proprietario di una partita non cambia mai: una volta letto lo ricordiamo
// (solo risultati positivi, con tetto di dimensione) e risparmiamo una query a richiesta.
/** matchId → set di user_id autorizzati (1 in PvE, 2 in PvP). */
const matchOwners = new Map<string, Set<string>>();
async function assertMatchOwner(matchId: string, userId: string): Promise<void> {
  let owners = matchOwners.get(matchId);
  if (!owners) {
    const state = await getMatchState(matchId).catch(() => null);
    if (state?.players) {
      owners = new Set(
        state.players.map(p => p.user_id).filter((id): id is string => !!id),
      );
    } else {
      const { data, error } = await supabase.from('matches').select('id, player_id, opponent_name, opponent_type').eq('id', matchId).single();
      if (error || !data) throw new Error('Partita non trovata');
      owners = new Set([String(data.player_id)]);
      if (data.opponent_type === 'pvp' && data.opponent_name) owners.add(String(data.opponent_name));
    }
    if (matchOwners.size >= 1000) matchOwners.delete(matchOwners.keys().next().value as string);
    matchOwners.set(matchId, owners);
  }
  if (!owners.has(userId)) throw new Error('Questa partita appartiene a un altro giocatore');
}
async function ownedMatch(req: Request): Promise<{ matchId: string; userId: string }> {
  const userId = await requireAuth(req), matchId = requiredString(req.params.id, 'ID partita');
  await assertMatchOwner(matchId, userId);
  return { matchId, userId };
}
function playerIndexInMatch(state: GameState, userId: string): 0 | 1 {
  if (state.players[1]?.user_id === userId) return 1;
  if (state.players[0]?.user_id === userId) return 0;
  throw new Error('Non sei un giocatore di questa partita');
}

async function withMatch(req: Request, res: Response): Promise<{ matchId: string; userId: string; pIdx: 0 | 1 }> {
  const { matchId, userId } = await ownedMatch(req);
  (res as Response & { locals: Record<string, string> }).locals = {
    ...((res as Response & { locals?: Record<string, string> }).locals || {}),
    viewerUserId: userId,
  };
  const st = await getMatchState(matchId);
  const pIdx = playerIndexInMatch(st, userId);
  return { matchId, userId, pIdx };
}

function respondError(res: Response, error: unknown) {
  const status = error instanceof RateLimitError ? 429
    : error instanceof SessionReplacedError ? 401
    : 400;
  res.status(status).json({ error: errorMessage(error), code: error instanceof SessionReplacedError ? 'session_replaced' : undefined });
}

// --- Stato pubblico (S2) ---------------------------------------------------
// Il motore lavora sempre con lo stato completo; al browser va solo ciò che il
// giocatore può sapere. Le liste nascoste restano della stessa lunghezza, così
// il client continua a mostrare i conteggi (mazzo, mano coperta dell'IA).
function hiddenCards(list: unknown, prefix: string): CardInstance[] {
  const length = Array.isArray(list) ? list.length : 0;
  return Array.from({ length }, (_, i) => ({ instance_id: `${prefix}-${i}`, card_id: '' }));
}
function publicState(state: GameState, viewerUserId?: string): GameState {
  const copy = structuredClone(state);
  const isPvp = (state as GameState & { match_mode?: string }).match_mode === 'pvp';
  if (isPvp && viewerUserId) {
    for (const idx of [0, 1] as const) {
      const pl = copy.players[idx];
      const isMe = pl.user_id === viewerUserId;
      if (!isMe) {
        pl.hand = hiddenCards(pl.hand, `p${idx}-hand`);
      }
      pl.deck = hiddenCards(pl.deck, `p${idx}-deck`);
      pl.extra_deck = hiddenCards(pl.extra_deck, `p${idx}-extra`);
    }
  } else {
    const [ai, human] = copy.players;
    ai.hand = hiddenCards(ai.hand, 'ai-hand');
    ai.deck = hiddenCards(ai.deck, 'ai-deck');
    ai.extra_deck = hiddenCards(ai.extra_deck, 'ai-extra');
    human.deck = hiddenCards(human.deck, 'human-deck');
    human.extra_deck = hiddenCards(human.extra_deck, 'human-extra');
    if (copy.pending_reaction && copy.pending_reaction.responder_index === 0)
      copy.pending_reaction = { ...copy.pending_reaction, eligible_instance_ids: [] };
  }
  copy.remaining_mostrissimi = copy.remaining_mostrissimi.map(() => '');
  return copy;
}
// Ogni risposta con { state } passa da qui: nessuna rotta può dimenticare il filtro.
apiRouter.use((req: Request, res: Response, next: NextFunction) => {
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (body && typeof body === 'object' && 'state' in body) {
      const viewer = (res as Response & { locals: { viewerUserId?: string } }).locals?.viewerUserId
        ?? (req as Request & { viewerUserId?: string }).viewerUserId;
      return json({
        ...(body as Record<string, unknown>),
        state: publicState((body as { state: GameState }).state, viewer),
      });
    }
    return json(body);
  };
  next();
});
apiRouter.get('/health', (_req: Request, res: Response) => res.status(200).json({ status: 'ok', service: 'bellum-penumbrum-api' }));

/** Profilo giocatore: progressi Storia + ultima partita + device attivo (cross-device). */
apiRouter.get('/me/profile', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const { data, error } = await supabase
      .from('player_profiles')
      .select('story_progress, last_match_id, active_device_id, active_device_label, session_claimed_at, updated_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(`Lettura profilo: ${error.message}`);
    res.json({
      story_progress: data?.story_progress ?? null,
      last_match_id: data?.last_match_id ?? null,
      active_device_label: data?.active_device_label ?? null,
      session_claimed_at: data?.session_claimed_at ?? null,
      updated_at: data?.updated_at ?? null,
    });
  } catch (error) { respondError(res, error); }
});

/**
 * Claim device: questo login diventa l’unico autorizzato.
 * Tag salvati: device id, etichetta leggibile, orario (l’orario più recente vince sempre).
 */
apiRouter.post('/me/claim-device', async (req: Request, res: Response) => {
  try {
    // skipDeviceCheck: il nuovo device deve poter sovrascrivere quello precedente
    const userId = await requireAuth(req, { skipDeviceCheck: true });
    const body = objectValue(req.body);
    const deviceId = requiredString(body.deviceId, 'ID dispositivo');
    if (deviceId.length < 8 || deviceId.length > 128) throw new Error('ID dispositivo non valido');
    const rawLabel = typeof body.deviceLabel === 'string' ? body.deviceLabel.trim() : '';
    const deviceLabel = (rawLabel || 'Dispositivo').slice(0, 80);
    const claimedAt = new Date().toISOString();
    await upsertProfile(userId, {
      active_device_id: deviceId,
      active_device_label: deviceLabel,
      session_claimed_at: claimedAt,
    });
    res.json({ ok: true, device_id: deviceId, device_label: deviceLabel, claimed_at: claimedAt });
  } catch (error) { respondError(res, error); }
});

/** Salva progressi Storia (e/o last_match_id). Chiamare a ogni azione rilevante. */
apiRouter.put('/me/profile', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const body = objectValue(req.body);
    const patch: Record<string, unknown> = {};
    if ('story_progress' in body) patch.story_progress = body.story_progress ?? null;
    if ('last_match_id' in body) {
      const v = body.last_match_id;
      patch.last_match_id = v === null || v === '' ? null : requiredString(v, 'ID partita');
    }
    if (!Object.keys(patch).length) throw new Error('Nessun campo da aggiornare');
    await upsertProfile(userId, patch);
    res.json({ ok: true });
  } catch (error) { respondError(res, error); }
});

apiRouter.post('/match/create', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req), body = objectValue(req.body);
    rateLimit(`create:${userId}`, 10, 10 * 60_000);
    const primary = deckFactionValue(body.primaryColor, 'Colore principale');
    const secondary = deckFactionValue(body.secondaryColor, 'Colore secondario');
    if (primary === secondary) throw new Error('Scegli due colori diversi');

    // Opzioni Storia / Endless (opzionali)
    let createOpts: {
      aiStartingLife?: number;
      humanMedallion?: DeckFaction | null;
      aiMedallion?: DeckFaction | null;
      tertiaryColor?: DeckFaction | null;
      aiPrimary?: DeckFaction | 'IND' | null;
      aiDisplayName?: string | null;
      firstPlayer?: 0 | 1 | null;
      aiLifeCutTurn?: number | null;
      aiLifeAfterCut?: number | null;
    } = {};
    // tertiaryColor anche a livello root (scena anima)
    if (body.tertiaryColor != null && body.tertiaryColor !== '') {
      createOpts.tertiaryColor = deckFactionValue(body.tertiaryColor, 'Colore terziario');
    }
    if (body.firstPlayer === 0 || body.firstPlayer === 1) {
      createOpts.firstPlayer = body.firstPlayer as 0 | 1;
    }
    const story = body.story;
    if (story && typeof story === 'object' && !Array.isArray(story)) {
      const st = story as Record<string, unknown>;
      if (st.aiStartingLife != null) {
        const life = Number(st.aiStartingLife);
        if (!Number.isFinite(life) || life < 1 || life > 200) throw new Error('Vita boss non valida');
        createOpts.aiStartingLife = Math.floor(life);
      }
      if (st.humanMedallion != null && st.humanMedallion !== '') {
        createOpts.humanMedallion = deckFactionValue(st.humanMedallion, 'Medaglione');
      } else if (st.humanMedallion === null) {
        createOpts.humanMedallion = null;
      }
      if (st.aiMedallion != null && st.aiMedallion !== '') {
        createOpts.aiMedallion = deckFactionValue(st.aiMedallion, 'Medaglione boss');
      } else if (st.aiMedallion === null) {
        createOpts.aiMedallion = null;
      }
      if (st.tertiaryColor != null && st.tertiaryColor !== '') {
        createOpts.tertiaryColor = deckFactionValue(st.tertiaryColor, 'Colore terziario');
      }
      if (typeof st.aiPrimary === 'string' && st.aiPrimary.length > 0) {
        if (st.aiPrimary === 'IND') {
          createOpts.aiPrimary = 'IND';
        } else {
          createOpts.aiPrimary = deckFactionValue(st.aiPrimary, 'Boss IA');
        }
      }
      if (typeof st.aiDisplayName === 'string' && st.aiDisplayName.trim()) {
        createOpts.aiDisplayName = st.aiDisplayName.trim().slice(0, 80);
      }
      if (st.firstPlayer === 0 || st.firstPlayer === 1) {
        createOpts.firstPlayer = st.firstPlayer as 0 | 1;
      }
      if (st.aiLifeCutTurn != null) {
        const t = Number(st.aiLifeCutTurn);
        if (Number.isFinite(t) && t >= 1 && t <= 50) createOpts.aiLifeCutTurn = Math.floor(t);
      }
      if (st.aiLifeAfterCut != null) {
        const life = Number(st.aiLifeAfterCut);
        if (Number.isFinite(life) && life >= 1 && life <= 200) createOpts.aiLifeAfterCut = Math.floor(life);
      }
    }

    const { matchId, state } = await createNewMatch(userId, primary, secondary, createOpts);
    // Ultima partita attiva sul profilo → recuperabile da qualsiasi device
    try { await upsertProfile(userId, { last_match_id: matchId }); } catch (e) { console.warn(e); }
    res.status(201).json({ match_id: matchId, state });
  } catch (error) { respondError(res, error); }
});
apiRouter.get('/match/:id', async (req: Request, res: Response) => {
  try {
    const { matchId, userId } = await ownedMatch(req);
    (res as Response & { locals: Record<string, string> }).locals = { ...(res as Response & { locals?: Record<string, string> }).locals, viewerUserId: userId };
    res.json({ state: await getMatchState(matchId) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/play-card', async (req: Request, res: Response) => {
  try {
    const { matchId, userId } = await ownedMatch(req);
    (res as Response & { locals: Record<string, string> }).locals = { ...(res as Response & { locals?: Record<string, string> }).locals, viewerUserId: userId };
    const body = objectValue(req.body);
    const st = await getMatchState(matchId);
    const pIdx = playerIndexInMatch(st, userId);
    res.json({ state: await playCard(matchId, pIdx, requiredString(body.cardInstanceId, 'ID istanza carta'), playOptionsValue(body.options)) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/mostrissimo/start', async (req: Request, res: Response) => {
  try {
    const { matchId, pIdx } = await withMatch(req, res);
    res.json({ state: await startMostrissimoSummon(matchId, pIdx, requiredString(objectValue(req.body).cardId, 'ID Mostrissimo')) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/mostrissimo/sacrifice', async (req: Request, res: Response) => {
  try {
    const { matchId, pIdx } = await withMatch(req, res);
    res.json({ state: await payMostrissimoSacrifice(matchId, pIdx, requiredString(objectValue(req.body).instanceId, 'ID permanente')) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/mostrissimo/complete', async (req: Request, res: Response) => {
  try {
    const { matchId, pIdx } = await withMatch(req, res);
    const body = objectValue(req.body);
    const position = positionValue(body.position, 'Cella di evocazione');
    const targetId = body.targetInstanceId === undefined || body.targetInstanceId === null
      ? null : requiredString(body.targetInstanceId, 'Bersaglio');
    res.json({ state: await completeMostrissimoSummon(matchId, pIdx, position, targetId) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/move', async (req: Request, res: Response) => {
  try {
    const { matchId, pIdx } = await withMatch(req, res);
    const body = objectValue(req.body);
    res.json({ state: await moveCreature(matchId, pIdx, positionValue(body.from, 'Posizione di origine'), positionValue(body.to, 'Posizione di destinazione')) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/attack', async (req: Request, res: Response) => {
  try {
    const { matchId, pIdx } = await withMatch(req, res);
    const body = objectValue(req.body);
    res.json({ state: await attack(matchId, pIdx, positionValue(body.attackerPosition, 'Posizione attaccante'), attackTargetValue(body.target)) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/end-turn', async (req: Request, res: Response) => {
  try {
    const { matchId, userId } = await ownedMatch(req);
    (res as Response & { locals: Record<string, string> }).locals = { ...(res as Response & { locals?: Record<string, string> }).locals, viewerUserId: userId };
    const st = await getMatchState(matchId);
    const pIdx = playerIndexInMatch(st, userId);
    res.json({ state: await endHumanTurn(matchId, pIdx) });
  } catch (error) { respondError(res, error); }
});
// L'ID proviene dall'ultimo checkpoint persistito. Retry e chiamate da due schede
// non applicano due volte lo stesso task: il motore usa la revisione CAS.
apiRouter.post('/match/:id/advance', async (req: Request, res: Response) => {
  try {
    const { matchId } = await withMatch(req, res);
    const expectedId = requiredString(objectValue(req.body).expectedAnnouncementId, 'ID checkpoint atteso');
    res.json({ state: await advancePublicCheckpoint(matchId, expectedId) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/trap/choice', async (req: Request, res: Response) => {
  try {
    const { matchId, pIdx } = await withMatch(req, res);
    res.json({ state: await resolveTrapChoice(matchId, pIdx, trapChoiceValue(req.body)) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/death/order', async (req: Request, res: Response) => {
  try {
    const { matchId, pIdx } = await withMatch(req, res);
    res.json({ state: await resolveDeathOrder(matchId, pIdx, deathOrderChoiceValue(req.body)) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/death/target', async (req: Request, res: Response) => {
  try {
    const { matchId, pIdx } = await withMatch(req, res);
    res.json({ state: await resolveTargetChoice(matchId, pIdx, targetChoiceValue(req.body)) });
  } catch (error) { respondError(res, error); }
});
apiRouter.post('/match/:id/forfeit', async (req: Request, res: Response) => {
  try {
    const { matchId, pIdx } = await withMatch(req, res);
    res.json({ state: await forfeitMatch(matchId, pIdx) });
  } catch (error) { respondError(res, error); }
});
// Le voci nuove sono ordinate per revisione CAS e posizione nel commit.
// Le vecchie voci prive di progressivo mantengono l'ordine storico restituito dal DB.
apiRouter.get('/match/:id/logs', async (req: Request, res: Response) => {
  try {
    const { matchId } = await withMatch(req, res);
    const requested = Number(req.query.limit ?? 100);
    const limit = Number.isInteger(requested) ? Math.max(1, Math.min(requested, 1000)) : 100;
    const { data, error } = await supabase.from('match_logs')
      .select('id, match_id, log_data, created_at').eq('match_id', matchId)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
    if (error) throw new Error(`Impossibile caricare il log: ${error.message}`);
    const ordered = (data ?? []).reverse();
    ordered.sort((a, b) => {
      const ar = Number(a.log_data?.log_revision), br = Number(b.log_data?.log_revision);
      const ai = Number(a.log_data?.log_order), bi = Number(b.log_data?.log_order);
      if (Number.isInteger(ar) && Number.isInteger(br) && ar !== br) return ar - br;
      if (ar === br && Number.isInteger(ar) && Number.isInteger(ai) && Number.isInteger(bi)) return ai - bi;
      return 0;
    });
    res.json({ logs: ordered });
  } catch (error) { respondError(res, error); }
});
// Controllo di validità usato dall'editor prima di salvare: stesse regole dei mazzi.
apiRouter.post('/cards/validate', async (req: Request, res: Response) => {
  try { await requireAuth(req); res.json({ errors: engineErrors(objectValue(req.body).card) }); }
  catch (error) { respondError(res, error); }
});
apiRouter.get('/cards/:id', async (req: Request, res: Response) => {
  try { await requireAuth(req);
    res.json({ card: await getCardData(requiredString(req.params.id, 'ID carta')) });
  } catch (error) { respondError(res, error); }
});


// ========== LOBBY PvP — Camera del Re Lobbi II ==========
function usernameFromAuth(req: Request, userId: string): string {
  // Preferisci body/query, fallback id corto
  const body = objectValue(req.body);
  if (typeof body.username === 'string' && body.username.trim()) return body.username.trim().slice(0, 32);
  return userId.slice(0, 8);
}

apiRouter.post('/lobby/join', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const username = usernameFromAuth(req, userId);
    const me = lobbyJoin(userId, username);
    res.json({ me, players: lobbyList(userId) });
  } catch (error) { respondError(res, error); }
});

apiRouter.post('/lobby/heartbeat', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const username = usernameFromAuth(req, userId);
    let me = lobbyHeartbeat(userId, username);
    if (!me) me = lobbyJoin(userId, username);
    const challenges = lobbyChallengesFor(userId).filter(c =>
      c.status === 'pending' || c.status === 'accepted'
    );
    res.json({
      me,
      players: lobbyList(userId),
      challenges,
    });
  } catch (error) { respondError(res, error); }
});

apiRouter.post('/lobby/leave', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    lobbyLeave(userId);
    res.json({ ok: true });
  } catch (error) { respondError(res, error); }
});

apiRouter.get('/lobby/players', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    res.json({ players: lobbyList(userId) });
  } catch (error) { respondError(res, error); }
});

apiRouter.post('/lobby/challenge', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const body = objectValue(req.body);
    const toUserId = requiredString(body.toUserId, 'Avversario');
    const username = usernameFromAuth(req, userId);
    const challenge = lobbyCreateChallenge(userId, username, toUserId);
    res.status(201).json({ challenge });
  } catch (error) { respondError(res, error); }
});

apiRouter.post('/lobby/challenge/:id/decline', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const id = requiredString(req.params.id, 'ID sfida');
    const challenge = lobbyDeclineChallenge(id, userId);
    res.json({ challenge });
  } catch (error) { respondError(res, error); }
});

apiRouter.post('/lobby/challenge/:id/accept', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const id = requiredString(req.params.id, 'ID sfida');
    const challenge = lobbyAcceptChallenge(id, userId);
    res.json({ challenge });
  } catch (error) { respondError(res, error); }
});

/** Invia i colori dopo accettazione. Quando entrambi sono pronti, crea il match PvP. */
apiRouter.post('/lobby/challenge/:id/colors', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    const id = requiredString(req.params.id, 'ID sfida');
    const body = objectValue(req.body);
    const primary = deckFactionValue(body.primaryColor, 'Colore principale');
    const secondary = deckFactionValue(body.secondaryColor, 'Colore secondario');
    if (primary === secondary) throw new Error('Scegli due colori diversi');
    let tertiary: string | undefined;
    if (body.tertiaryColor) tertiary = deckFactionValue(body.tertiaryColor, 'Colore terziario');
    else {
      const rest = deckFactions.filter(f => f !== primary && f !== secondary);
      tertiary = rest[Math.floor(Math.random() * rest.length)];
    }
    if (tertiary === primary || tertiary === secondary) throw new Error('Terziario non valido');

    let challenge = lobbySubmitColors(id, userId, primary, secondary, tertiary);
    if (!lobbyBothColorsReady(challenge)) {
      res.json({ challenge, match_id: null, waiting: true });
      return;
    }

    // Entrambi pronti → moneta + createPvpMatch
    const c1 = challenge.colors![challenge.fromUserId];
    const c2 = challenge.colors![challenge.toUserId];
    const firstPlayer = Math.random() < 0.5 ? 1 : 0;
    const p1Colors = {
      primary: c1.primary as 'CHI',
      secondary: c1.secondary as 'CHI',
      tertiary: (c1.tertiary || tertiary) as 'CHI',
    };
    const p2Colors = {
      primary: c2.primary as 'CHI',
      secondary: c2.secondary as 'CHI',
      tertiary: (c2.tertiary || tertiary) as 'CHI',
    };
    // Fix types properly via deckFactionValue
    const mk = (c: { primary: string; secondary: string; tertiary?: string }) => ({
      primary: deckFactionValue(c.primary, 'P'),
      secondary: deckFactionValue(c.secondary, 'S'),
      tertiary: deckFactionValue(c.tertiary || tertiary!, 'T'),
    });
    const { matchId, state } = await createPvpMatch(
      challenge.fromUserId,
      challenge.toUserId,
      mk(c1),
      mk(c2),
      firstPlayer as 0 | 1,
    );
    lobbyAttachMatch(id, matchId);
    matchOwners.set(matchId, new Set([challenge.fromUserId, challenge.toUserId]));
    challenge = lobbyGetChallenge(id) || challenge;
    (res as Response & { locals: Record<string, string> }).locals = { viewerUserId: userId };
    res.status(201).json({ challenge, match_id: matchId, state, waiting: false });
  } catch (error) { respondError(res, error); }
});

apiRouter.get('/lobby/challenges', async (req: Request, res: Response) => {
  try {
    const userId = await requireAuth(req);
    res.json({ challenges: lobbyChallengesFor(userId) });
  } catch (error) { respondError(res, error); }
});
