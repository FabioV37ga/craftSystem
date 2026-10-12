import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { getConfig } from './config.js';
import { exportServer } from './exporter.js';
import { validatePackage, restorePackage } from './importer.js';
import { OperationStore } from './operations.js';
import { ensureToken, rejectCrossOrigin, requireToken } from './security.js';
import { getServerState } from './state.js';

export async function createApp(overrides = {}) {
  const config = getConfig(overrides);
  if (overrides.stateProvider) config.stateProvider = overrides.stateProvider;
  await fs.mkdir(path.join(config.dataRoot, 'uploads'), { recursive: true, mode: 0o700 });
  await ensureToken(config);
  const operations = new OperationStore();
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: '32kb' }));
  const tokenGuard = requireToken(config);

  app.get('/api/host-switch/exports/:id/download', rejectCrossOrigin, (req, res, next) => {
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    if (ticket && operations.validateDownloadTicket(ticket, req.params.id)) return sendExport(operations, req.params.id, req, res, next);
    tokenGuard(req, res, () => sendExport(operations, req.params.id, req, res, next));
  });

  app.get('/api/host-switch/packages/:name/download', rejectCrossOrigin, (req, res, next) => {
    const name = safePackageName(req.params.name);
    if (!name) return res.status(404).json({ error: 'Pacote não disponível.' });
    const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : '';
    if (ticket && operations.validateDownloadTicket(ticket, `package:${name}`)) return sendStoredExport(config, name, req, res, next);
    tokenGuard(req, res, () => sendStoredExport(config, name, req, res, next));
  });

  app.use('/api/host-switch', rejectCrossOrigin, requireToken(config));
  const upload = multer({ dest: path.join(config.dataRoot, 'uploads'), limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0 } });

  app.get('/api/host-switch/status', async (_req, res, next) => {
    try { res.json({ server: await getServerState(config), busy: operations.busy, operations: operations.list(), latestExport: await findLatestExport(config) }); } catch (error) { next(error); }
  });

  app.post('/api/host-switch/exports', (req, res, next) => {
    const operation = operations.create('export');
    try { operations.acquire(operation); } catch (error) { return next(error); }
    audit('export.started', operation);
    res.status(202).json(operations.public(operation));
    exportServer(config, operation).then(() => audit('export.ready', operation)).catch((error) => { fail(operation, error); audit('export.failed', operation); }).finally(() => operations.release(operation));
  });

  app.get('/api/host-switch/operations/:id', (req, res) => {
    const operation = operations.get(req.params.id);
    if (!operation) return res.status(404).json({ error: 'Operação não encontrada.' });
    res.json(operations.public(operation));
  });

  app.post('/api/host-switch/exports/:id/download-ticket', async (req, res) => {
    const operation = operations.get(req.params.id);
    if (!operation || operation.kind !== 'export' || operation.state !== 'ready' || !operation.result?.packagePath) return res.status(404).json({ error: 'Pacote não disponível.' });
    try {
      await fs.access(operation.result.packagePath);
      res.json({ ticket: operations.issueDownloadTicket(operation.id), expiresInSeconds: 900 });
    } catch {
      res.status(404).json({ error: 'O arquivo final não foi encontrado no armazenamento local.' });
    }
  });

  app.post('/api/host-switch/packages/:name/download-ticket', async (req, res) => {
    const name = safePackageName(req.params.name);
    if (!name) return res.status(404).json({ error: 'Pacote não disponível.' });
    try {
      await fs.access(path.join(config.dataRoot, 'exports', name));
      res.json({ ticket: operations.issueDownloadTicket(`package:${name}`), expiresInSeconds: 900 });
    } catch {
      res.status(404).json({ error: 'O arquivo final não foi encontrado no armazenamento local.' });
    }
  });

  app.post('/api/host-switch/imports', (req, res, next) => operations.busy ? res.status(409).json({ error: 'Já existe uma operação intensiva em andamento.' }) : next(), upload.single('package'), (req, res, next) => {
    if (!req.file) return res.status(400).json({ error: 'Selecione um pacote ZIP.' });
    const operation = operations.create('validation');
    try { operations.acquire(operation); } catch (error) { fs.rm(req.file.path, { force: true }).catch(() => {}); return next(error); }
    operation.packagePath = req.file.path;
    operation.originalName = path.basename(req.file.originalname).slice(0, 180);
    audit('validation.started', operation);
    res.status(202).json(operations.public(operation));
    operation.update('validating', 5, 'Validando manifesto, caminhos, tamanhos e hashes.');
    validatePackage(operation.packagePath, {
      targetRoot: config.serverRoot,
      onProgress: ({ verified, total }) => operation.update('validating', 5 + Math.floor((verified / Math.max(total, 1)) * 90), `Validando ${verified} de ${total} arquivos.`),
    })
      .then((report) => { operation.result = { report, originalName: operation.originalName }; operation.update('awaiting-confirmation', 100, 'Pacote válido. Revise a compatibilidade e confirme a restauração.'); audit('validation.completed', operation); })
      .catch((error) => { fail(operation, error); audit('validation.failed', operation); fs.rm(operation.packagePath, { force: true }).catch(() => {}); })
      .finally(() => operations.release(operation));
  });

  app.post('/api/host-switch/imports/:id/restore', async (req, res, next) => {
    const validation = operations.get(req.params.id);
    if (!validation || validation.kind !== 'validation' || validation.state !== 'awaiting-confirmation') return res.status(409).json({ error: 'Não há pacote validado aguardando confirmação.' });
    if (req.body?.confirmation !== 'RESTAURAR') return res.status(400).json({ error: 'Digite RESTAURAR para confirmar a substituição.' });
    const operation = operations.create('restore');
    try { operations.acquire(operation); } catch (error) { return next(error); }
    validation.state = 'consumed';
    audit('restore.started', operation);
    res.status(202).json(operations.public(operation));
    restorePackage(config, validation.packagePath, config.serverRoot, operation)
      .then((result) => { operation.result = result; audit('restore.completed', operation); })
      .catch((error) => { fail(operation, error); audit('restore.failed', operation); })
      .finally(() => { operations.release(operation); fs.rm(validation.packagePath, { force: true }).catch(() => {}); });
  });

  if (!overrides.apiOnly) {
    app.use(express.static(path.join(config.projectRoot, 'dist')));
    app.get('*splat', (_req, res) => res.sendFile(path.join(config.projectRoot, 'dist', 'index.html')));
  }
  app.use((error, _req, res, _next) => {
    const uploadTooLarge = error?.code === 'LIMIT_FILE_SIZE';
    res.status(uploadTooLarge ? 413 : error.status || 500).json({ error: uploadTooLarge ? 'O upload excede o limite configurado.' : safeMessage(error) });
  });
  return { app, config, operations };
}

