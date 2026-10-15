# Sistema Effetti & Trigger – Bellum Penumbrum

**Documento di progettazione**  
Versione: 1.1  
Data: 15 ottobre 2026  
Stato: Fase 0 completata – Fase 1 in corso

Questo documento è la **fonte di verità** per il nuovo sistema di effetti e trigger.  
Deve essere aggiornato ogni volta che si modifica il modello.  
Chiunque (me o te) dovrà consultarlo prima di aggiungere nuovi effetti, trigger o regole.

---

## 1. Obiettivi del nuovo sistema

- Pezzi **atomici** componibili (effetti + trigger).
- Ogni pezzo dichiara esplicitamente **su quali tipi di carta può essere installato**.
- Trigger **generici** e riutilizzabili su più tipi di carta (con restrizioni chiare).
- Massima libertà sui **bersagli** in fase di creazione carta (checklist multi-selezione).
- Interfaccia editor comoda (pagina unica a blocchi).
- Documentazione chiara per estendere il sistema senza rompere nulla.
- Migrazione delle carte esistenti.

### Terminologia importante

| Termine       | Significato                                      |
|---------------|--------------------------------------------------|
| **Creatura**  | Mostro **oppure** Mostrissimo                    |
| **Permanente**| Mostro, Mostrissimo, Terraforma, Aura            |
| **Carta giocata dalla mano** | Qualsiasi carta che il giocatore gioca spendendo mana dalla propria mano (Mostro, Maledizione, Aura, Terraforma, Trappola) |

---

## 2. Architettura a pezzi atomici

Il sistema è diviso in due librerie principali:

### 2.1 Trigger atomici

Un trigger descrive **quando** un effetto può scattare.

Campi principali:
- `id` (stringa univoca, es. `card_played_from_hand`)
- `name` (nome leggibile in italiano)
- `description` (testo esplicativo)
- `allowed_card_types` (array dei tipi di carta su cui può essere installato)
- `timing` (momento esatto di attivazione)
- `is_reaction` (true se apre una finestra di reazione)

### 2.2 Effetti atomici

Un effetto descrive **cosa** succede.

Campi principali:
- `id` (stringa univoca, es. `damage`)
- `name`
- `description`
- `allowed_card_types`
- `parameters` (quantità, durata, stat, keep, ecc.)
- `possible_targets` (lista di bersagli che l’autore della carta può abilitare)
- `requires_target_choice` (se in partita il giocatore deve scegliere)

Gli effetti possono essere usati:
- Come effetto immediato (on_play / instant)
- Come effetto alla morte (`effect_on_death`)
- Come effetto continuo (while_attached / while_in_play)
- Attaccati a un trigger

---

## 3. Libreria iniziale dei Trigger

| ID                          | Nome leggibile                              | Tipi di carta ammessi                  | Momento di attivazione                                      | Apre finestra reazione? |
|-----------------------------|---------------------------------------------|----------------------------------------|-------------------------------------------------------------|-------------------------|
| `card_played_from_hand`     | Quando l’avversario gioca una carta dalla mano | Trappola, Aura, Mostro, Mostrissimo, Terraforma, Maledizione | Dopo pagamento mana, **prima** che la carta si attivi       | Sì                      |
| `card_enters_field`         | Quando questa carta entra in campo          | Tutti                                  | Subito dopo che la carta è fisicamente entrata in campo     | Sì (se usato come reazione) |
| `creature_enters_field`     | Quando una creatura entra in campo          | Tutti                                  | Subito dopo l’ingresso fisico di una creatura (Mostro o Mostrissimo) | Sì                  |
| `own_creature_enters_field` | Quando una tua creatura entra in campo      | Tutti                                  | Come sopra, solo proprie                                    | Sì                      |
| `opponent_creature_enters_field` | Quando una creatura avversaria entra in campo | Tutti                               | Come sopra, solo avversarie                                 | Sì                      |
| `equipped_creature_attacks` | Quando la creatura equipaggiata attacca     | Aura                                   | Quando la creatura con questa Aura dichiara un attacco      | No                      |
| `own_monster_summoned`      | Quando evochi un tuo Mostro                 | Terraforma, Aura, Mostro, Mostrissimo  | Dopo l’ingresso di un tuo Mostro                            | No                      |
| `own_turn_start`            | All’inizio del tuo turno                    | Terraforma, Aura, Mostro, Mostrissimo  | Fase start del tuo turno                                    | No                      |
| `own_creature_dies`         | Quando una tua creatura muore               | Terraforma, Aura, Mostro, Mostrissimo  | Dopo la morte di una tua creatura                           | No                      |
| `on_death`                  | Alla morte di questa carta                  | Mostro, Mostrissimo, Terraforma        | Quando questa carta viene distrutta/sacrificata             | No                      |
| `while_attached`            | Finché è attaccata                          | Aura                                   | Passivo continuo                                            | No                      |
| `while_in_play`             | Finché è in campo                           | Terraforma, Mostro, Mostrissimo        | Passivo continuo                                            | No                      |

