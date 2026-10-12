import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import archiver from 'archiver';
import request from 'supertest';
import { createApp } from '../server/app.js';
import { exportServer } from '../server/exporter.js';
import { validatePackage, restorePackage } from '../server/importer.js';
import { normalizeCommonZip } from '../server/normalizer.js';
import { OperationStore } from '../server/operations.js';
import { validateArchivePath } from '../server/paths.js';
import { scanZip } from '../server/zip.js';

const stopped = async () => ({ state: 'stopped', source: 'test', message: 'parado' });
const running = async () => ({ state: 'running', source: 'test', message: 'ligado' });
const operation = () => ({ progress: 0, update(state, progress, message) { this.state = state; this.progress = progress; this.message = message; } });

test('exporta estrutura válida, arquivo oculto e hashes verificáveis', async (t) => {
  const root = await fixture(t);
  await fsp.mkdir(path.join(root.server, 'world', 'playerdata'), { recursive: true });
  await fsp.writeFile(path.join(root.server, 'world', 'level.dat'), 'world-state');
  await fsp.writeFile(path.join(root.server, '.gitattributes'), 'hidden-relevant');
  await fsp.mkdir(path.join(root.server, 'logs'));
  await fsp.writeFile(path.join(root.server, 'logs', 'latest.log'), 'excluded');
  const op = operation();
  await exportServer({ ...root, stateProvider: stopped }, op);
  const report = await validatePackage(op.result.packagePath);
  const archiveEntries = (await scanZip(op.result.packagePath)).filter((item) => !item.directory).map((item) => item.entry.fileName);
  assert.equal(report.valid, true);
  assert.equal(report.manifest.formatVersion, 2);
  assert(archiveEntries.includes('.craftsystem/manifest.json'));
  assert(archiveEntries.includes('world/level.dat'));
  assert(!archiveEntries.some((name) => name.startsWith('payload/')));
  assert(report.manifest.export.files.some((file) => file.path === '.gitattributes'));
  assert(!report.manifest.export.files.some((file) => file.path.startsWith('logs/')));
});

test('exportação não depende do estado do servidor', async (t) => {
  const root = await fixture(t);
  await fsp.writeFile(path.join(root.server, 'server.properties'), 'motd=test');
  const op = operation();
  await exportServer({ ...root, stateProvider: async () => { throw new Error('não deve consultar o estado'); } }, op);
  assert.equal(op.state, 'ready');
});

test('normaliza ZIP comum com pasta-raiz e aplica a política de arquivos', async (t) => {
  const root = await fixture(t);
  const file = await rawZip(root.base, {
    'Servidor Completo/server.properties': 'motd=test',
    'Servidor Completo/world/level.dat': 'world-state',
    'Servidor Completo/logs/latest.log': 'excluded',
  });
  const op = operation();
  await normalizeCommonZip(root, file, 'servidor-completo.zip', op);
  assert.equal(op.state, 'ready');
  const report = await validatePackage(op.result.packagePath);
  assert(report.manifest.export.files.some((entry) => entry.path === 'server.properties'));
  assert(report.manifest.export.files.some((entry) => entry.path === 'world/level.dat'));
  assert(!report.manifest.export.files.some((entry) => entry.path.startsWith('Servidor Completo/')));
  assert(!report.manifest.export.files.some((entry) => entry.path.startsWith('logs/')));
  assert.equal(report.manifest.report.source.wrapper, 'Servidor Completo');
  assert(report.manifest.report.excluded.some((entry) => entry.path === 'logs/latest.log'));
});

test('rejeita manifesto inválido, hash incorreto e arquivo ausente', async (t) => {
  const root = await fixture(t);
  const badManifest = await zip(t, root.base, { manifest: { hello: 'world' }, entries: {} });
  await assert.rejects(validatePackage(badManifest), /Formato ou versão/);
  const badHash = await packageZip(t, root.base, { 'world/a.dat': 'a' }, { hashOverride: '0'.repeat(64) });
  await assert.rejects(validatePackage(badHash), /Hash inválido/);
  const missing = await packageZip(t, root.base, { 'world/a.dat': 'a' }, { omitPayload: true });
  await assert.rejects(validatePackage(missing), /ausentes/);
});

test('rejeita pacote corrompido', async (t) => {
  const root = await fixture(t);
  const file = path.join(root.base, 'corrupt.zip');
  await fsp.writeFile(file, 'not-a-zip');
  await assert.rejects(validatePackage(file));
});

