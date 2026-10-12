import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export async function inspectInstallation(root) {
  const result = { minecraftVersion: null, software: null, softwareVersion: null, javaVersion: null, components: { mods: [], plugins: [] } };
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
    if (typeof manifest.minecraftVersion === 'string') result.minecraftVersion = manifest.minecraftVersion;
  } catch {}
  let names = [];
  try { names = await fs.readdir(root); } catch {}
  for (const name of names) {
    let match = name.match(/^arclight[-_](.+)\.jar$/i);
    if (match) { result.software = 'Arclight'; result.softwareVersion = match[1]; break; }
    match = name.match(/^forge-(\d+\.\d+(?:\.\d+)?)-(.+?)(?:-installer)?\.jar$/i);
    if (match) { result.software = 'Forge'; result.minecraftVersion ||= match[1]; result.softwareVersion = match[2]; }
  }
  for (const kind of ['mods', 'plugins']) {
    try { result.components[kind] = (await fs.readdir(path.join(root, kind))).filter((name) => name.toLowerCase().endsWith('.jar')).sort(); } catch {}
  }
  result.javaVersion = await javaVersion();
  return result;
}

function javaVersion() {
  return new Promise((resolve) => {
    const child = spawn('java', ['-version'], { shell: false, windowsHide: true });
    let output = '';
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', () => resolve(null));
    child.once('close', () => resolve(output.match(/version\s+"([^"]+)"/)?.[1] || null));
  });
}
