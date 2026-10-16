# Simulatore IA vs IA (MVP)

## Cosa fa
- Crea N partite sul motore reale (`createNewMatch`)
- **Giocatore 0** = IA già presente nel motore
- **Giocatore 1** = euristica semplice (attacca → gioca carte → muove → fine turno)
- Scrive **una riga JSON per match** (JSONL)

## Setup
1. Copia `sim-ai-vs-ai.ts` in `backend/tools/sim-ai-vs-ai.ts`
2. Backend con `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`)
3. Serve uno **user_id UUID reale** nella tabella auth/profili (vincolo `matches.player_id`)

```bash
cd backend
npx tsx tools/sim-ai-vs-ai.ts --n 30 --max-turns 50 --out ../sims/run.jsonl --user TUO_USER_UUID
```

UUID: da Supabase → Authentication → Users, oppure dal profilo con cui giochi.

## Output (ogni riga)
```json
{
  "match_id": "...",
  "winner_index": 0,
  "turns": 18,
  "colors": { "p0": {...}, "p1": {...} },
  "end_life": [0, 7],
  "truncated": false,
  "error": null
}
```

## Limiti MVP (prossimi passi)
| Limite | Evoluzione |
|--------|------------|
| P1 è euristica grezza, non la stessa IA di P0 | Generalizzare `advanceAi(playerIndex)` |
| `cards_played` quasi vuoto | Leggere `match_logs` e aggregare per `card_id` |
| Scrive su DB (match veri) | Modalità in-memory senza insert |
| Trappole P1 = sempre pass | Policy trappole / NOPE |

## Analisi dopo il run
Passa il file `.jsonl` a Grok chiedendo ad es.:
- win rate per trio colori
- durata media
- tasso di partite troncate / errori
- (con log arricchiti) carte con più win rate delta

## Roadmap consigliata
1. **Ora** — far girare 20–50 match, verificare che finiscano
2. **Poi** — estrarre `match_logs` → conteggi per carta
3. **Poi** — stessa policy IA su entrambi i lati
4. **Poi** — report automatico `aggregate-sims.ts`
