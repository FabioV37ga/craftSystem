import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { validateArchivePath } from './paths.js';

export function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true, decodeStrings: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}

export function readEntryBuffer(zip, entry, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > limit) return reject(new Error('Entrada excede o limite permitido.'));
    zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error);
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) stream.destroy(new Error('Entrada excede o limite permitido.'));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

export function scanZip(file) {
  return new Promise(async (resolve, reject) => {
    let zip;
    try { zip = await openZip(file); } catch (error) { reject(error); return; }
    const entries = [];
    const seen = new Set();
    zip.once('error', reject);
    zip.once('end', () => { zip.close(); resolve(entries); });
    zip.on('entry', (entry) => {
      try {
        const directory = entry.fileName.endsWith('/');
        const name = directory ? entry.fileName.slice(0, -1) : entry.fileName;
        if (name) validateArchivePath(name);
        const folded = entry.fileName.replace(/\/$/, '').toLocaleLowerCase('en-US');
        if (seen.has(folded)) throw Object.assign(new Error(`Entrada duplicada ou colisão no Windows: ${entry.fileName}`), { code: 'DUPLICATE_PATH' });
        seen.add(folded);
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) throw Object.assign(new Error(`Link simbólico não permitido: ${entry.fileName}`), { code: 'SYMLINK' });
        entries.push({ entry, directory });
        zip.readEntry();
      } catch (error) { zip.close(); reject(error); }
    });
    zip.readEntry();
  });
}

export async function withZipEntries(file, visitor) {
  const zip = await openZip(file);
  return new Promise((resolve, reject) => {
    zip.once('error', reject);
    zip.once('end', () => { zip.close(); resolve(); });
    zip.on('entry', async (entry) => {
      try { await visitor(zip, entry); zip.readEntry(); }
      catch (error) { zip.close(); reject(error); }
    });
    zip.readEntry();
  });
}

export async function extractEntry(zip, entry, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const input = await new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
  await pipeline(input, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
}
