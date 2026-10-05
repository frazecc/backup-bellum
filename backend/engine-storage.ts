// backend/engine-storage.ts — persistenza e catalogo Supabase per lo stato v4.
import { createClient } from '@supabase/supabase-js';
import type { CardData, GameState, MatchLogEntry } from './types.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
export const db = createClient(url, key);

export async function load(id: string): Promise<GameState> {
  const { data, error } = await db.from('game_state').select('state_json,revision').eq('match_id', id).single();
  if (error || !data) throw new Error(`Stato partita non trovato: ${error?.message ?? id}`);
  const s = data.state_json as GameState;
  if (s.state_version !== 4 || !s.board?.rows || !Array.isArray(s.work_queue))
    throw new Error('Partita precedente non compatibile: avvia una nuova partita.');
  if (Number(data.revision) !== s.state_revision) throw new Error('Revisione dello stato non coerente');
  return s;
}

export async function commit(id: string, s: GameState, logs: MatchLogEntry[]): Promise<GameState> {
  // Numero deterministico per ciascun commit CAS e posizione all'interno del blocco.
  // I due campi restano in log_data, non modificano GameState né richiedono migrazioni.
  const orderedLogs = logs.map((entry, index) => ({
    ...entry, log_revision: s.state_revision + 1, log_order: index,
  }));
  const { data, error } = await db.rpc('commit_match_state', {
    p_match_id: id, p_expected_revision: s.state_revision, p_next_state: s, p_log_entries: orderedLogs,
  });
  if (error) throw new Error(`Salvataggio partita: ${error.message}`);
  if (s.status === 'finished') await recordDuration(id);
  return data as GameState;
}
// P4: la funzione SQL commit_match_state non scrive la durata. Si registra una sola volta,
// alla chiusura della partita (dalla creazione alla fine). Un errore qui non blocca la mossa.
async function recordDuration(id: string): Promise<void> {
  try {
    const { data } = await db.from('matches').select('created_at,duration_seconds').eq('id', id).single();
    if (!data || Number(data.duration_seconds) > 0) return;
    const seconds = Math.max(1, Math.round((Date.now() - new Date(String(data.created_at)).getTime()) / 1000));
    await db.from('matches').update({ duration_seconds: seconds }).eq('id', id).eq('duration_seconds', 0);
  } catch (error) { console.warn('Durata partita non registrata:', error); }
}

export async function saveGameState(id: string, s: GameState): Promise<GameState> { return commit(id, s, []); }
export async function logMatchAction(id: string, entry: MatchLogEntry): Promise<void> {
  const { error } = await db.from('match_logs').insert({ match_id: id, log_data: entry });
  if (error) throw new Error(`Log partita: ${error.message}`);
}
// Cache del catalogo (P1): il motore chiede la stessa carta decine di volte per azione.
// Le carte cambiano solo dall'editor, quindi una scadenza breve basta: una modifica compare
// entro CARD_CACHE_TTL_MS (default 60 s). Le richieste simultanee per la stessa carta
// condividono un'unica query; gli errori non vengono memorizzati.
const CARD_CACHE_TTL_MS = Number(process.env.CARD_CACHE_TTL_MS ?? 60_000);
const cardCache = new Map<string, { data: CardData; expires: number }>();
const cardLoading = new Map<string, Promise<CardData>>();
export async function getCardData(id: string): Promise<CardData> {
  const hit = cardCache.get(id);
  // Copia profonda: nessun chiamante può alterare la carta in cache.
  if (hit && hit.expires > Date.now()) return structuredClone(hit.data);
  let loading = cardLoading.get(id);
  if (!loading) {
    loading = fetchCardData(id)
      .then(data => { cardCache.set(id, { data, expires: Date.now() + CARD_CACHE_TTL_MS }); return data; })
      .finally(() => cardLoading.delete(id));
    cardLoading.set(id, loading);
  }
  return structuredClone(await loading);
}
async function fetchCardData(id: string): Promise<CardData> {
  const { data, error } = await db.from('cards').select('id,name,faction_id,card_type,mana_cost,sacrifice_cost,attack,hp,subtype,rarity,effect_text,effect_json,effect_on_death_json,flavor_text,image_url,keywords,factions!left(code)').eq('id', id).single();
  if (error || !data) throw new Error(`Carta non trovata: ${error?.message ?? id}`);
  const f = Array.isArray(data.factions) ? data.factions[0] : data.factions;
  return { ...data, faction_code: f && typeof f === 'object' && 'code' in f ? String(f.code) : 'IND' } as CardData;
}
