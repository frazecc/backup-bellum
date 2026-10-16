// backend/lobby.ts — presenza lobby PvP + sfide (in-memory, heartbeat 5s).
// Camera del Re Lobbi II: una sola stanza globale.

export type LobbyStatus = 'idle' | 'challenged' | 'in_match' | 'picking_colors';

export type LobbyPlayer = {
  userId: string;
  username: string;
  lastSeen: number;
  status: LobbyStatus;
  matchId?: string | null;
};

export type ChallengeStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired';

export type LobbyChallenge = {
  id: string;
  fromUserId: string;
  fromUsername: string;
  toUserId: string;
  toUsername: string;
  status: ChallengeStatus;
  createdAt: number;
  matchId?: string | null;
  /** Colori inviati: key = userId */
  colors?: Record<string, { primary: string; secondary: string; tertiary?: string }>;
};

const PRESENCE_TTL_MS = 5_000;
const CHALLENGE_TTL_MS = 120_000;

const presence = new Map<string, LobbyPlayer>();
const challenges = new Map<string, LobbyChallenge>();

function prunePresence(now = Date.now()) {
  for (const [id, p] of presence) {
    if (now - p.lastSeen > PRESENCE_TTL_MS) presence.delete(id);
  }
}

function pruneChallenges(now = Date.now()) {
  for (const [id, c] of challenges) {
    if (c.status === 'pending' && now - c.createdAt > CHALLENGE_TTL_MS) {
      c.status = 'expired';
      const from = presence.get(c.fromUserId);
      const to = presence.get(c.toUserId);
      if (from && from.status === 'challenged') from.status = 'idle';
      if (to && to.status === 'challenged') to.status = 'idle';
    }
  }
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** Entra / heartbeat in lobby. */
export function lobbyJoin(userId: string, username: string): LobbyPlayer {
  prunePresence();
  pruneChallenges();
  const existing = presence.get(userId);
  if (existing) {
    existing.lastSeen = Date.now();
    existing.username = username || existing.username;
    // Non forzare idle se già in match/colori
    if (existing.status === 'challenged') {
      // resta challenged finché la sfida non si risolve
    }
    return existing;
  }
  const p: LobbyPlayer = {
    userId,
    username: username || 'viaggiatore',
    lastSeen: Date.now(),
    status: 'idle',
    matchId: null,
  };
  presence.set(userId, p);
  return p;
}

export function lobbyLeave(userId: string) {
  const p = presence.get(userId);
  presence.delete(userId);
  // Cancella sfide pending in cui è coinvolto
  for (const c of challenges.values()) {
    if (c.status !== 'pending') continue;
    if (c.fromUserId === userId || c.toUserId === userId) {
      c.status = 'cancelled';
      const otherId = c.fromUserId === userId ? c.toUserId : c.fromUserId;
      const other = presence.get(otherId);
      if (other && other.status === 'challenged') other.status = 'idle';
    }
  }
  return p ?? null;
}

export function lobbyHeartbeat(userId: string, username?: string): LobbyPlayer | null {
  prunePresence();
  const p = presence.get(userId);
  if (!p) return null;
  p.lastSeen = Date.now();
  if (username) p.username = username;
  return p;
}

/** Lista giocatori visibili (idle), escluso te. */
export function lobbyList(excludeUserId: string): { userId: string; username: string }[] {
  prunePresence();
  pruneChallenges();
  const out: { userId: string; username: string }[] = [];
  for (const p of presence.values()) {
    if (p.userId === excludeUserId) continue;
    if (p.status !== 'idle') continue;
    out.push({ userId: p.userId, username: p.username });
  }
  out.sort((a, b) => a.username.localeCompare(b.username));
  return out;
}

export function lobbyCreateChallenge(
  fromUserId: string,
  fromUsername: string,
  toUserId: string,
): LobbyChallenge {
  prunePresence();
  pruneChallenges();
  if (fromUserId === toUserId) throw new Error('Non puoi sfidare te stesso');
  const from = presence.get(fromUserId);
  const to = presence.get(toUserId);
  if (!from) throw new Error('Non sei in lobby: rientra nella Camera');
  if (!to) throw new Error('Avversario non più in lobby');
  if (from.status !== 'idle') throw new Error('Non puoi sfidare ora');
  if (to.status !== 'idle') throw new Error('Avversario non disponibile');

  // Una sola sfida pending per coppia
  for (const c of challenges.values()) {
    if (c.status !== 'pending') continue;
    if (
      (c.fromUserId === fromUserId && c.toUserId === toUserId) ||
      (c.fromUserId === toUserId && c.toUserId === fromUserId)
    ) {
      throw new Error('C’è già una sfida in corso con questo giocatore');
    }
  }

  const challenge: LobbyChallenge = {
    id: newId(),
    fromUserId,
    fromUsername: fromUsername || from.username,
    toUserId,
    toUsername: to.username,
    status: 'pending',
    createdAt: Date.now(),
    matchId: null,
    colors: {},
  };
  challenges.set(challenge.id, challenge);
  from.status = 'challenged';
  to.status = 'challenged';
  return challenge;
}

export function lobbyGetChallenge(id: string): LobbyChallenge | null {
  pruneChallenges();
  return challenges.get(id) ?? null;
}

export function lobbyChallengesFor(userId: string): LobbyChallenge[] {
  pruneChallenges();
  const out: LobbyChallenge[] = [];
  for (const c of challenges.values()) {
    if (c.fromUserId === userId || c.toUserId === userId) out.push(c);
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

export function lobbyDeclineChallenge(challengeId: string, userId: string): LobbyChallenge {
  const c = challenges.get(challengeId);
  if (!c) throw new Error('Sfida non trovata');
  if (c.status !== 'pending') throw new Error('Sfida non più valida');
  if (c.toUserId !== userId && c.fromUserId !== userId) throw new Error('Sfida non tua');
  c.status = 'declined';
  const from = presence.get(c.fromUserId);
  const to = presence.get(c.toUserId);
  if (from) from.status = 'idle';
  if (to) to.status = 'idle';
  return c;
}

/** Accetta: marca accepted e status picking_colors; match creato dopo i colori. */
export function lobbyAcceptChallenge(challengeId: string, userId: string): LobbyChallenge {
  const c = challenges.get(challengeId);
  if (!c) throw new Error('Sfida non trovata');
  if (c.status !== 'pending') throw new Error('Sfida non più valida');
  if (c.toUserId !== userId) throw new Error('Solo il sfidato può accettare');
  c.status = 'accepted';
  const from = presence.get(c.fromUserId);
  const to = presence.get(c.toUserId);
  if (from) {
    from.status = 'picking_colors';
    from.matchId = null;
  }
  if (to) {
    to.status = 'picking_colors';
    to.matchId = null;
  }
  return c;
}

export function lobbySubmitColors(
  challengeId: string,
  userId: string,
  primary: string,
  secondary: string,
  tertiary?: string,
): LobbyChallenge {
  const c = challenges.get(challengeId);
  if (!c) throw new Error('Sfida non trovata');
  if (c.status !== 'accepted') throw new Error('Sfida non in fase colori');
  if (c.fromUserId !== userId && c.toUserId !== userId) throw new Error('Sfida non tua');
  if (!c.colors) c.colors = {};
  c.colors[userId] = { primary, secondary, tertiary };
  return c;
}

export function lobbyBothColorsReady(c: LobbyChallenge): boolean {
  if (!c.colors) return false;
  return !!(c.colors[c.fromUserId] && c.colors[c.toUserId]);
}

export function lobbyAttachMatch(challengeId: string, matchId: string) {
  const c = challenges.get(challengeId);
  if (!c) return;
  c.matchId = matchId;
  const from = presence.get(c.fromUserId);
  const to = presence.get(c.toUserId);
  if (from) {
    from.status = 'in_match';
    from.matchId = matchId;
  }
  if (to) {
    to.status = 'in_match';
    to.matchId = matchId;
  }
}

export function lobbySetIdle(userId: string) {
  const p = presence.get(userId);
  if (p) {
    p.status = 'idle';
    p.matchId = null;
    p.lastSeen = Date.now();
  }
}
