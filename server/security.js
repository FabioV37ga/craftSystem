import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureToken(config) {
  if (config.token) return config.token;
  await fs.mkdir(config.dataRoot, { recursive: true, mode: 0o700 });
  const tokenFile = path.join(config.dataRoot, 'access-token');
  try {
    config.token = (await fs.readFile(tokenFile, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config.token = crypto.randomBytes(32).toString('base64url');
    await fs.writeFile(tokenFile, `${config.token}\n`, { mode: 0o600, flag: 'wx' });
  }
  return config.token;
}

export function requireToken(config) {
  return (req, res, next) => {
    const supplied = req.get('x-host-switch-token') || '';
    const expected = config.token || '';
    const valid = supplied.length === expected.length && expected.length > 0 &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!valid) return res.status(401).json({ error: 'Token de acesso ausente ou inválido.' });
    next();
  };
}

export function rejectCrossOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'Origem não autorizada.' });
  } catch {
    return res.status(403).json({ error: 'Origem inválida.' });
  }
  next();
}
