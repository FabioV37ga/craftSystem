import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { inspectInstallation } from './metadata.js';
import { validateArchivePath } from './paths.js';
import { extractEntry, readEntryBuffer, scanZip, withZipEntries } from './zip.js';
import { requireStopped } from './state.js';

const MAX_FILES = 500_000;
const MAX_MANIFEST = 20 * 1024 * 1024;
const MAX_EXPANDED = 200 * 1024 ** 3;

export async function validatePackage(packagePath, options = {}) {
  const archiveStat = await fsp.stat(packagePath);
  const scanned = await scanZip(packagePath);
  if (scanned.length > MAX_FILES) throw invalid('O pacote contém arquivos demais.');
  const expanded = scanned.reduce((sum, item) => sum + item.entry.uncompressedSize, 0);
  if (expanded > (options.maxExpandedBytes || MAX_EXPANDED)) throw invalid('O conteúdo expandido excede o limite permitido.');
  const manifestItem = scanned.find((item) => item.entry.fileName === 'manifest.json');
  if (!manifestItem || manifestItem.directory) throw invalid('Manifesto ausente.');
  let manifest;
  await withZipEntries(packagePath, async (zip, entry) => {
    if (entry.fileName === 'manifest.json') {
      try { manifest = JSON.parse((await readEntryBuffer(zip, entry, MAX_MANIFEST)).toString('utf8')); }
      catch { throw invalid('Manifesto JSON inválido.'); }
    }
  });
  validateManifest(manifest);
  const expected = new Map(manifest.export.files.map((file) => [`payload/${file.path}`, file]));
  const actual = scanned.filter((item) => !item.directory && item.entry.fileName !== 'manifest.json');
  for (const item of actual) if (!expected.has(item.entry.fileName)) throw invalid(`Arquivo não declarado no manifesto: ${item.entry.fileName}`);
  if (actual.length !== expected.size) throw invalid('Há arquivos ausentes no pacote.');
  let verified = 0;
  await withZipEntries(packagePath, async (zip, entry) => {
    const record = expected.get(entry.fileName);
    if (!record) return;
    if (entry.uncompressedSize !== record.size) throw invalid(`Tamanho inválido: ${record.path}`);
    const hash = crypto.createHash('sha256');
    const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value)));
    for await (const chunk of stream) hash.update(chunk);
    if (hash.digest('hex') !== record.sha256) throw invalid(`Hash inválido: ${record.path}`);
    verified++;
    options.onProgress?.({ phase: 'hashing', verified, total: expected.size, path: record.path });
  });
  if (verified !== expected.size) throw invalid('A validação não encontrou todos os arquivos declarados.');
  const compatibility = options.targetRoot ? await compareCompatibility(manifest.server, await inspectInstallation(options.targetRoot)) : { status: 'not-checked', blockers: [], warnings: ['Compatibilidade do destino ainda não verificada.'] };
  return { valid: true, archiveBytes: archiveStat.size, expandedBytes: expanded, fileCount: verified, manifest, compatibility };
}

