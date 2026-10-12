import firewallDownloadUrl from '../assets/liberar_ipv4_firewall.bat?url';

const terminalAccessLink = document.querySelector('#terminal-access-link');
const firewallDownloadLink = document.querySelector('#firewall-download-link');
const tutorial = document.querySelector('#tutorial');
const toast = document.querySelector('#toast');
const toastMessage = document.querySelector('#toast-message');

const terminalUrl = new URL('/', window.location.href);
terminalUrl.port = '23333';
terminalAccessLink.href = terminalUrl.href;
firewallDownloadLink.href = firewallDownloadUrl;

function openTutorial() {
  if (!tutorial.open) tutorial.showModal();
}

function closeTutorial() {
  tutorial.close();
}

document.querySelector('[data-tutorial-open]').addEventListener('click', openTutorial);
document.querySelectorAll('[data-tutorial-close]').forEach((button) => {
  button.addEventListener('click', closeTutorial);
});

function copyWithFallback(value) {
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

let toastTimer;
document.querySelector('[data-server-copy]').addEventListener('click', async () => {
  const serverAddress = window.location.hostname;

  try {
    if (!navigator.clipboard) throw new Error('Clipboard indisponível');
    await navigator.clipboard.writeText(serverAddress);
  } catch {
    copyWithFallback(serverAddress);
  }

  toastMessage.textContent = serverAddress;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 3200);
});

const hostToken = document.querySelector('#host-switch-token');
const connectButton = document.querySelector('[data-host-connect]');
const exportButton = document.querySelector('[data-export]');
const downloadButton = document.querySelector('[data-download]');
const serverState = document.querySelector('[data-server-state]');
const operationState = document.querySelector('[data-operation-state]');
const progress = document.querySelector('[data-progress]');
const hostMessage = document.querySelector('[data-host-message]');
const importFile = document.querySelector('[data-import-file]');
const fileName = document.querySelector('[data-file-name]');
const validateButton = document.querySelector('[data-validate]');
const validationReport = document.querySelector('[data-validation-report]');
const restoreBox = document.querySelector('[data-restore-confirmation]');
const confirmation = document.querySelector('[data-confirmation]');
const restoreButton = document.querySelector('[data-restore]');
let activeOperation;
let validationId;

hostToken.value = window.sessionStorage.getItem('host-switch-token') || '';