test('rejeita traversal, caminhos absolutos, nomes perigosos e colisões do Windows', () => {
  for (const value of ['../evil', '/absolute', 'C:/boot.ini', 'payload\\evil', 'CON', 'name.', 'a:b']) assert.throws(() => validateArchivePath(value));
  assert.equal(validateArchivePath('world/playerdata/user.dat'), 'world/playerdata/user.dat');
});

test('rejeita caminho malicioso declarado dentro do pacote', async (t) => {
  const root = await fixture(t);
  const manifest = validManifest([{ path: '../outside.dat', size: 1, sha256: crypto.createHash('sha256').update('x').digest('hex') }]);
  const file = await zip(t, root.base, { manifest, entries: { 'payload/safe.dat': 'x' } });
  await assert.rejects(validatePackage(file), /Caminho inseguro/);
});

test('rejeita colisões de nomes no manifesto sem diferenciar maiúsculas', async (t) => {
  const root = await fixture(t);
  const manifest = validManifest([
    record('mods/A.jar', 'a'),
    record('mods/a.jar', 'b'),
  ]);
  const file = await zip(t, root.base, { manifest, entries: { 'payload/mods/A.jar': 'a', 'payload/mods/a.jar': 'b' } });
  await assert.rejects(validatePackage(file), /duplicada|colisão/i);
});

test('bloqueia upload excessivo', async (t) => {
  const root = await fixture(t);
  const { app } = await createApp({ ...root, token: 'test-token', maxUploadBytes: 8, stateProvider: stopped });
  const file = path.join(root.base, 'large.zip'); await fsp.writeFile(file, '123456789');
  const response = await request(app).post('/api/host-switch/imports').set('x-host-switch-token', 'test-token').attach('package', file);
  assert.equal(response.status, 413);
});

