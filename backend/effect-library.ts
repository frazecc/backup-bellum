/**
 * effect-library.ts
 * Libreria atomica di Trigger e Effetti per Bellum Penumbrum.
 *
 * Questo file è la fonte di verità runtime.
 * Per aggiungere un nuovo pezzo:
 * 1. Aggiungere la definizione qui.
 * 2. Aggiornare docs/sistema-effetti.md
 * 3. Implementare la risoluzione nel motore (se nuovo comportamento).
 * 4. Aggiornare l'editor perché mostri il pezzo solo sui tipi ammessi.
 *
 * Fase 1 – 15 ottobre 2026
 */

import type {
  CardType,
  EffectDefinitionAtomic,
  EffectLibrary,
  TriggerDefinition,
} from './effect-types.js';

// ---------------------------------------------------------------------------
// TRIGGER ATOMICI
// ---------------------------------------------------------------------------
const TRIGGERS: Record<string, TriggerDefinition> = {
  card_played_from_hand: {
    id: 'card_played_from_hand',
    name: 'Quando l’avversario gioca una carta dalla mano',
    description:
      'Scatta dopo che l’avversario ha pagato il mana di una carta giocata dalla mano, ma prima che la carta si attivi o entri in campo. Apre una finestra di reazione.',
    allowed_card_types: ['instant', 'aura', 'monster', 'mostrissimo', 'terraforma', 'maledizione'],
    timing: 'after_mana_paid_before_resolution',
    is_reaction: true,
  },

  card_enters_field: {
    id: 'card_enters_field',
    name: 'Quando questa carta entra in campo',
    description:
      'Scatta subito dopo che questa carta è fisicamente entrata in campo. Generico: funziona su qualsiasi tipo di carta.',
    allowed_card_types: ['monster', 'mostrissimo', 'maledizione', 'instant', 'aura', 'terraforma'],
    timing: 'after_enters_field',
    is_reaction: true,
  },

  creature_enters_field: {
    id: 'creature_enters_field',
    name: 'Quando una creatura entra in campo',
    description:
      'Scatta subito dopo l’ingresso fisico di una qualsiasi creatura (Mostro o Mostrissimo).',
    allowed_card_types: ['monster', 'mostrissimo', 'maledizione', 'instant', 'aura', 'terraforma'],
    timing: 'after_creature_enters_field',
    is_reaction: true,
  },

  own_creature_enters_field: {
    id: 'own_creature_enters_field',
    name: 'Quando una tua creatura entra in campo',
    description: 'Come creature_enters_field, ma solo per le creature del proprietario della carta.',
    allowed_card_types: ['monster', 'mostrissimo', 'maledizione', 'instant', 'aura', 'terraforma'],
    timing: 'after_own_creature_enters_field',
    is_reaction: true,
  },

  opponent_creature_enters_field: {
    id: 'opponent_creature_enters_field',
    name: 'Quando una creatura avversaria entra in campo',
    description: 'Come creature_enters_field, ma solo per le creature dell’avversario.',
    allowed_card_types: ['monster', 'mostrissimo', 'maledizione', 'instant', 'aura', 'terraforma'],
    timing: 'after_opponent_creature_enters_field',
    is_reaction: true,
  },

  equipped_creature_attacks: {
    id: 'equipped_creature_attacks',
    name: 'Quando la creatura equipaggiata attacca',
    description: 'Scatta quando la creatura a cui è attaccata questa Aura dichiara un attacco.',
    allowed_card_types: ['aura'],
    timing: 'on_declare_attack',
    is_reaction: false,
  },

  own_monster_summoned: {
    id: 'own_monster_summoned',
    name: 'Quando evochi un tuo Mostro',
    description: 'Scatta dopo l’ingresso di un tuo Mostro (non Mostrissimo).',
    allowed_card_types: ['terraforma', 'aura', 'monster', 'mostrissimo'],
    timing: 'after_own_monster_enters_field',
    is_reaction: false,
  },

  own_turn_start: {
    id: 'own_turn_start',
    name: 'All’inizio del tuo turno',
    description: 'Scatta all’inizio del turno del proprietario della carta.',
    allowed_card_types: ['terraforma', 'aura', 'monster', 'mostrissimo'],
    timing: 'own_turn_start',
    is_reaction: false,
  },

  own_creature_dies: {
    id: 'own_creature_dies',
    name: 'Quando una tua creatura muore',
    description: 'Scatta dopo che una creatura del proprietario lascia il campo.',
    allowed_card_types: ['terraforma', 'aura', 'monster', 'mostrissimo'],
    timing: 'after_own_creature_dies',
    is_reaction: false,
  },

  on_death: {
    id: 'on_death',
    name: 'Alla morte di questa carta',
    description: 'Scatta quando questa carta viene distrutta o sacrificata.',
    allowed_card_types: ['monster', 'mostrissimo', 'terraforma'],
    timing: 'on_death',
    is_reaction: false,
  },

  while_attached: {
    id: 'while_attached',
    name: 'Finché è attaccata',
    description: 'Effetto continuo attivo finché l’Aura resta attaccata a una creatura.',
    allowed_card_types: ['aura'],
    timing: 'continuous',
    is_reaction: false,
    is_continuous: true,
  },

  while_in_play: {
    id: 'while_in_play',
    name: 'Finché è in campo',
    description: 'Effetto continuo attivo finché la carta resta in campo.',
    allowed_card_types: ['terraforma', 'monster', 'mostrissimo'],
    timing: 'continuous',
    is_reaction: false,
    is_continuous: true,
  },
};

