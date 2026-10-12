import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import { classify, policyDescription } from './policy.js';
import { inspectInstallation } from './metadata.js';
import { validatePackage } from './importer.js';

export async function exportServer(config, operation) {
  operation.update('preparing', 2, 'Inventariando a instalação.');
  const stat = await fsp.stat(config.serverRoot).catch(() => null);
  if (!stat?.isDirectory()) throw Object.assign(new Error('Diretório do servidor não encontrado.'), { status: 404 });
  const work = await fsp.mkdtemp(path.join(config.dataRoot, 'export-'));
  const payload = path.join(work, 'payload');
  await fsp.mkdir(payload);
  const paths = await walk(config.serverRoot);
  const included = paths.filter((item) => item.type === 'file' && classify(item.relative).include);
  const excluded = paths.filter((item) => item.type === 'file' && !classify(item.relative).include).map((item) => ({ path: item.relative, reason: classify(item.relative).reason }));
  const warnings = excluded.filter((item) => /segredo/.test(item.reason)).map((item) => `${item.path}: ${item.reason}`);
  const unexpected = included.filter((item) => classify(item.relative).unexpected).map((item) => item.relative);
  const files = [];
  let copied = 0;
  let temporary;
  try {
    for (const item of included) {
      const record = await stableCopy(config.serverRoot, payload, item.relative, config);
      files.push(record);
      copied++;
      operation.update('preparing', 5 + Math.floor((copied / Math.max(included.length, 1)) * 55), `Coletando ${copied} de ${included.length} arquivos.`);
    }
    const metadata = await inspectInstallation(config.serverRoot);
    const manifest = {
      format: 'craftsystem-host-switch', formatVersion: 1,
      server: metadata,
      export: { createdAt: new Date().toISOString(), sourceId: crypto.createHash('sha256').update(config.serverRoot).digest('hex').slice(0, 16), files },
      policy: policyDescription,
      report: { excluded, unexpected, warnings },
    };
    await fsp.writeFile(path.join(work, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    operation.update('packing', 65, 'Criando o pacote de migração.');
    await fsp.mkdir(path.join(config.dataRoot, 'exports'), { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const finalPath = path.join(config.dataRoot, 'exports', `TechRevolution-migration-${stamp}.zip`);
    temporary = `${finalPath}.${crypto.randomUUID()}.partial`;
    await makeArchive(work, temporary, files, operation);
    operation.update('validating', 92, 'Validando hashes do pacote finalizado.');
    await validatePackage(temporary, {
      extract: false,
      onProgress: ({ verified, total }) => operation.update('validating', 92 + Math.floor((verified / Math.max(total, 1)) * 7), `Revalidando ${verified} de ${total} arquivos do pacote.`),
    });
    await fsp.rename(temporary, finalPath);
    operation.result = { packagePath: finalPath, packageName: path.basename(finalPath), manifest, summary: { included: files.length, excluded: excluded.length, warnings: warnings.length, bytes: files.reduce((sum, file) => sum + file.size, 0) } };
    operation.update('ready', 100, 'Pacote validado e pronto para download.');
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
    if (temporary) await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function walk(root, current = '') {
  const output = [];
  const dir = path.join(root, current);
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) { output.push({ relative, type: 'symlink' }); continue; }
    if (entry.isDirectory()) output.push(...await walk(root, relative));
    else if (entry.isFile()) output.push({ relative, type: 'file' });
  }
  return output.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function stableCopy(sourceRoot, targetRoot, relative, config) {
  const source = path.join(sourceRoot, ...relative.split('/'));
  const target = path.join(targetRoot, ...relative.split('/'));
  const before = await fsp.stat(source);
  const hash = crypto.createHash('sha256');
  const meter = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await pipeline(fs.createReadStream(source), meter, fs.createWriteStream(target, { flags: 'wx', mode: before.mode & 0o777 }));
  if (config.afterFileCopied) await config.afterFileCopied(source, relative);
  const after = await fsp.stat(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Object.assign(new Error(`O arquivo mudou durante a exportação: ${relative}`), { code: 'SOURCE_CHANGED' });
  return { path: relative, size: before.size, sha256: hash.digest('hex'), mode: before.mode & 0o777 };
}

function makeArchive(work, outputPath, files, operation) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 1 }, forceZip64: true });
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let lastUpdate = 0;
    output.once('close', resolve); output.once('error', reject); archive.once('error', reject);
    archive.on('progress', ({ fs: progress }) => {
      const now = Date.now();
      if (now - lastUpdate < 250 && progress.processedBytes < totalBytes) return;
      lastUpdate = now;
      const ratio = Math.min(progress.processedBytes / Math.max(totalBytes, 1), 1);
      operation.update('packing', 65 + Math.floor(ratio * 26), `Compactando ${formatBytes(progress.processedBytes)} de ${formatBytes(totalBytes)}.`);
    });
    archive.pipe(output);
    archive.file(path.join(work, 'manifest.json'), { name: 'manifest.json' });
    for (const file of files) {
      archive.file(path.join(work, 'payload', ...file.path.split('/')), {
        name: `payload/${file.path}`,
        store: isAlreadyCompressed(file.path),
      });
    }
    archive.finalize();
  });
}

function isAlreadyCompressed(filePath) {
  return /\.(?:7z|bz2|gif|gz|jar|jpeg|jpg|mp3|mp4|ogg|png|rar|webm|webp|xz|zip)$/i.test(filePath);
}

function formatBytes(bytes) {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}