**Nota importante sui Mostrissimi**  
I Mostrissimi **non** vengono giocati dalla mano.  
Quindi il trigger `card_played_from_hand` **non** scatta per loro.  
Usare `card_enters_field` o `creature_enters_field` per catturare l’ingresso.

---

## 4. Libreria iniziale degli Effetti

| ID              | Nome          | Tipi ammessi                          | Parametri principali          | Bersagli possibili (checklist) |
|-----------------|---------------|---------------------------------------|-------------------------------|--------------------------------|
| `draw`          | Pesca         | Tutti                                 | amount                        | self, opponent                 |
| `discard`       | Scarta        | Tutti                                 | amount, keep                  | self, opponent                 |
| `heal`          | Cura          | Tutti                                 | amount                        | self, opponent, own_creatures, opponent_creatures, all_creatures, any_creature |
| `damage`        | Danno         | Tutti                                 | amount                        | self, opponent, own_permanents*, opponent_permanents*, any_permanent*, any_target |
| `return_hand`   | Torna in mano | Tutti                                 | —                             | any_permanent_except_mostrissimo |
| `destroy`       | Distruggi     | Tutti                                 | —                             | any_permanent                  |
| `buff`          | Potenziamento | Mostro, Mostrissimo, Aura, Terraforma | amount, stat (atk/hp), duration | source_creature, enchanted_creature, own_creatures, triggering_creature, all_creatures_self |
| `movement_cost` | Costo movimento | Aura                                | amount (solo 0 supportato)    | enchanted_creature             |
| `counter` / `nope` | Annulla evento | Trappola                           | —                             | (agisce sull’evento)           |

\* Per `damage` e simili: “permanents” include Mostri, Mostrissimi e Terraforme. Le Aure **non** possono essere bersagliate direttamente da danno (si distruggono solo con `destroy` o quando la creatura muore).

### Regole speciali

**return_hand**
- Funziona su qualsiasi permanente **tranne** Mostrissimi.
- Se il bersaglio è un’Aura → l’Aura va in mano al proprietario e viene staccata dalla creatura.
- Se il bersaglio è una creatura → la creatura torna in mano e le sue Aure vanno al cimitero del rispettivo proprietario.

**destroy**
- Funziona su **tutti** i permanenti (Mostri, Mostrissimi, Terraforme, Aure).
- Se distrugge un’Aura → l’Aura va al cimitero e viene staccata.
- Se distrugge una creatura → si attivano gli effetti `on_death` e i trigger collegati.

**NOPE (counter)**
- Solo su Trappole.
- Testo concettuale: “Quando l’avversario fa X, annulla X”.
- Compatibile con **tutti** gli eventi che aprono una finestra di reazione.
- Timing: dopo che il mana della carta avversaria è stato pagato, prima che la carta si attivi.
- Effetto: entrambe le carte (quella annullata e il NOPE) vanno al cimitero.  
  Il mana speso **non** viene rimborsato.

---

## 5. Flusso delle finestre di reazione (ordine preciso)

### Caso A – Avversario gioca una carta dalla mano (Mostro, Maledizione, Aura, Terraforma, Trappola)

1. Il giocatore dichiara la carta e paga il mana.
2. Si apre la finestra di reazione con trigger `card_played_from_hand`.
3. Se qualcuno gioca un NOPE valido → la carta giocata e il NOPE vanno al cimitero. Fine.
4. Se nessuno annulla → la carta si attiva / entra in campo.
5. Se la carta è una creatura (Mostro) → dopo l’ingresso fisico si apre la seconda finestra con trigger `card_enters_field` / `creature_enters_field`.

### Caso B – Ingresso di un Mostrissimo

1. Il giocatore completa i sacrifici.
2. Si apre la finestra `mostrissimo_before_entry` (se ancora supportata) o equivalente.
3. Se non annullato → il Mostrissimo entra fisicamente in campo.
4. Subito dopo si apre la finestra `card_enters_field` / `creature_enters_field`.

