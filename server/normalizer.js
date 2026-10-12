import fsp from 'node:fs/promises';
import path from 'node:path';
import { exportServer } from './exporter.js';
import { classify } from './policy.js';
import { validateArchivePath } from './paths.js';
import { extractEntry, scanZip, withZipEntries } from './zip.js';

const MAX_FILES = 500_000;
const MAX_EXPANDED = 200 * 1024 ** 3;
const serverMarkers = /^(?:server\.properties|eula\.txt|user_jvm_args\.txt|minecraft_server\.jar|run\.(?:bat|sh)|start_server\.(?:bat|sh)|mods\/|plugins\/|config\/|world(?:[_-][^/]+)?\/)/i;

export async function normalizeCommonZip(config, archivePath, originalName, operation) {
  const work = await fsp.mkdtemp(path.join(config.dataRoot, 'normalize-'));
  try {
    operation.update('inspecting', 2, 'Inspecionando a estrutura do ZIP comum.');
    const scanned = await scanZip(archivePath);
    const sourceFiles = scanned.filter((item) => !item.directory);
    if (!sourceFiles.length) throw invalid('O ZIP comum não contém arquivos.');
    if (sourceFiles.length > MAX_FILES) throw invalid('O ZIP comum contém arquivos demais.');
    const expandedBytes = sourceFiles.reduce((sum, item) => sum + item.entry.uncompressedSize, 0);
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED) throw invalid('O conteúdo expandido excede o limite permitido.');
    if ((sourceFiles.some((item) => item.entry.fileName === 'manifest.json') && sourceFiles.some((item) => item.entry.fileName.startsWith('payload/'))) || sourceFiles.some((item) => item.entry.fileName === '.craftsystem/manifest.json')) {
      throw invalid('Este arquivo já é um pacote CraftSystem. Use a opção Validar pacote.');
    }

    const meaningfulNames = sourceFiles.map((item) => item.entry.fileName).filter((name) => !name.toLocaleLowerCase('en-US').startsWith('__macosx/') && !/[\/](?:\.ds_store|thumbs\.db|desktop\.ini)$/i.test(name));
    const prefix = detectWrapper(meaningfulNames.length ? meaningfulNames : sourceFiles.map((item) => item.entry.fileName));
    const mapped = new Map();
    const seen = new Set();
    const excluded = [];
    for (const item of sourceFiles) {
      if (prefix && !item.entry.fileName.startsWith(prefix)) continue;
      const relative = prefix ? item.entry.fileName.slice(prefix.length) : item.entry.fileName;
      validateArchivePath(relative);
      const folded = relative.toLocaleLowerCase('en-US');
      if (seen.has(folded)) throw invalid(`Caminho duplicado após remover a pasta-raiz: ${relative}`);
      seen.add(folded);
      const decision = classify(relative);
      if (!decision.include) excluded.push({ path: relative, reason: decision.reason });
      else mapped.set(item.entry.fileName, { relative, entry: item.entry });
    }
    if (!mapped.size) throw invalid('Nenhum arquivo utilizável foi encontrado após aplicar a política de exportação.');
    const selectedBytes = [...mapped.values()].reduce((sum, item) => sum + item.entry.uncompressedSize, 0);
    const archiveBytes = (await fsp.stat(archivePath)).size;
    const disk = await fsp.statfs(config.dataRoot);
    const available = Number(disk.bavail) * Number(disk.bsize);
    const reserve = 64 * 1024 ** 2;
    if (Number.isFinite(available) && (available < selectedBytes + reserve || available + archiveBytes < (selectedBytes * 2) + reserve)) {
      throw Object.assign(new Error('Espaço insuficiente para extrair e gerar o pacote padronizado.'), { code: 'INSUFFICIENT_SPACE', status: 409 });
    }

    let extracted = 0;
    await withZipEntries(archivePath, async (zip, entry) => {
      const item = mapped.get(entry.fileName);
      if (!item) return;
      const destination = path.resolve(work, ...item.relative.split('/'));
      if (!destination.startsWith(`${path.resolve(work)}${path.sep}`)) throw invalid('Tentativa de extração fora da área temporária.');
      await extractEntry(zip, entry, destination);
      const archivedMode = (entry.externalFileAttributes >>> 16) & 0o777;
      const executable = Boolean(archivedMode & 0o111) || item.relative.toLocaleLowerCase('en-US').endsWith('.sh');
      if (process.platform !== 'win32') await fsp.chmod(destination, executable ? 0o755 : 0o644);
      extracted++;
      operation.update('extracting', 5 + Math.floor((extracted / mapped.size) * 30), `Extraindo ${extracted} de ${mapped.size} arquivos permitidos.`);
    });
    await fsp.rm(archivePath, { force: true });

    const exportOperation = scaleOperation(operation, 35, 100);
    await exportServer({ ...config, serverRoot: work, immutableSource: true, sourceReport: { excluded, originalName, wrapper: prefix.replace(/\/$/, '') || null } }, exportOperation);
    operation.result = { ...operation.result, source: { originalName, wrapper: prefix.replace(/\/$/, '') || null, inputFiles: sourceFiles.length, excludedBeforeExtraction: excluded.length } };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(archivePath, { force: true }).catch(() => {});
  }
}

function detectWrapper(names) {
  const first = names[0]?.split('/')[0];
  if (!first || !names.every((name) => name.startsWith(`${first}/`))) return '';
  const stripped = names.map((name) => name.slice(first.length + 1));
  return stripped.some((name) => serverMarkers.test(name)) ? `${first}/` : '';
}

function scaleOperation(operation, start, end) {
  return {
    update(state, progress, message) {
      const scaled = start + Math.floor((Math.max(0, Math.min(progress, 100)) / 100) * (end - start));
      operation.update(state, scaled, message);
    },
    get result() { return operation.result; },
    set result(value) { operation.result = value; },
  };
}

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_PACKAGE', status: 422 });
}
