import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const file = process.env.DB_FILE ?? ':memory:';

const { app, thinResponses } = createApp({ file });

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[calibration-backend] listening on http://localhost:${port} ` +
      `(THIN_RESPONSES=${thinResponses ? '1' : '0'}, DB=${file})`,
  );
});