function fail(operation, error) {
  operation.error = { code: error.code || 'OPERATION_FAILED', message: safeMessage(error) };
  operation.update('failed', operation.progress, operation.error.message);
}

function safeMessage(error) {
  if (error?.status && error.status < 500) return error.message;
  if (['SERVER_RUNNING', 'SERVER_STATE_UNKNOWN', 'SOURCE_CHANGED', 'INVALID_PACKAGE', 'INCOMPATIBLE', 'OPERATION_CONFLICT'].includes(error?.code)) return error.message;
  return 'A operação falhou. Consulte o log local do serviço para obter detalhes.';
}

function audit(event, operation) {
  console.info(JSON.stringify({ time: new Date().toISOString(), event, operationId: operation.id, state: operation.state, errorCode: operation.error?.code }));
}

async function sendExport(operations, id, req, res, next) {
  const operation = operations.get(id);
  if (!operation || operation.kind !== 'export' || operation.state !== 'ready' || !operation.result?.packagePath) return res.status(404).json({ error: 'Pacote não disponível.' });
  return streamPackage(operation.result.packagePath, operation.result.packageName, req, res, next);
}

async function sendStoredExport(config, name, req, res, next) {
  const packagePath = path.join(config.dataRoot, 'exports', name);
  return streamPackage(packagePath, name, req, res, next);
}

async function streamPackage(packagePath, name, req, res, next) {
  try {
    const stat = await fs.stat(packagePath);
    if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    const range = parseRange(req.get('range'), stat.size);
    res.attachment(name);
    res.set('accept-ranges', 'bytes');
    res.set('cache-control', 'private, no-store');
    if (range?.invalid) {
      res.status(416).set('content-range', `bytes */${stat.size}`).end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? stat.size - 1;
    const length = end - start + 1;
    res.status(range ? 206 : 200).set('content-length', String(length));
    if (range) res.set('content-range', `bytes ${start}-${end}/${stat.size}`);
    if (req.method === 'HEAD') return res.end();
    const stream = (await import('node:fs')).createReadStream(packagePath, { start, end });
    stream.once('error', (error) => res.headersSent ? res.destroy(error) : next(error));
    res.once('close', () => { if (!stream.closed) stream.destroy(); });
    stream.pipe(res);
  } catch {
    res.status(404).json({ error: 'O arquivo final não foi encontrado no armazenamento local.' });
  }
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

async function findLatestExport(config) {
  const directory = path.join(config.dataRoot, 'exports');
  const names = await fs.readdir(directory).catch(() => []);
  const packages = await Promise.all(names.map(async (name) => {
    if (!safePackageName(name)) return null;
    const stat = await fs.stat(path.join(directory, name)).catch(() => null);
    return stat?.isFile() ? { packageName: name, bytes: stat.size, createdAt: stat.mtime.toISOString(), modified: stat.mtimeMs } : null;
  }));
  const latest = packages.filter(Boolean).sort((a, b) => b.modified - a.modified)[0];
  if (!latest) return null;
  delete latest.modified;
  return latest;
}

function safePackageName(value) {
  return /^TechRevolution-migration-\d{8}-\d{6}\.zip$/.test(value) ? value : null;
}
