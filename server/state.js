import { spawn } from 'node:child_process';

export async function getServerState(config) {
  if (config.stateProvider) return config.stateProvider();
  if (config.mcsUrl && config.mcsApiKey && config.mcsDaemonId && config.mcsInstanceId) return getMcsState(config);
  if (!config.statusCommand) {
    return {
      state: 'unknown',
      source: 'not-configured',
      message: 'A verificação do MCSManager não foi configurada. Configure as credenciais/IDs do MCSManager ou HOST_SWITCH_STATUS_COMMAND antes de restaurar.',
    };
  }

  return new Promise((resolve) => {
    const child = spawn(config.statusCommand, config.statusArgs, {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      timeout: 15_000,
    });
    child.once('error', () => resolve({ state: 'unknown', source: 'status-command', message: 'Não foi possível executar o verificador da instância.' }));
    child.once('close', (code) => {
      if (code === 0) resolve({ state: 'stopped', source: 'status-command', message: 'Instância confirmada como parada.' });
      else if (code === 10) resolve({ state: 'running', source: 'status-command', message: 'A instância está ligada. Desligue-a normalmente pelo MCSManager.' });
      else resolve({ state: 'unknown', source: 'status-command', message: 'O verificador não conseguiu confirmar o estado da instância.' });
    });
  });
}

async function getMcsState(config) {
  try {
    const endpoint = new URL('/api/instance', config.mcsUrl);
    endpoint.searchParams.set('daemonId', config.mcsDaemonId);
    endpoint.searchParams.set('uuid', config.mcsInstanceId);
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', 'x-request-api-key': config.mcsApiKey } });
    if (!response.ok) throw new Error('status HTTP inesperado');
    const body = await response.json();
    const status = body?.data?.status;
    if (status === 0) return { state: 'stopped', source: 'mcsmanager', message: 'MCSManager confirmou que a instância está parada.' };
    if ([-1, 1, 2, 3].includes(status)) return { state: 'running', source: 'mcsmanager', message: 'A instância está ligada ou em transição. Desligue-a normalmente pelo MCSManager.' };
    return { state: 'unknown', source: 'mcsmanager', message: 'O MCSManager respondeu, mas o estado da instância não é reconhecido.' };
  } catch {
    return { state: 'unknown', source: 'mcsmanager', message: 'Não foi possível confirmar o estado da instância pelo MCSManager.' };
  }
}

export async function requireStopped(config) {
  const status = await getServerState(config);
  if (status.state !== 'stopped') {
    const error = new Error(status.message);
    error.code = status.state === 'running' ? 'SERVER_RUNNING' : 'SERVER_STATE_UNKNOWN';
    error.status = 409;
    throw error;
  }
  return status;
}
