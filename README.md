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

## Come si gioca (riassunto)

- Vita iniziale **20**, partite brevi (~5 minuti).
- Griglia **3×3**. La casella centrale `(1,1)` dà **+1 attacco permanente** a ogni creatura che ci si trova, a **ogni upkeep** (tuo e dell’IA). Il bonus resta anche se la creatura si muove.
- Mazzo di **10 carte** auto-generato (niente deckbuilding):
  - 1 boss obbligatorio (Mostro 6 mana del colore principale)
  - almeno 1 carta per ogni costo **1, 2, 3, 4, 5, 6**
  - somma mana tra **25 e 35** (media ~2,5–3,5)
  - colori: ≥2 primary, ≥2 secondary, ≥1 tertiary
- **Mostrissimi**: 3 condivisi, max 1 evocato per turno. Si pagano sacrificando permanenti (anche stanchi o appena giocati).
- Movimento: 1 mana, 1 casella ortogonale. Entra stanca (tranne se ha *Iperattivo*).
- Si può muovere e poi attaccare nello stesso turno.

Fazioni (effetto fondamento delle comuni):

| Codice | Nome | Fondamento |
|--------|------|------------|
| CHI | Chiericanza | cura |
| INF | Infamia | pesca |
| PES | Pestilenza | scarta |
| BUL | Bullismo | danno |
| GRO | Grossanza | buff |
| CLO | Clownerie | versioni +1 costo delle altre |

---

## Backend (locale)

```bash
cd backend
cp .env.example .env
# inserisci SUPABASE_URL e SUPABASE_SERVICE_KEY
npm install
npm run dev
