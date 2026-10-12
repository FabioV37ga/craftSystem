#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { getConfig } from '../server/config.js';
import { validatePackage, restorePackage } from '../server/importer.js';

const [command, packageArg, targetArg, confirmation] = process.argv.slice(2);
if (!['validate', 'import'].includes(command) || !packageArg) usage();
const packagePath = path.resolve(packageArg);
const targetRoot = path.resolve(targetArg || './server');
const config = getConfig({ serverRoot: targetRoot, dataRoot: path.join(path.dirname(targetRoot), '.host-switch-cli') });

try {
  if (command === 'validate') {
    const report = await validatePackage(packagePath, { targetRoot });
    console.log(JSON.stringify(report, null, 2));
  } else {
    if (confirmation !== 'RESTAURAR') throw new Error('A importação exige o quarto argumento RESTAURAR.');
    const operation = { update: (state, progress, message) => console.log(`[${progress}%] ${state}: ${message}`) };
    const result = await restorePackage(config, packagePath, targetRoot, operation);
    console.log(JSON.stringify({ completed: true, backupPath: result.backupPath, serverStarted: false }, null, 2));
  }
} catch (error) {
  console.error(`Erro: ${error.message}`);
  process.exitCode = 1;
}

function usage() {
  console.error('Uso:\n  node bin/host-switch.js validate <pacote.zip> [destino]\n  node bin/host-switch.js import <pacote.zip> <destino> RESTAURAR');
  process.exit(2);
}