// ---------------------------------------------------------------------------
// EFFETTI ATOMICI
// ---------------------------------------------------------------------------
const EFFECTS: Record<string, EffectDefinitionAtomic> = {
  draw: {
    id: 'draw',
    name: 'Pesca',
    description: 'Il bersaglio pesca un numero di carte.',
    allowed_card_types: ['monster', 'mostrissimo', 'maledizione', 'instant', 'aura', 'terraforma'],
    parameters: { amount: true },
    possible_targets: ['self', 'opponent'],
    requires_target_choice: false,
  },

  discard: {
    id: 'discard',
    name: 'Scarta',
    description:
      'Il bersaglio scarta carte. Con il parametro “keep” scarta tutta la mano tranne N carte scelte a caso.',
    allowed_card_types: ['monster', 'mostrissimo', 'maledizione', 'instant', 'aura', 'terraforma'],
    parameters: { amount: true, keep: true },
    possible_targets: ['self', 'opponent'],
    requires_target_choice: false,
  },

  heal: {
    id: 'heal',
    name: 'Cura',
    description: 'Ripristina punti vita a un giocatore o a creature.',
    allowed_card_types: ['monster', 'mostrissimo', 'maledizione', 'instant', 'aura', 'terraforma'],
    parameters: { amount: true },
    possible_targets: [
      'self',
      'opponent',
      'own_creatures',
      'opponent_creatures',
      'any_creature',
      'any_target',
    ],
    requires_target_choice: true,
  },

  damage: {
    id: 'damage',
    name: 'Danno',
    description: 'Infligge danni a giocatori o permanenti (non Aure).',
    allowed_card_types: ['monster', 'mostrissimo', 'maledizione', 'instant', 'aura', 'terraforma'],
    parameters: { amount: true },
    possible_targets: [
      'self',
      'opponent',
      'own_creatures',
      'opponent_creatures',
      'any_creature',
      'own_terraformas',
      'opponent_terraformas',
      'any_terraforma',
      'own_permanents',
      'opponent_permanents',
      'any_permanent',
      'any_target',
    ],
    requires_target_choice: true,
  },

  return_hand: {
    id: 'return_hand',
    name: 'Torna in mano',
    description:
      'Rimanda un permanente in mano al proprietario. Non funziona sui Mostrissimi. Se il bersaglio è un’Aura, viene staccata e torna in mano.',
    allowed_card_types: ['monster', 'mostrissimo', 'maledizione', 'instant', 'aura', 'terraforma'],
    parameters: {},
    possible_targets: ['any_permanent_except_mostrissimo', 'any_target'],
    requires_target_choice: true,
  },

  destroy: {
    id: 'destroy',
    name: 'Distruggi',
    description:
      'Distrugge un permanente (Mostro, Mostrissimo, Terraforma o Aura). L’Aura viene staccata e va al cimitero.',
    allowed_card_types: ['monster', 'mostrissimo', 'maledizione', 'instant', 'aura', 'terraforma'],
    parameters: {},
    possible_targets: [
      'own_creatures',
      'opponent_creatures',
      'any_creature',
      'own_terraformas',
      'opponent_terraformas',
      'any_terraforma',
      'own_auras',
      'opponent_auras',
      'any_aura',
      'own_permanents',
      'opponent_permanents',
      'any_permanent',
      'any_target',
    ],
    requires_target_choice: true,
  },

  buff: {
    id: 'buff',
    name: 'Potenziamento',
    description: 'Aumenta attacco o punti vita di una o più creature.',
    allowed_card_types: ['monster', 'mostrissimo', 'aura', 'terraforma'],
    parameters: { amount: true, stat: true, duration: true },
    possible_targets: [
      'source_creature',
      'enchanted_creature',
      'triggering_creature',
      'own_creatures',
      'any_creature',
      'any_target',
    ],
    requires_target_choice: true,
  },

  movement_cost: {
    id: 'movement_cost',
    name: 'Costo di movimento',
    description: 'Modifica il costo di movimento della creatura equipaggiata (attualmente supportato solo valore 0).',
    allowed_card_types: ['aura'],
    parameters: { amount: true },
    possible_targets: ['enchanted_creature'],
    requires_target_choice: false,
  },

  counter: {
    id: 'counter',
    name: 'NOPE / Annulla',
    description:
      'Annulla l’evento a cui risponde. Entrambe le carte (quella annullata e il NOPE) vanno al cimitero. Il mana speso non viene rimborsato.',
    allowed_card_types: ['instant'],
    parameters: {},
    possible_targets: [],
    requires_target_choice: false,
    is_counter: true,
  },
};

// ---------------------------------------------------------------------------
// Esportazione della libreria completa
// ---------------------------------------------------------------------------
export const EFFECT_LIBRARY: EffectLibrary = {
  triggers: TRIGGERS,
  effects: EFFECTS,
};

/** Helper: restituisce un trigger o undefined */
export function getTrigger(id: string): TriggerDefinition | undefined {
  return EFFECT_LIBRARY.triggers[id];
}

/** Helper: restituisce un effetto o undefined */
export function getEffect(id: string): EffectDefinitionAtomic | undefined {
  return EFFECT_LIBRARY.effects[id];
}

/** Helper: lista di tutti i trigger installabili su un certo tipo di carta */
export function triggersForCardType(cardType: CardType): TriggerDefinition[] {
  return Object.values(EFFECT_LIBRARY.triggers).filter((t) =>
    t.allowed_card_types.includes(cardType)
  );
}

/** Helper: lista di tutti gli effetti installabili su un certo tipo di carta */
export function effectsForCardType(cardType: CardType): EffectDefinitionAtomic[] {
  return Object.values(EFFECT_LIBRARY.effects).filter((e) =>
    e.allowed_card_types.includes(cardType)
  );
}
