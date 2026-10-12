import path from 'node:path';

const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function validateArchivePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\')) throw unsafe(name);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw unsafe(name);
  const parts = name.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || windowsReserved.test(part) || /[<>:"|?*]/.test(part) || /[. ]$/.test(part))) throw unsafe(name);
  const normalized = path.posix.normalize(name);
  if (normalized !== name) throw unsafe(name);
  return normalized;
}

function unsafe(name) {
  const error = new Error(`Caminho inseguro no pacote: ${String(name).slice(0, 160)}`);
  error.code = 'UNSAFE_PATH';
  return error;
}
