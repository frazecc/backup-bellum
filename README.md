# Bellum Penumbrum

Gioco di carte tattico 1vs1 (giocatore vs IA) su griglia 3×3, giocabile nel browser.

**Gioco online:** https://frazecc.github.io/backup-bellum/  
**API:** https://bellum-penumbrum-api.onrender.com  
**Repo:** https://github.com/frazecc/backup-bellum

---

## Struttura

| Cartella / file | Ruolo |
|-----------------|--------|
| `docs/` | Frontend statico (HTML/JS/CSS). Pubblicato su GitHub Pages. |
| `docs/admin.html` | Editor carte (accesso solo UUID admin). |
| `backend/` | API Express + TypeScript + motore di gioco. Deploy su Render. |
| `README.md` | Questo file. |

Il frontend **non** contiene regole di gioco: mostra lo stato e invia azioni.  
Tutto il motore (turni, effetti, IA, validazione) è nel backend.

---

## Flusso di ingresso (narrativo)

1. All’apertura compare sempre la mummia: *«Benvenuto coraggioso… dimostrami chi sei.»*
2. Se non sei loggato → form username + password (email `username@test.local`).
3. Se sei già loggato → bottone **«Sono io»** (niente password).
4. Dopo l’ingresso:
   - se c’è una partita non terminata → **RIPRENDI le tue spoglie** oppure **Abbraccia un nuovo inizio**
   - altrimenti solo nuovo inizio
5. Scelta colori:
   - **Colore dell’anima** = primary
   - **Potere dell’amuleto** = secondary
6. Pop-up **maledizione**: il terzo colore (sempre diverso dai due scelti) è imposto al giocatore e diventa il **primary dell’IA**.
7. **Sconfitta** → ritorno alla mummia (sessione attiva, basta «Sono io»).
8. **Vittoria** → messaggio di vittoria (progressione a 3 vittorie: in coda).

---

## Come si gioca (riassunto)

- Vita iniziale **20**, partite brevi (~5 minuti).
- Griglia **3×3**. La casella centrale `(1,1)` dà **+1 attacco permanente** a ogni creatura che ci si trova, a **ogni upkeep** (tuo e dell’IA). Il bonus resta anche se la creatura si muove.
- Mazzo di **10 carte** auto-generato (niente deckbuilding):
  - 1 boss obbligatorio (Mostro 6 mana del colore principale)
  - almeno 1 carta per ogni costo **1, 2, 3, 4, 5, 6**
  - somma mana tra **25 e 35**
  - colori: ≥2 primary, ≥2 secondary, ≥1 tertiary
- **Mostrissimi**: offerta condivisa, max 1 evocato per turno, si pagano con sacrifici di permanenti.
- Movimento: 1 mana, 1 casella ortogonale. Entra stanca (tranne *Iperattivo*).

Fazioni (fondamento delle comuni):

| Codice | Nome | Fondamento |
|--------|------|------------|
| CHI | Chiericanza | cura |
| INF | Infamia | pesca |
| PES | Pestilenza | scarta |
| BUL | Bullismo | danno |
| GRO | Grossanza | buff |
| CLO | Clownerie | versioni “Clown” / +1 costo |

Sottotipi attivi in catalogo: **Mostriciattolo, Prestigiatore, Cosplayer, Capibara, Cliché, Indrazzico**.

---

## Catalogo (stato ottobre 2026)

Catalogo minimo giocabile (template vecchi eliminati):

| Tipo | Quantità |
|------|----------|
| Mostro (1–6 × 6 fazioni, 1 boss ciascuna) | 36 |
| Maledizione | 12 |
| Trappola (instant) | 6 |
| Aura | 2 |
| Terraforma | 2 |
| Mostrissimo | 5 |

Espansioni previste: più varietà per fazione, CLO +1 costo, sinergie di sottotipo, Indrazzico.

---

## Backend (locale)

```bash
cd backend
cp .env.example .env
# inserisci SUPABASE_URL e SUPABASE_SERVICE_KEY
npm install
npm run dev
