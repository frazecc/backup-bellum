/**
 * effect-types.ts
 * Tipi TypeScript per il nuovo sistema di effetti e trigger atomici.
 * Da integrare nel backend (sostituisce/estende parti di types.ts).
 *
 * Fase 1 – Bellum Penumbrum
 * Data: 15 ottobre 2026
 */

// ---------------------------------------------------------------------------
// Tipi di carta (già esistenti, qui per riferimento)
// ---------------------------------------------------------------------------
export type CardType =
  | 'monster'
  | 'mostrissimo'
  | 'maledizione'
  | 'instant'      // Trappola
  | 'aura'
  | 'terraforma';

// ---------------------------------------------------------------------------
// Bersagli possibili (checklist multi-selezione nell'editor)
// ---------------------------------------------------------------------------
export type TargetOption =
  | 'self'                        // il proprietario della carta
  | 'opponent'                    // l'avversario
  | 'own_creatures'               // creature proprie (Mostri + Mostrissimi)
  | 'opponent_creatures'          // creature avversarie
  | 'any_creature'                // qualsiasi creatura
  | 'own_terraformas'             // Terraforme proprie
  | 'opponent_terraformas'        // Terraforme avversarie
  | 'any_terraforma'              // qualsiasi Terraforma
  | 'own_auras'                   // Aure proprie
  | 'opponent_auras'              // Aure avversarie
  | 'any_aura'                    // qualsiasi Aura
  | 'own_permanents'              // tutti i permanenti propri
  | 'opponent_permanents'         // tutti i permanenti avversari
  | 'any_permanent'               // qualsiasi permanente
  | 'any_permanent_except_mostrissimo' // per return_hand
  | 'source_creature'             // la creatura che ha generato l'effetto (ETB, attacco…)
  | 'enchanted_creature'          // la creatura a cui è attaccata l'Aura
  | 'triggering_creature'         // la creatura che ha scatenato il trigger
  | 'any_target';                 // scelta libera del giocatore in partita (tra i legali)
  ;

// ---------------------------------------------------------------------------
// Parametri comuni degli effetti
// ---------------------------------------------------------------------------
export type EffectStat = 'attack' | 'hp';
export type EffectDuration =
  | 'permanent'
  | 'turn'
  | 'while_attached'
  | 'while_in_play';

// ---------------------------------------------------------------------------
// Definizione di un Trigger atomico (pezzo della libreria)
// ---------------------------------------------------------------------------
export type TriggerDefinition = {
  /** Identificativo univoco (es. "card_played_from_hand") */
  id: string;
  /** Nome leggibile in italiano */
  name: string;
  /** Descrizione per l'editor e la documentazione */
  description: string;
  /** Tipi di carta su cui questo trigger può essere installato */
  allowed_card_types: CardType[];
  /**
   * Momento esatto di attivazione (testo libero + codice interno).
   * Esempi: "after_mana_paid_before_resolution", "after_enters_field", "on_declare_attack"
   */
  timing: string;
  /** Se true, può aprire una finestra di reazione (Trappole / effetti reattivi) */
  is_reaction: boolean;
  /** Se true, il trigger è "passivo continuo" (while_attached / while_in_play) */
  is_continuous?: boolean;
};

// ---------------------------------------------------------------------------
// Definizione di un Effetto atomico (pezzo della libreria)
// ---------------------------------------------------------------------------
export type EffectDefinitionAtomic = {
  /** Identificativo univoco (es. "damage") */
  id: string;
  /** Nome leggibile */
  name: string;
  /** Descrizione */
  description: string;
  /** Tipi di carta su cui questo effetto può essere installato */
  allowed_card_types: CardType[];
  /** Parametri che l'autore della carta può configurare */
  parameters: {
    amount?: boolean;          // quantità numerica (0-20)
    keep?: boolean;            // per discard: tieni N carte
    stat?: boolean;            // attack | hp
    duration?: boolean;        // permanent | turn | while_attached | while_in_play
  };
  /** Bersagli che l'autore può abilitare (checklist) */
  possible_targets: TargetOption[];
  /** Se true, in partita il giocatore deve scegliere un bersaglio */
  requires_target_choice: boolean;
  /** Se true, questo effetto è un NOPE / counter */
  is_counter?: boolean;
};

// ---------------------------------------------------------------------------
// Istanza di un effetto su una carta concreta (quello che viene salvato in effect_json)
// ---------------------------------------------------------------------------
export type CardEffectInstance = {
  /** Riferimento all'effetto atomico */
  effect_id: string;
  /** Quantità (se prevista) */
  amount?: number;
  /** Per discard: scarta tutta la mano tranne N */
  keep?: number;
  /** Stat da modificare (buff) */
  stat?: EffectStat;
  /** Durata del buff */
  duration?: EffectDuration;
  /** Bersagli abilitati dall'autore della carta (sottoinsieme di possible_targets) */
  allowed_targets: TargetOption[];
  /** Trigger a cui è collegato questo effetto (opzionale) */
  trigger_id?: string;
  /** Filtro opzionale (sottotipo / fazione) – usato soprattutto da Terraforme e buff continui */
  filter?: {
    subtype?: string;
    faction?: string;
  };
};

// ---------------------------------------------------------------------------
// Forma completa di effect_json / effect_on_death_json su una carta
// ---------------------------------------------------------------------------
export type CardEffectsPayload = {
  effects: CardEffectInstance[];
  /** Solo per le Trappole: trigger di reazione principale */
  reaction_trigger_id?: string;
};

// ---------------------------------------------------------------------------
// Libreria completa (caricata una sola volta)
// ---------------------------------------------------------------------------
export type EffectLibrary = {
  triggers: Record<string, TriggerDefinition>;
  effects: Record<string, EffectDefinitionAtomic>;
};
