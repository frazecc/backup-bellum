# Sistema Effetti & Trigger – Bellum Penumbrum

**Documento di progettazione**  
Versione: 2.0  
Data: 15 ottobre 2026  
Stato: **Completato** (Fasi 0–6)

Questo documento è la **fonte di verità** per il sistema di effetti e trigger.  
Va aggiornato ogni volta che si modifica il modello.

---

## 1. Obiettivi del sistema

- Pezzi **atomici** componibili (effetti + trigger).
- Ogni pezzo dichiara su quali tipi di carta può essere installato.
- Trigger **generici** e riutilizzabili.
- Libertà sui **bersagli** in creazione carta.
- Editor a blocchi (admin).
- Estendibile senza rompere le carte esistenti.

### Terminologia

| Termine | Significato |
|---------|-------------|
| **Creatura** | Mostro **oppure** Mostrissimo |
| **Permanente** | Mostro, Mostrissimo, Terraforma, Aura |
| **Carta giocata dalla mano** | Carta giocata spendendo mana dalla mano (Mostro, Maledizione, Aura, Terraforma, Trappola) |

---

## 2. Architettura

### Trigger atomici
- `id`, `name`, `description`
- `allowed_card_types`
- `timing`
- `is_reaction`

### Effetti atomici
- `id`, `name`, `description`
- `allowed_card_types`
- `parameters` (amount, duration, stat, keep…)
- `possible_targets`
- `requires_target_choice`

Definizioni TypeScript: `backend/effect-types.ts`  
Libreria runtime: `backend/effect-library.ts`

---

## 3. Trigger supportati

| ID | Nome | Apre reazione? | Note |
|----|------|----------------|------|
| `card_played_from_hand` | Avversario gioca una carta dalla mano | Sì | Dopo pagamento mana, prima dell’attivazione |
| `card_enters_field` | Questa / una carta entra in campo | Sì | Generico |
| `creature_enters_field` | Una creatura entra in campo | Sì | Mostro o Mostrissimo |
| `own_creature_enters_field` | Una tua creatura entra in campo | Sì | |
| `opponent_creature_enters_field` | Una creatura avversaria entra in campo | Sì | |
| `mostrissimo_before_entry` | Prima che un Mostrissimo entri | Sì | |
| `opponent_upkeep_start` | Inizio manutenzione avversario | Sì | |
| `opponent_upkeep_end` | Fine manutenzione avversario | Sì | |
| `equipped_creature_attacks` | Creatura equipaggiata attacca | No | Solo Aura |
| `own_monster_summoned` | Evochi un tuo Mostro | No | |
| `own_turn_start` | Inizio del tuo turno | No | |
| `own_creature_dies` | Una tua creatura muore | No | |
| `on_death` | Alla morte di questa carta | No | |
| `while_attached` | Finché è attaccata | No | Continuo, Aura |
| `while_in_play` | Finché è in campo | No | Continuo |

**Deprecated** (ancora accettati dal motore): `opponent_hand_card`, `monster_etb`.

**Mostrissimi:** non si giocano dalla mano → non scatta `card_played_from_hand`. Usare `creature_enters_field` / `card_enters_field`.

---

## 4. Effetti supportati

| ID | Nome | Note |
|----|------|------|
| `draw` | Pesca | self / opponent |
| `discard` | Scarta | self / opponent (+ keep) |
| `heal` | Cura | giocatore o creature |
| `damage` | Danno | creature, giocatore, any_target |
| `return_hand` | Torna in mano | Permanenti **tranne Mostrissimi**. Aura → in mano; creatura → in mano + Aure al cimitero |
| `destroy` | Distruggi | **Tutti** i permanenti (Mostri, Mostrissimi, Terraforme, Aure) |
| `buff` | Potenziamento | attack / hp, varie durate |
| `movement_cost` | Costo movimento | Solo Aura, valore 0 |
| `counter` / `nope` | Annulla evento | Solo Trappole |

---

## 5. Flusso finestre di reazione

### Carta giocata dalla mano
1. Pagamento mana  
2. Finestra `card_played_from_hand`  
3. Se NOPE → entrambe le carte al cimitero, mana **non** rimborsato  
4. Altrimenti la carta si attiva / entra  
5. Se è una creatura → seconda finestra `creature_enters_field`