### Caso C – Altri trigger (attacco, morte, inizio turno…)

Si risolvono senza finestra di reazione (a meno che l’effetto stesso non sia di tipo reazione).

---

## 6. Dichiarazione dei bersagli (editor e motore)

Nell’editor, per ogni effetto che può avere bersaglio, appare una **checklist multi-selezione**:

- ☐ Giocatore avversario (`opponent`)
- ☐ Se stesso (`self`)
- ☐ Creature proprie (`own_creatures`)
- ☐ Creature avversarie (`opponent_creatures`)
- ☐ Qualsiasi creatura (`any_creature`)
- ☐ Terraforme proprie
- ☐ Terraforme avversarie
- ☐ Qualsiasi Terraforma
- ☐ Aure proprie
- ☐ Aure avversarie
- ☐ Qualsiasi permanente (eccetto Mostrissimi per `return_hand`)
- ☐ Qualsiasi bersaglio legale a scelta del giocatore in partita (`any_target` / player choice)

In partita il giocatore potrà scegliere **solo** tra i bersagli che l’autore della carta ha abilitato.

---

## 7. Anti-loop

Dopo un numero eccessivo di trigger consecutivi (soglia attuale: 20):

1. La plancia viene completamente svuotata (tutti i permanenti vanno al cimitero dei rispettivi proprietari).
2. Appare un popup con il testo:

   > **Le bestie divine sono soddisfatte di ciò che hanno visto. Complimenti.**

3. La partita **continua normalmente** con la griglia vuota.

---

## 8. Come estendere il sistema in futuro (senza rompere nulla)

### Aggiungere un nuovo Trigger

1. Aggiungere una riga nella libreria dei trigger (file dedicato, non hardcoded sparso).
2. Dichiarare chiaramente `allowed_card_types`.
3. Definire il momento esatto (`timing`) e se apre finestra di reazione.
4. Aggiornare questo documento (sezione 3).
5. Aggiornare il motore solo nel punto che ascolta quel trigger.
6. Aggiornare l’editor perché mostri il nuovo trigger solo sui tipi di carta ammessi.

### Aggiungere un nuovo Effetto

1. Aggiungere nella libreria degli effetti.
2. Dichiarare `allowed_card_types` e `possible_targets`.
3. Implementare la risoluzione nel motore in modo isolato (funzione dedicata).
4. Aggiornare questo documento (sezione 4).
5. Aggiornare l’editor (nuovo blocco selezionabile + checklist bersagli).

### Regole d’oro

- **Mai** modificare il comportamento di un effetto esistente senza aggiornare tutte le carte che lo usano.
- Ogni nuovo pezzo deve essere retrocompatibile o accompagnato da script di migrazione.
- La validazione (card-rules) deve usare sempre la libreria, non liste duplicate.
- Preferire sempre pezzi atomici a effetti monolitici.

---

## 9. Piano di migrazione delle carte esistenti

1. Mappare ogni `effect_json` e `effect_on_death_json` attuale sui nuovi pezzi atomici.
2. Convertire i vecchi trigger (`opponent_hand_card`, `monster_etb`, ecc.) nei nuovi equivalenti.
3. Per le carte che usavano bersagli generici, abilitare la checklist più vicina al comportamento originale.
4. Eseguire uno script di migrazione sul database.
5. Verificare una per una le carte più importanti (boss, Mostrissimi, Trappole chiave).

---

## 10. Prossimi passi (Roadmap)

| Fase | Contenuto                                      | Stato          |
|------|------------------------------------------------|----------------|
| 0    | Documento di progettazione                     | Completata     |
| 1    | Modello dati TypeScript + libreria atomica     | Completata     |
| 2    | Motore: nuovi trigger e finestre di reazione   | Da fare        |
| 3    | Motore: bersagli flessibili + return_hand/destroy | Da fare     |
| 4    | Editor admin.html a blocchi                    | Da fare        |
| 5    | Migrazione carte esistenti                     | Da fare        |
| 6    | Test, rifiniture e documentazione finale       | Da fare        |

---

## File prodotti nella Fase 1

- `docs/effect-types.ts` → definizioni TypeScript dei pezzi atomici
- `docs/effect-library.ts` → libreria concreta di Trigger e Effetti

Questi file sono pronti per essere copiati/integrati nel backend del repository.

**Prossimo passo (Fase 2):** aggiornare il motore di gioco per supportare i nuovi trigger (`card_played_from_hand`, `card_enters_field`, ecc.) e le finestre di reazione secondo il flusso definito in questo documento.
