# Fase 2 – Aggiornamento del Motore (Trigger e Finestre di Reazione)

**Stato:** Specifiche pronte per implementazione  
**Data:** 15 ottobre 2026  
**Dipende da:** `effect-types.ts` + `effect-library.ts` (Fase 1)

Questo documento descrive **esattamente** le modifiche da apportare al motore attuale (`engine-core.ts`, `types.ts`, `engine-board.ts`, `card-rules.ts`) per supportare il nuovo sistema di trigger.

---

## 1. Obiettivi di questa fase

1. Introdurre i nuovi eventi di reazione:
   - `card_played_from_hand` (dopo pagamento mana, **prima** che la carta si attivi)
   - `card_enters_field` / `creature_enters_field` (dopo ingresso fisico)
2. Separare chiaramente le due finestre per i Mostri.
3. Far funzionare i Mostrissimi solo con la finestra di ingresso (non partono dalla mano).
4. Rendere NOPE compatibile con **tutti** gli eventi che aprono finestra di reazione.
5. Applicare la regola NOPE: entrambe le carte al cimitero, mana **non** rimborsato.
6. Aggiornare il messaggio dell’anti-loop.

---

## 2. Modifiche a `types.ts`

### 2.1 Nuovi valori di `ReactionTriggerEvent`

Sostituire / estendere:

```ts
export type ReactionTriggerEvent =
  | 'opponent_upkeep_start'
  | 'opponent_upkeep_end'
  | 'card_played_from_hand'          // NEW (sostituisce opponent_hand_card)
  | 'mostrissimo_before_entry'
  | 'card_enters_field'              // NEW (generico)
  | 'creature_enters_field'          // NEW
  | 'own_creature_enters_field'      // NEW
  | 'opponent_creature_enters_field' // NEW
  // Mantieni temporaneamente i vecchi per migrazione:
  | 'opponent_hand_card'             // DEPRECATED → mappa a card_played_from_hand
  | 'monster_etb';                   // DEPRECATED → mappa a creature_enters_field / card_enters_field
```

### 2.2 Aggiornare `PendingEvent`

Aggiungere (o rinominare) eventi se necessario. Il kind `hand_card` resta, ma ora la finestra di reazione usa il nuovo trigger.

Il kind `monster_etb` può restare internamente, ma viene mappato al nuovo trigger `creature_enters_field` / `card_enters_field`.

---

## 3. Modifiche al flusso di dichiarazione / applicazione

### 3.1 Quando il giocatore gioca una carta dalla mano

**Flusso attuale (semplificato):**
1. Paga mana → sposta carta in “pending”
2. `declare_event` con kind `hand_card`
3. Finestra di reazione (solo se Trappola con `opponent_hand_card`)
4. `apply_event` → la carta si attiva / entra in campo

**Nuovo flusso:**

1. Il giocatore dichiara la carta e **paga il mana**.
2. La carta viene temporaneamente messa da parte (come ora).
3. Si fa `declare_event` con kind `hand_card`.
4. Si apre la finestra di reazione con trigger **`card_played_from_hand`**.
5. **Se qualcuno gioca un NOPE valido:**
   - La carta giocata va al cimitero
   - Il NOPE va al cimitero
   - Il mana **non** viene rimborsato
   - L’evento termina (non si fa `apply_event`)
6. **Se nessuno annulla:**
   - Si esegue `apply_event`
   - La carta si attiva / entra fisicamente in campo
7. **Se la carta è un Mostro (creatura):**
   - Dopo l’ingresso fisico si accoda un nuovo `declare_event` di tipo ingresso (`monster_etb` o nuovo kind)
   - Si apre la **seconda** finestra di reazione con trigger `creature_enters_field` / `card_enters_field`

### 3.2 Ingresso Mostrissimo

I Mostrissimi **non** passano da `hand_card`.

Flusso:
1. Completamento sacrifici
2. Finestra `mostrissimo_before_entry` (se ancora usata)
3. Ingresso fisico
4. Finestra `creature_enters_field` / `card_enters_field`

### 3.3 Mapping vecchio → nuovo (per compatibilità durante la migrazione)

| Vecchio trigger              | Nuovo trigger equivalente              |
|-----------------------------|----------------------------------------|
| `opponent_hand_card`        | `card_played_from_hand`                |
| `monster_etb`               | `creature_enters_field` o `card_enters_field` |
| `mostrissimo_before_entry`  | resta invariato (o mappato a un generico “prima dell’ingresso”) |

---

## 4. Aggiornamento di `eventTrigger` e `noPeAllowed`

### 4.1 `eventTrigger` (in engine-core.ts)

```ts
function eventTrigger(e: PendingEvent): ReactionTriggerEvent | null {
  if (e.kind === 'upkeep_start') return 'opponent_upkeep_start';
  if (e.kind === 'upkeep_end') return 'opponent_upkeep_end';
  if (e.kind === 'hand_card') return 'card_played_from_hand';          // CAMBIATO
  if (e.kind === 'mostrissimo_before_entry') return 'mostrissimo_before_entry';
  if (e.kind === 'monster_etb') return 'creature_enters_field';         // CAMBIATO (o card_enters_field)
  return null;
}
```