### Mostrissimo
1. Sacrifici  
2. Finestra `mostrissimo_before_entry`  
3. Ingresso fisico  
4. Finestra `creature_enters_field`

### NOPE
- Compatibile con tutti gli eventi che aprono finestra  
- Entrambe le carte al cimitero, mana non rimborsato  

---

## 6. Anti-loop

Dopo più di 20 trigger consecutivi:
1. Plancia svuotata (permanenti al cimitero dei proprietari)  
2. Popup: **«Le bestie divine sono soddisfatte di ciò che hanno visto. Complimenti.»**  
3. La partita continua con la griglia vuota  

---

## 7. Come estendere senza rompere nulla

### Nuovo trigger
1. Aggiungere in `backend/effect-library.ts`  
2. Dichiarare `allowed_card_types` e se è reazione  
3. Aggiornare questo documento  
4. Collegare il punto di ascolto nel motore (`eventTrigger` / `noPeAllowed`)  
5. Aggiornare select Trappola in `docs/admin.html` e liste in `docs/admin/app.js`  

### Nuovo effetto
1. Aggiungere in `backend/effect-library.ts`  
2. Implementare la risoluzione in `engine-core.ts` (ramo dedicato)  
3. Aggiornare `card-rules.ts` e validazione in `app.js`  
4. Aggiungere template JSON in `docs/admin/effects/`  
5. Aggiornare questo documento  

### Regole d’oro
- Non cambiare il comportamento di un effetto esistente senza migrare le carte  
- Preferire pezzi atomici  
- Validazione sempre dalla stessa fonte di regole (card-rules + app.js allineati)  

---

## 8. Roadmap – stato

| Fase | Contenuto | Stato |
|------|-----------|--------|
| 0 | Documento di progettazione | Completata |
| 1 | Tipi + libreria atomica | Completata |
| 2 | Motore: nuovi trigger e finestre | Completata |
| 3 | Motore: return_hand / destroy su permanenti | Completata |
| 4 | Editor admin (trigger + bersagli) | Completata |
| 5 | Migrazione trigger sulle carte | Completata |
| 6 | Documentazione finale e checklist | Completata |

---

## 9. Checklist di verifica (Fase 6)

**Trigger e finestre**
- [ ] Giocare una Maledizione → si apre la finestra di reazione  
- [ ] Giocare un Mostro → finestra su “carta dalla mano”, poi (se passa) su “creatura entra”  
- [ ] Evocare un Mostrissimo → nessuna finestra “dalla mano”; sì finestra ingresso  
- [ ] NOPE su carta dalla mano → entrambe al cimitero, mana non rimborsato  

**return_hand / destroy**
- [ ] return_hand su Mostro → torna in mano, Aure al cimitero  
- [ ] return_hand su Terraforma → torna in mano  
- [ ] return_hand su Aura → Aura in mano, creatura resta  
- [ ] return_hand su Mostrissimo → non vale / annullato  
- [ ] destroy su Aura → Aura al cimitero  
- [ ] destroy su Mostrissimo → distrutto  

**Anti-loop**
- [ ] (Opzionale) Forzare molti trigger → plancia vuota + messaggio bestie divine  

**Editor**
- [ ] Select Trappola mostra i nuovi eventi  
- [ ] Si possono aggiungere effetti return_hand / destroy con i nuovi bersagli  
- [ ] Salvataggio carta non segnala errori di validazione sui trigger migrati  

---

## 10. File di riferimento

| Percorso | Ruolo |
|----------|--------|
| `backend/effect-types.ts` | Tipi TypeScript pezzi atomici |
| `backend/effect-library.ts` | Libreria trigger/effetti |
| `backend/types.ts` | `ReactionTriggerEvent` e stato partita |
| `backend/engine-core.ts` | Risoluzione effetti, NOPE, anti-loop |
| `backend/engine-board.ts` | Bersagli e permanenti |
| `backend/card-rules.ts` | Validazione server |
| `docs/admin.html` | UI editor |
| `docs/admin/app.js` | Logica editor + migrazione trigger |
| `docs/admin/effects/*.json` | Template effetti a blocchi |
| `docs/sistema-effetti.md` | Questo documento |

---

**Fine documento v2.0**