test('upload de pacote gerado localmente produz relatório de validação', async (t) => {
  const root = await fixture(t);
  const file = await packageZip(t, root.base, { 'world/level.dat': 'world-state' });
  const { app, operations } = await createApp({ ...root, token: 'test-token', stateProvider: stopped });
  const response = await request(app).post('/api/host-switch/imports').set('x-host-switch-token', 'test-token').attach('package', file);
  assert.equal(response.status, 202);
  let validation;
  for (let attempt = 0; attempt < 100; attempt++) {
    validation = operations.get(response.body.id);
    if (['awaiting-confirmation', 'failed'].includes(validation.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(validation.state, 'awaiting-confirmation');
  assert.equal(validation.result.report.valid, true);
  assert.equal(validation.result.report.fileCount, 1);
});

test('upload em blocos evita requisição única para pacote grande', async (t) => {
  const root = await fixture(t);
  const file = await packageZip(t, root.base, { 'world/level.dat': 'world-state' });
  const contents = await fsp.readFile(file);
  const { app, operations } = await createApp({ ...root, token: 'test-token', stateProvider: stopped });
  const initialized = await request(app).post('/api/host-switch/imports/uploads').set('x-host-switch-token', 'test-token').send({ name: 'migration.zip', size: contents.length });
  assert.equal(initialized.status, 201);
  assert(initialized.body.chunkBytes > 0);
  const uploaded = await request(app)
    .put(`/api/host-switch/imports/uploads/${initialized.body.id}/chunks/0`)
    .set('x-host-switch-token', 'test-token')
    .set('content-type', 'application/octet-stream')
    .send(contents);
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.received, contents.length);
  const completed = await request(app).post(`/api/host-switch/imports/uploads/${initialized.body.id}/complete`).set('x-host-switch-token', 'test-token');
  assert.equal(completed.status, 202);
  let validation;
  for (let attempt = 0; attempt < 100; attempt++) {
    validation = operations.get(completed.body.id);
    if (['awaiting-confirmation', 'failed'].includes(validation.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(validation.state, 'awaiting-confirmation');
  assert.equal(validation.result.report.valid, true);
});

test('upload em blocos transforma ZIP comum em pacote pronto para extração', async (t) => {
  const root = await fixture(t);
  const file = await rawZip(root.base, { 'Servidor/server.properties': 'motd=test', 'Servidor/world/level.dat': 'world-state' });
  const contents = await fsp.readFile(file);
  const { app, operations } = await createApp({ ...root, token: 'test-token', stateProvider: stopped });
  const initialized = await request(app).post('/api/host-switch/imports/uploads').set('x-host-switch-token', 'test-token').send({ name: 'servidor.zip', size: contents.length, purpose: 'normalization' });
  assert.equal(initialized.status, 201);
  assert.equal((await request(app)
    .put(`/api/host-switch/imports/uploads/${initialized.body.id}/chunks/0`)
    .set('x-host-switch-token', 'test-token')
    .set('content-type', 'application/octet-stream')
    .send(contents)).status, 200);
  const completed = await request(app).post(`/api/host-switch/imports/uploads/${initialized.body.id}/complete`).set('x-host-switch-token', 'test-token');
  assert.equal(completed.status, 202);
  let normalized;
  for (let attempt = 0; attempt < 100; attempt++) {
    normalized = operations.get(completed.body.id);
    if (['ready', 'failed'].includes(normalized.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(normalized.state, 'ready');
  assert.equal(normalized.result.manifest.formatVersion, 2);
  assert.equal((await request(app).post(`/api/host-switch/exports/${normalized.id}/download-ticket`).set('x-host-switch-token', 'test-token')).status, 200);
});

test('API exige token, confirmação explícita e impede operações concorrentes', async (t) => {
  const root = await fixture(t);
  const { app, operations } = await createApp({ ...root, token: 'test-token', stateProvider: stopped });
  assert.equal((await request(app).get('/api/host-switch/status')).status, 401);
  const validation = operations.create('validation'); validation.state = 'awaiting-confirmation'; validation.packagePath = 'unused';
  assert.equal((await request(app).post(`/api/host-switch/imports/${validation.id}/restore`).set('x-host-switch-token', 'test-token').send({ confirmation: 'sim' })).status, 400);
  const first = operations.create('export'); operations.acquire(first);
  assert.throws(() => operations.acquire(operations.create('restore')), { code: 'OPERATION_CONFLICT' });
});

test('download usa ticket temporário e permite verificação e retomada', async (t) => {
  const root = await fixture(t);
  await fsp.writeFile(path.join(root.server, 'server.properties'), 'motd=test');
  const { app, operations } = await createApp({ ...root, token: 'test-token', stateProvider: stopped });
  const started = await request(app).post('/api/host-switch/exports').set('x-host-switch-token', 'test-token');
  let exported;
  for (let attempt = 0; attempt < 100; attempt++) {
    exported = operations.get(started.body.id);
    if (['ready', 'failed'].includes(exported.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(exported.state, 'ready');
  const ticketResponse = await request(app).post(`/api/host-switch/exports/${exported.id}/download-ticket`).set('x-host-switch-token', 'test-token');
  assert.equal(ticketResponse.status, 200);
  const downloadUrl = `/api/host-switch/exports/${exported.id}/download?ticket=${encodeURIComponent(ticketResponse.body.ticket)}`;
  const head = await request(app).head(downloadUrl);
  assert.equal(head.status, 200);
  const download = await request(app).get(downloadUrl);
  assert.equal(download.status, 200);
  assert.match(download.headers['content-type'], /application\/zip/);
  assert.equal((await request(app).get(downloadUrl).set('range', 'bytes=0-15')).status, 206);
  const { app: restartedApp } = await createApp({ ...root, token: 'test-token', stateProvider: stopped });
  const status = await request(restartedApp).get('/api/host-switch/status').set('x-host-switch-token', 'test-token');
  assert.equal(status.body.latestExport.packageName, exported.result.packageName);
  const storedTicket = await request(restartedApp).post(`/api/host-switch/packages/${encodeURIComponent(status.body.latestExport.packageName)}/download-ticket`).set('x-host-switch-token', 'test-token');
  const storedDownload = await request(restartedApp).get(`/api/host-switch/packages/${encodeURIComponent(status.body.latestExport.packageName)}/download?ticket=${encodeURIComponent(storedTicket.body.ticket)}`);
  assert.equal(storedDownload.status, 200);
});

test('detecta incompatibilidade conhecida', async (t) => {
  const root = await fixture(t);
  await fsp.writeFile(path.join(root.server, 'manifest.json'), JSON.stringify({ minecraftVersion: '1.20.1' }));
  const file = await packageZip(t, root.base, { 'world/a.dat': 'a' }, { minecraftVersion: '1.19.2' });
  const report = await validatePackage(file, { targetRoot: root.server });
  assert.equal(report.compatibility.status, 'incompatible');
});

test('restauração preserva backup, mantém servidor parado e faz rollback em falha', async (t) => {
  const root = await fixture(t);
  await fsp.writeFile(path.join(root.server, 'old.txt'), 'old');
  const file = await packageZip(t, root.base, { 'world/new.dat': 'new', 'start_server.sh': '#!/bin/sh\n' });
  const config = { ...root, stateProvider: stopped, beforeCommit: async () => { throw new Error('falha simulada'); } };
  await assert.rejects(restorePackage(config, file, root.server, operation()), /falha simulada/);
  assert.equal(await fsp.readFile(path.join(root.server, 'old.txt'), 'utf8'), 'old');
  delete config.beforeCommit;
  const result = await restorePackage(config, file, root.server, operation());
  assert.equal(await fsp.readFile(path.join(root.server, 'world', 'new.dat'), 'utf8'), 'new');
  if (process.platform !== 'win32') {
    assert.equal((await fsp.stat(root.server)).mode & 0o777, 0o755);
    assert.equal((await fsp.stat(path.join(root.server, 'world'))).mode & 0o777, 0o755);
    assert.equal((await fsp.stat(path.join(root.server, 'world', 'new.dat'))).mode & 0o777, 0o644);
    assert.equal((await fsp.stat(path.join(root.server, 'start_server.sh'))).mode & 0o777, 0o755);
  }
  assert.equal(result.serverStarted, false);
  assert.equal(await fsp.readFile(path.join(result.backupPath, 'old.txt'), 'utf8'), 'old');
});

test('restauração bloqueia destino ativo', async (t) => {
  const root = await fixture(t);
  const file = await packageZip(t, root.base, { 'world/a.dat': 'a' });
  await assert.rejects(restorePackage({ ...root, stateProvider: running }, file, root.server, operation()), { code: 'SERVER_RUNNING' });
});

test('inicialização corrige árvore restaurada sem acesso público', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  const file = path.join(root.server, 'server.properties');
  await fsp.writeFile(file, 'motd=test', { mode: 0o600 });
  await fsp.chmod(root.server, 0o700);
  await createApp({ ...root, token: 'test-token', stateProvider: stopped });
  assert.equal((await fsp.stat(root.server)).mode & 0o777, 0o755);
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o644);
});

test('aborta exportação quando a origem muda durante a coleta', async (t) => {
  const root = await fixture(t);
  const source = path.join(root.server, 'world.dat'); await fsp.writeFile(source, 'before');
  await assert.rejects(exportServer({ ...root, stateProvider: stopped, afterFileCopied: async (file) => fsp.appendFile(file, '!') }, operation()), { code: 'SOURCE_CHANGED' });
});

async function fixture(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'host-switch-test-'));
  const server = path.join(base, 'server'); const dataRoot = path.join(base, 'data');
  await fsp.mkdir(server); await fsp.mkdir(dataRoot);
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  return { base, serverRoot: server, server, dataRoot };
}

function record(filePath, content) { const data = Buffer.from(content); return { path: filePath, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }; }
function validManifest(files, minecraftVersion = null) { return { format: 'craftsystem-host-switch', formatVersion: 1, server: { minecraftVersion, software: null, softwareVersion: null, javaVersion: null, components: { mods: [], plugins: [] } }, export: { createdAt: new Date().toISOString(), sourceId: 'test', files }, policy: {}, report: {} }; }
async function packageZip(t, base, entries, options = {}) {
  const files = Object.entries(entries).map(([name, content], index) => index === 0 && options.hashOverride ? { ...record(name, content), sha256: options.hashOverride } : record(name, content));
  const payload = options.omitPayload ? {} : Object.fromEntries(Object.entries(entries).map(([name, content]) => [`payload/${name}`, content]));
  return zip(t, base, { manifest: validManifest(files, options.minecraftVersion), entries: payload });
}
async function rawZip(base, entries) {
  const file = path.join(base, `${crypto.randomUUID()}.zip`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(file); const archive = archiver('zip');
    output.on('close', resolve); output.on('error', reject); archive.on('error', reject); archive.pipe(output);
    for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
    archive.finalize();
  });
  return file;
}
async function zip(_t, base, { manifest, entries }) {
  const file = path.join(base, `${crypto.randomUUID()}.zip`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(file); const archive = archiver('zip');
    output.on('close', resolve); output.on('error', reject); archive.on('error', reject); archive.pipe(output);
    archive.append(JSON.stringify(manifest), { name: 'manifest.json' });
    for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
    archive.finalize();
  });
  return file;
}