export async function restorePackage(config, packagePath, targetRoot, operation) {
  await requireStopped(config);
  operation?.update('validating', 5, 'Validando novamente o pacote.');
  const report = await validatePackage(packagePath, { targetRoot });
  if (report.compatibility.blockers.length) throw Object.assign(new Error(`Incompatibilidade impeditiva: ${report.compatibility.blockers.join('; ')}`), { code: 'INCOMPATIBLE', status: 409 });
  const parent = path.dirname(targetRoot);
  await fsp.mkdir(parent, { recursive: true });
  const disk = await fsp.statfs(parent);
  const available = Number(disk.bavail) * Number(disk.bsize);
  if (Number.isFinite(available) && available < report.expandedBytes) {
    throw Object.assign(new Error(`Espaço insuficiente: são necessários ao menos ${report.expandedBytes} bytes livres para a restauração temporária.`), { code: 'INSUFFICIENT_SPACE', status: 409 });
  }
  const staging = await fsp.mkdtemp(path.join(parent, '.host-switch-restore-'));
  let backup = null;
  try {
    operation?.update('restoring', 20, 'Extraindo para área temporária segura.');
    await extractPayload(packagePath, staging, report.manifest);
    await verifyExtracted(staging, report.manifest);
    await requireStopped(config);
    const existing = await fsp.stat(targetRoot).catch(() => null);
    if (existing) {
      backup = path.join(parent, `${path.basename(targetRoot)}.host-switch-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      await fsp.rename(targetRoot, backup);
    }
    try {
      if (config.beforeCommit) await config.beforeCommit({ staging, targetRoot, backup });
      await fsp.rename(staging, targetRoot);
    } catch (error) {
      if (backup) await fsp.rename(backup, targetRoot).catch(() => {});
      throw error;
    }
    operation?.update('completed', 100, 'Restauração concluída. O servidor permanece parado.');
    return { report, backupPath: backup, targetRoot, serverStarted: false };
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function extractPayload(packagePath, staging, manifest) {
  const allowed = new Set(manifest.export.files.map((file) => `payload/${file.path}`));
  await withZipEntries(packagePath, async (zip, entry) => {
    if (entry.fileName.endsWith('/') || entry.fileName === 'manifest.json') return;
    if (!allowed.has(entry.fileName)) throw invalid(`Entrada inesperada: ${entry.fileName}`);
    const relative = entry.fileName.slice('payload/'.length);
    validateArchivePath(relative);
    const destination = path.resolve(staging, ...relative.split('/'));
    if (!destination.startsWith(`${path.resolve(staging)}${path.sep}`)) throw invalid('Tentativa de escrita fora do destino.');
    await extractEntry(zip, entry, destination);
  });
}

async function verifyExtracted(staging, manifest) {
  for (const record of manifest.export.files) {
    const file = path.join(staging, ...record.path.split('/'));
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size !== record.size) throw invalid(`Falha ao verificar arquivo extraído: ${record.path}`);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== record.sha256) throw invalid(`Hash pós-extração inválido: ${record.path}`);
    if (record.mode !== undefined && process.platform !== 'win32') await fsp.chmod(file, record.mode);
  }
}

function validateManifest(value) {
  if (!value || value.format !== 'craftsystem-host-switch' || value.formatVersion !== 1) throw invalid('Formato ou versão do manifesto não suportado.');
  if (!value.server || !value.export || !Array.isArray(value.export.files) || typeof value.export.createdAt !== 'string') throw invalid('Estrutura do manifesto inválida.');
  const seen = new Set();
  for (const file of value.export.files) {
    if (!file || typeof file.path !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw invalid('Registro de arquivo inválido no manifesto.');
    if (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)) throw invalid('Permissão de arquivo inválida no manifesto.');
    validateArchivePath(file.path);
    const folded = file.path.toLocaleLowerCase('en-US');
    if (seen.has(folded)) throw invalid(`Caminho duplicado no manifesto: ${file.path}`);
    seen.add(folded);
  }
}

async function compareCompatibility(source, target) {
  const blockers = [];
  const warnings = [];
  for (const field of ['minecraftVersion', 'software', 'softwareVersion']) {
    if (source?.[field] && target?.[field] && source[field] !== target[field]) blockers.push(`${field}: pacote ${source[field]}, destino ${target[field]}`);
    else if (!source?.[field] || !target?.[field]) warnings.push(`${field} não pôde ser verificado nos dois lados`);
  }
  if (source?.javaVersion && target?.javaVersion && source.javaVersion.split('.')[0] !== target.javaVersion.split('.')[0]) warnings.push(`Java difere: pacote ${source.javaVersion}, destino ${target.javaVersion}`);
  else if (!source?.javaVersion || !target?.javaVersion) warnings.push('Java não pôde ser verificado nos dois lados');
  for (const kind of ['mods', 'plugins']) {
    const sourceSet = new Set(source?.components?.[kind] || []);
    const targetSet = new Set(target?.components?.[kind] || []);
    if (sourceSet.size && targetSet.size) {
      const missing = [...sourceSet].filter((name) => !targetSet.has(name));
      if (missing.length) warnings.push(`${missing.length} ${kind} do pacote diferem do destino (eles serão restaurados)`);
    }
  }
  return { status: blockers.length ? 'incompatible' : warnings.length ? 'unknown' : 'compatible', blockers, warnings };
}

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_PACKAGE', status: 422 });
}