async function api(url, options = {}) {
  const token = hostToken.value.trim();
  const headers = new Headers(options.headers);
  headers.set('x-host-switch-token', token);
  if (options.body && !(options.body instanceof FormData)) headers.set('content-type', 'application/json');
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Falha HTTP ${response.status}`);
  }
  return response;
}

function setBusy(busy) {
  exportButton.disabled = busy || !hostToken.value.trim();
  validateButton.disabled = busy || !importFile.files.length || !hostToken.value.trim();
  restoreButton.disabled = busy;
}

connectButton.addEventListener('click', async () => {
  try {
    window.sessionStorage.setItem('host-switch-token', hostToken.value.trim());
    const data = await (await api('/api/host-switch/status')).json();
    serverState.textContent = ({ stopped: 'Parado', running: 'Ligado', unknown: 'Não confirmado' })[data.server.state] || data.server.state;
    hostMessage.textContent = data.server.message;
    if (data.latestExport) {
      downloadButton.hidden = false;
      downloadButton.onclick = () => downloadStoredPackage(data.latestExport.packageName);
      hostMessage.textContent += ` Último pacote disponível: ${data.latestExport.packageName} (${formatBytes(data.latestExport.bytes)}).`;
    }
    setBusy(data.busy);
  } catch (error) { hostMessage.textContent = error.message; setBusy(true); }
});

exportButton.addEventListener('click', async () => {
  try {
    setBusy(true); downloadButton.hidden = true;
    const operation = await (await api('/api/host-switch/exports', { method: 'POST' })).json();
    await watchOperation(operation.id);
  } catch (error) { hostMessage.textContent = error.message; setBusy(false); }
});

importFile.addEventListener('change', () => {
  fileName.textContent = importFile.files[0]?.name || 'Nenhum arquivo selecionado';
  validateButton.disabled = !importFile.files.length || !hostToken.value.trim();
  restoreBox.hidden = true; validationReport.hidden = true;
});

validateButton.addEventListener('click', async () => {
  try {
    setBusy(true);
    const body = new FormData(); body.append('package', importFile.files[0]);
    const operation = await (await api('/api/host-switch/imports', { method: 'POST', body })).json();
    const complete = await watchOperation(operation.id);
    if (complete.state === 'awaiting-confirmation') showValidation(complete);
  } catch (error) { hostMessage.textContent = error.message; setBusy(false); }
});

restoreButton.addEventListener('click', async () => {
  try {
    if (confirmation.value !== 'RESTAURAR') throw new Error('Digite RESTAURAR exatamente para confirmar.');
    setBusy(true);
    const operation = await (await api(`/api/host-switch/imports/${validationId}/restore`, { method: 'POST', body: JSON.stringify({ confirmation: confirmation.value }) })).json();
    await watchOperation(operation.id);
  } catch (error) { hostMessage.textContent = error.message; setBusy(false); }
});

async function watchOperation(id) {
  activeOperation = id;
  while (activeOperation === id) {
    const operation = await (await api(`/api/host-switch/operations/${id}`)).json();
    operationState.textContent = labels[operation.state] || operation.state;
    progress.style.width = `${operation.progress}%`;
    hostMessage.textContent = operation.error?.message || operation.message;
    if (['ready', 'awaiting-confirmation', 'completed', 'failed'].includes(operation.state)) {
      setBusy(false);
      if (operation.state === 'ready') {
        downloadButton.hidden = false;
        downloadButton.onclick = () => downloadPackage(id, operation.result.packageName);
      }
      return operation;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 800));
  }
}

async function downloadPackage(id, name) {
  try {
    const { ticket } = await (await api(`/api/host-switch/exports/${id}/download-ticket`, { method: 'POST' })).json();
    const link = document.createElement('a');
    link.href = `/api/host-switch/exports/${id}/download?ticket=${encodeURIComponent(ticket)}`;
    link.download = name || 'migration.zip';
    document.body.append(link);
    link.click();
    link.remove();
  } catch (error) { hostMessage.textContent = error.message; }
}

async function downloadStoredPackage(name) {
  try {
    const encodedName = encodeURIComponent(name);
    const { ticket } = await (await api(`/api/host-switch/packages/${encodedName}/download-ticket`, { method: 'POST' })).json();
    const link = document.createElement('a');
    link.href = `/api/host-switch/packages/${encodedName}/download?ticket=${encodeURIComponent(ticket)}`;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
  } catch (error) { hostMessage.textContent = error.message; }
}

function showValidation(operation) {
  validationId = operation.id;
  const { report } = operation.result;
  const compatibility = report.compatibility;
  validationReport.hidden = false;
  validationReport.replaceChildren();
  const summary = document.createElement('p');
  summary.textContent = `${report.fileCount} arquivos e ${formatBytes(report.expandedBytes)} verificados. Compatibilidade: ${compatibility.status}.`;
  validationReport.append(summary);
  [...compatibility.blockers, ...compatibility.warnings].forEach((message) => { const item = document.createElement('p'); item.textContent = `• ${message}`; validationReport.append(item); });
  restoreBox.hidden = compatibility.blockers.length > 0;
}

const labels = { waiting: 'Aguardando', preparing: 'Preparando exportação', packing: 'Compactando', validating: 'Validando pacote', ready: 'Pronto para download', 'awaiting-confirmation': 'Aguardando confirmação', restoring: 'Restaurando', completed: 'Concluído', failed: 'Falhou' };
function formatBytes(bytes) { return new Intl.NumberFormat('pt-BR', { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(bytes / 1024 / 1024); }
