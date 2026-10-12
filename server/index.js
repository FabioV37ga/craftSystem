import { createApp } from './app.js';

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const { app, config } = await createApp();
const server = app.listen(port, host);
server.on('listening', () => {
  console.log(`CraftSystem disponível em http://${host}:${port}`);
  console.log(`Token do Host Switch: ${config.token ? `${config.dataRoot}/access-token (ou HOST_SWITCH_TOKEN)` : 'indisponível'}`);
});
server.on('error', (error) => {
  console.error(`Não foi possível iniciar o CraftSystem: ${error.code || error.message}`);
  process.exitCode = 1;
});
