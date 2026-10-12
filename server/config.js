import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');

export function getConfig(overrides = {}) {
  const serverRoot = path.resolve(overrides.serverRoot || process.env.HOST_SWITCH_SERVER_ROOT || path.join(projectRoot, '..', 'server'));
  const dataRoot = path.resolve(overrides.dataRoot || process.env.HOST_SWITCH_DATA_ROOT || path.join(projectRoot, '.host-switch'));
  return {
    projectRoot,
    serverRoot,
    dataRoot,
    maxUploadBytes: Number(overrides.maxUploadBytes || process.env.HOST_SWITCH_MAX_UPLOAD_BYTES || 20 * 1024 ** 3),
    statusCommand: overrides.statusCommand ?? process.env.HOST_SWITCH_STATUS_COMMAND,
    statusArgs: overrides.statusArgs ?? parseArgs(process.env.HOST_SWITCH_STATUS_ARGS),
    mcsUrl: overrides.mcsUrl ?? process.env.HOST_SWITCH_MCS_URL,
    mcsApiKey: overrides.mcsApiKey ?? process.env.HOST_SWITCH_MCS_API_KEY,
    mcsDaemonId: overrides.mcsDaemonId ?? process.env.HOST_SWITCH_MCS_DAEMON_ID,
    mcsInstanceId: overrides.mcsInstanceId ?? process.env.HOST_SWITCH_MCS_INSTANCE_ID,
    token: overrides.token ?? process.env.HOST_SWITCH_TOKEN,
  };
}

function parseArgs(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
  } catch {
    return [];
  }
}
