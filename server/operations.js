import crypto from 'node:crypto';
import path from 'node:path';

export class OperationStore {
  #operations = new Map();
  #downloadTickets = new Map();
  #exclusive = null;

  create(kind) {
    const operation = {
      id: crypto.randomUUID(), kind, state: 'waiting', progress: 0, message: 'Aguardando.', createdAt: new Date().toISOString(),
      update(state, progress, message) { this.state = state; this.progress = progress; this.message = message; this.updatedAt = new Date().toISOString(); },
    };
    this.#operations.set(operation.id, operation);
    return operation;
  }

  public(operation) {
    if (!operation) return null;
    return { id: operation.id, kind: operation.kind, state: operation.state, progress: operation.progress, message: operation.message, createdAt: operation.createdAt, updatedAt: operation.updatedAt, error: operation.error, result: sanitizeResult(operation.result) };
  }

  get(id) { return this.#operations.get(id); }
  list() { return [...this.#operations.values()].slice(-20).reverse().map((item) => this.public(item)); }
  acquire(operation) {
    if (this.#exclusive) throw Object.assign(new Error('Já existe uma exportação ou restauração em andamento.'), { code: 'OPERATION_CONFLICT', status: 409 });
    this.#exclusive = operation.id;
  }
  release(operation) { if (this.#exclusive === operation.id) this.#exclusive = null; }
  get busy() { return Boolean(this.#exclusive); }

  issueDownloadTicket(operationId) {
    const ticket = crypto.randomBytes(32).toString('base64url');
    this.#downloadTickets.set(ticket, { operationId, expiresAt: Date.now() + 15 * 60_000 });
    return ticket;
  }

  validateDownloadTicket(ticket, operationId) {
    const record = this.#downloadTickets.get(ticket);
    if (!record) return false;
    if (record.expiresAt < Date.now()) {
      this.#downloadTickets.delete(ticket);
      return false;
    }
    return record.operationId === operationId;
  }
}

function sanitizeResult(result) {
  if (!result) return undefined;
  const copy = { ...result };
  delete copy.packagePath;
  delete copy.targetRoot;
  if (copy.backupPath) copy.backupPath = path.basename(copy.backupPath);
  if (copy.manifest?.export) copy.manifest = { ...copy.manifest, export: { ...copy.manifest.export, files: undefined } };
  if (copy.report?.manifest?.export) copy.report = { ...copy.report, manifest: { ...copy.report.manifest, export: { ...copy.report.manifest.export, files: undefined } } };
  return copy;
}
