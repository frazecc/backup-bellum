import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { apiRouter } from './api.js';

const app = express();
// Su Render l'indirizzo reale del client arriva dall'intestazione del proxy.
app.set('trust proxy', 1);

app.use(
  cors({
    origin: [
      'https://frazecc.github.io',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  }),
);

// Limite per indirizzo IP (S6): 600 richieste al minuto, controllo di salute escluso.
// Messo dopo cors() così il browser può leggere anche la risposta 429.
const ipHits = new Map<string, number[]>();
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/' || req.path === '/health') { next(); return; }
  const now = Date.now(), key = req.ip ?? 'sconosciuto';
  const recent = (ipHits.get(key) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= 600) {
    ipHits.set(key, recent);
    res.status(429).json({ error: 'Troppe richieste: aspetta qualche secondo e riprova' });
    return;
  }
  recent.push(now); ipHits.set(key, recent); next();
});
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of ipHits) if (!times.length || now - times[times.length - 1] > 60_000) ipHits.delete(key);
}, 60_000).unref();

app.use(express.json({ limit: '1mb' }));

app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    service: 'bellum-penumbrum-api',
    status: 'online',
  });
});

app.use('/', apiRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Endpoint non trovato',
  });
});

const port = Number(process.env.PORT ?? 3000);

app.listen(port, '0.0.0.0', () => {
  console.log(`Bellum Penumbrum API in ascolto sulla porta ${port}`);
});
