import express from 'express';

const app = express();
const port = Number(process.env.DEMO_YOPM_PORT ?? 5175);

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'demo-yopm' });
});

app.get('/', (_req, res) => {
  res.type('html').send('<h1>YoPM Demo App</h1><p>Running with YoCore workspace setup.</p>');
});

app.listen(port, () => {
  // Keep startup log minimal so it is easy to spot in turbo output.
  // eslint-disable-next-line no-console
  console.log(`[demo-yopm] listening on http://localhost:${port}`);
});
