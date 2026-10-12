import fsp from 'node:fs/promises';
import path from 'node:path';

export async function makePubliclyReadable(root, declaredModes = new Map()) {
  const absoluteRoot = path.resolve(root);
  await visit(absoluteRoot, '');

  async function visit(current, relative) {
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      await fsp.chmod(current, 0o755);
      for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        await visit(path.join(current, entry.name), childRelative);
      }
      return;
    }
    if (!stat.isFile()) return;
    const sourceMode = declaredModes.get(relative) ?? (stat.mode & 0o777);
    const executable = Boolean(sourceMode & 0o111) || relative.toLocaleLowerCase('en-US').endsWith('.sh');
    await fsp.chmod(current, executable ? 0o755 : 0o644);
  }
}

export async function repairServerAccessIfNeeded(root) {
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat?.isDirectory() || (stat.mode & 0o055) === 0o055) return false;
  await makePubliclyReadable(root);
  return true;
}