### 4.2 `noPeAllowed`

NOPE deve essere compatibile con **tutti** gli eventi che aprono finestra.

```ts
async function noPeAllowed(d: CardData, e: PendingEvent): Promise<boolean> {
  const tr = reactionTrigger(d);
  if (!tr) return false;

  // Compatibilità temporanea con i vecchi nomi
  if (tr === 'opponent_hand_card') return e.kind === 'hand_card';
  if (tr === 'monster_etb') return e.kind === 'monster_etb';

  // Nuovi trigger
  if (tr === 'card_played_from_hand') return e.kind === 'hand_card';
  if (tr === 'creature_enters_field' || tr === 'card_enters_field' ||
      tr === 'own_creature_enters_field' || tr === 'opponent_creature_enters_field') {
    return e.kind === 'monster_etb';
  }
  if (tr === 'mostrissimo_before_entry') return e.kind === 'mostrissimo_before_entry';
  if (tr === 'opponent_upkeep_start') return e.kind === 'upkeep_start';
  if (tr === 'opponent_upkeep_end') return e.kind === 'upkeep_end';

  return false;
}
```

**Importante:** rimuovere la restrizione attuale che limitava `opponent_hand_card` alle sole Maledizioni.

---

## 5. Comportamento di NOPE (regola definitiva)

Quando una Trappola con effetto `counter` / `nope` viene giocata con successo:

1. La carta che aveva generato l’evento (quella “annullata”) va al cimitero del proprietario.
2. La Trappola NOPE va al cimitero del giocatore che l’ha giocata.
3. Il mana speso per la carta annullata **non** viene rimborsato.
4. Il mana speso per il NOPE viene scalato normalmente.
5. Non si esegue `apply_event` sull’evento originale.
6. Eventuali effetti non-counter della Trappola si risolvono comunque (se presenti).

Per i Mostrissimi: se viene NOPPATO in `mostrissimo_before_entry`, i sacrifici restano pagati (come già avviene).

---

## 6. Anti-loop – messaggio speciale

Nella funzione `cleanupLoop` (o equivalente):

```ts
function cleanupLoop(c: Context) {
  // ... svuota la plancia come già fa ...

  // Nuovo annuncio pubblico
  // (usa il sistema di public_announcement già esistente)
  const announcement = {
    id: randomUUID(),
    kind: 'result' as const,
    actor: null,
    text: 'Le bestie divine sono soddisfatte di ciò che hanno visto. Complimenti.',
    turn: c.s.current_turn,
    phase: c.s.phase,
    duration_ms: 3000, // un po’ più lungo per leggibilità
  };
  c.s.public_announcement = announcement;
  // eventualmente push in public_announcements

  log(c, -1, 'anti_loop_cleanup', 'La Penombra divora ogni cosa: venti trigger consecutivi, plancia svuotata. Le bestie divine sono soddisfatte di ciò che hanno visto. Complimenti.');
}
```

La partita continua normalmente con la griglia vuota.

---

## 7. Modifiche minori a `engine-board.ts`

- Aggiornare `reactionTrigger` se necessario per leggere anche i nuovi formati.
- `supported` Set: aggiungere eventuali nuovi tipi se non già presenti (ma per ora restano gli stessi effetti).
- `targeted`: mantenere la logica attuale fino alla Fase 3 (bersagli più ricchi).

---

## 8. Ordine di implementazione consigliato (dentro la Fase 2)

1. Aggiornare i tipi in `types.ts` (nuovi `ReactionTriggerEvent`).
2. Aggiornare `eventTrigger` e `noPeAllowed`.
3. Rimuovere la restrizione “solo Maledizioni” su `hand_card`.
4. Modificare `queueOnPlay` / `applyEvent` per i Mostri in modo da avere chiaramente le due finestre.
5. Aggiornare i log e i messaggi di `traceEvent`.
6. Implementare il nuovo testo dell’anti-loop.
7. Test manuali dei casi:
   - Gioco Maledizione → finestra `card_played_from_hand` → NOPE
   - Gioco Mostro → finestra `card_played_from_hand` → (se passa) ingresso → finestra `creature_enters_field`
   - Mostrissimo → solo finestra di ingresso
   - Anti-loop con messaggio corretto

---

## 9. Cosa NON fare in questa fase

- Non cambiare ancora la struttura di `effect_json` delle carte esistenti (lo faremo in Fase 5 con la migrazione).
- Non toccare ancora l’editor (`admin.html`) → Fase 4.
- Non allargare ancora i bersagli di `return_hand` / `destroy` → Fase 3.
- Non rimuovere subito i vecchi nomi di trigger (servono per la retrocompatibilità durante la migrazione).

---

## 10. Prossimo passo dopo questa fase

Una volta implementate queste modifiche nel codice reale del repository e verificato che le finestre funzionano:

→ **Fase 3**: allargare i bersagli e aggiornare `return_hand` / `destroy` secondo le nuove regole.

---

**Fine specifiche Fase 2**

Quando avrai caricato i file della Fase 1 su GitHub e vorrai, posso aiutarti a scrivere le patch concrete riga-per-riga sui file del backend, oppure posso generare un diff proposto.
