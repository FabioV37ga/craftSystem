import path from 'node:path';

export const POLICY_VERSION = 1;
const excludedSegments = new Set(['logs', 'crash-reports', 'debug', 'backups', 'manual-backups', '.mixin.out']);
const cacheNames = new Set(['cache', 'caches', '.cache', 'modernfix']);
const transientExtensions = new Set(['.log', '.tmp', '.lck', '.lock', '.pid']);
const secretPattern = /(^|[._-])(secret|token|credential|password|passwd)([._-]|$)|^\.env($|\.)/i;
const knownRoots = new Set([
  'world', 'config', 'defaultconfigs', 'configureddefaults', 'localconfigs', 'local', 'mods', 'plugins', 'kubejs',
  'libraries', 'journeymap', 'patchouli_books', 'quests_structures', 'server.properties', 'server-icon.png', 'eula.txt',
  'ops.json', 'whitelist.json', 'banned-ips.json', 'banned-players.json', 'usercache.json', 'usernamecache.json',
  'manifest.json', 'run.bat', 'run.sh', 'start_server.bat', 'start_server.sh', '2run.sh', 'user_jvm_args.txt',
]);

export function classify(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  const parts = normalized.split('/');
  const base = parts.at(-1);
  if (parts.some((part) => excludedSegments.has(part) || cacheNames.has(part.toLowerCase()))) {
    return { include: false, reason: 'regenerável, log ou backup anterior' };
  }
  if (transientExtensions.has(path.extname(base).toLowerCase())) return { include: false, reason: 'arquivo temporário ou log' };
  if (secretPattern.test(base)) return { include: false, reason: 'possível credencial ou segredo; revisão manual necessária', warning: true };
  return { include: true, unexpected: !knownRoots.has(parts[0]) && !/^world([_-].+)?$/i.test(parts[0]) && !/\.(jar|json|toml|cfg|conf|properties|txt|md|png|yml|yaml)$/i.test(parts[0]) };
}

export const policyDescription = {
  version: POLICY_VERSION,
  included: 'Mundos/dimensões, dados de jogadores, mods/plugins, configurações, scripts e binários da instalação.',
  excluded: [...excludedSegments, ...cacheNames, 'arquivos *.log/*.tmp/*.lock/*.pid', 'nomes que indiquem segredo/token/senha'],
};
