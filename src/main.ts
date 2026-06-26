import './styles.css';
import { calculate } from './calc/calculate';
import { formatIsoDate } from './domain/date';
import type { ExtractResult, IntervalType, PercentType, ProjectionResult, QuarantineItem, SCurveResult, WeekStart, WeightColumn } from './domain/types';
import { renderOutput, type ConfirmedOptions } from './display/output';
import { selectBasis } from './extractor/pmxml';

type AppState = {
  mode: 'single' | 'dual';
  statusFile: File | null;
  planFile: File | null;
  phase: 'idle' | 'parsing' | 'need-plan' | 'review' | 'done' | 'error';
  message: string;
  progress: { label: string; loaded: number; total: number } | null;
  extract: ExtractResult | null;
  projection: ProjectionResult | null;
  scurve: SCurveResult | null;
  options: { wfColumnKey: string; pctType: PercentType; interval: IntervalType; weekStart: WeekStart };
  worker: Worker | null;
};

const state: AppState = {
  mode: 'single',
  statusFile: null,
  planFile: null,
  phase: 'idle',
  message: '',
  progress: null,
  extract: null,
  projection: null,
  scurve: null,
  options: { wfColumnKey: '', pctType: 'Units', interval: 'monthly', weekStart: 'monday' },
  worker: null
};

let chart: ReturnType<typeof renderOutput> = null;
const app = document.querySelector<HTMLDivElement>('#app')!;
render();

function render(): void {
  if (chart) {
    chart.destroy();
    chart = null;
  }
  app.innerHTML = `
    <main class="app-shell">
      <header class="top-bar">
        <div>
          <h1>S-Curve: Plan vs Actual Progress</h1>
          <p>Static browser tool for Primavera P6 PMXML. Files stay on this computer.</p>
        </div>
        <button class="ghost-button" id="resetButton" type="button">Reset</button>
      </header>
      <section id="workspace"></section>
    </main>
  `;
  document.querySelector<HTMLButtonElement>('#resetButton')!.addEventListener('click', reset);
  const workspace = document.querySelector<HTMLElement>('#workspace')!;
  if (state.phase === 'done' && state.extract && state.projection && state.scurve) {
    renderDone(workspace);
  } else if (state.phase === 'review' && state.extract && state.projection) {
    renderReview(workspace);
  } else if (state.phase === 'parsing') {
    renderParsing(workspace);
  } else if (state.phase === 'need-plan') {
    renderUpload(workspace, true);
  } else if (state.phase === 'error') {
    workspace.innerHTML = `<section class="notice error"><h2>Something needs attention</h2><p>${escapeHtml(state.message)}</p><button class="primary-button" id="errorReset" type="button">Start over</button></section>`;
    document.querySelector<HTMLButtonElement>('#errorReset')!.addEventListener('click', reset);
  } else {
    renderUpload(workspace, state.mode === 'dual');
  }
}

function renderUpload(container: HTMLElement, forceDual: boolean): void {
  const dual = forceDual || state.mode === 'dual';
  container.innerHTML = `
    <section class="upload-layout">
      <div class="upload-heading">
        <h2>${dual ? 'Add the status and plan files' : 'Add the P6 PMXML file'}</h2>
        <p>${dual ? 'Use the update/status schedule for actuals and the baseline or plan schedule for planned weights.' : 'If the file has no embedded baseline, the tool will ask for the separate plan file.'}</p>
      </div>
      <div class="drop-grid ${dual ? 'two' : ''}">
        ${dropZone('status', dual ? 'Status file' : 'PMXML file', state.statusFile)}
        ${dual ? dropZone('plan', 'Plan file', state.planFile) : ''}
      </div>
      <div class="upload-actions">
        <button class="secondary-button" id="modeToggle" type="button">${dual ? 'Use one file instead' : 'I have two files'}</button>
        ${dual ? '<button class="secondary-button" id="swapFiles" type="button">Swap files</button>' : ''}
        <button class="primary-button" id="parseButton" type="button" ${dual ? (!state.statusFile || !state.planFile ? 'disabled' : '') : !state.statusFile ? 'disabled' : ''}>Parse PMXML</button>
      </div>
      ${state.phase === 'need-plan' ? '<p class="inline-warning">This status file has no embedded baseline. Add the plan file to continue.</p>' : ''}
    </section>
  `;
  wireDropZone('status');
  if (dual) wireDropZone('plan');
  document.querySelector<HTMLButtonElement>('#modeToggle')!.addEventListener('click', () => {
    state.mode = dual ? 'single' : 'dual';
    state.phase = 'idle';
    render();
  });
  document.querySelector<HTMLButtonElement>('#parseButton')!.addEventListener('click', startParse);
  document.querySelector<HTMLButtonElement>('#swapFiles')?.addEventListener('click', () => {
    [state.statusFile, state.planFile] = [state.planFile, state.statusFile];
    render();
  });
}

function renderParsing(container: HTMLElement): void {
  const loaded = state.progress?.loaded ?? 0;
  const total = state.progress?.total ?? 1;
  const pct = Math.max(0, Math.min(100, (loaded / total) * 100));
  container.innerHTML = `
    <section class="notice">
      <h2>Reading PMXML</h2>
      <p>${escapeHtml(state.progress?.label ?? 'Preparing file')}</p>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <p>${pct.toFixed(0)}%</p>
      <button class="secondary-button" id="cancelParse" type="button">Cancel</button>
    </section>
  `;
  document.querySelector<HTMLButtonElement>('#cancelParse')!.addEventListener('click', () => {
    state.worker?.terminate();
    state.phase = 'idle';
    state.message = 'Parsing cancelled.';
    render();
  });
}

function renderReview(container: HTMLElement): void {
  const extract = state.extract!;
  const projection = state.projection!;
  const chosen = extract.weightColumns.find((column) => column.key === state.options.wfColumnKey);
  const allQuarantine = [...extract.quarantine, ...projection.quarantine];
  const actualEqualsPlanned = projection.tasks.filter(
    (task) => task.actualStart && task.plannedStart && formatIsoDate(task.actualStart) === formatIsoDate(task.plannedStart)
  ).length;
  container.innerHTML = `
    <section class="review-layout">
      <div class="options-strip">
        <label>Weight factor
          <select id="wfColumn">${extract.weightColumns
            .map((column) => `<option value="${escapeAttr(column.key)}" ${column.key === state.options.wfColumnKey ? 'selected' : ''} ${column.populatedCount === 0 ? 'disabled' : ''}>${escapeHtml(column.label)} - ${column.populatedCount.toLocaleString()} filled</option>`)
            .join('')}</select>
        </label>
        <label>% complete
          <select id="pctType">${(['Units', 'Physical', 'Duration'] as PercentType[])
            .map((value) => `<option value="${value}" ${value === state.options.pctType ? 'selected' : ''}>${value}</option>`)
            .join('')}</select>
        </label>
        <label>Interval
          <select id="interval">
            <option value="monthly" ${state.options.interval === 'monthly' ? 'selected' : ''}>Monthly</option>
            <option value="weekly" ${state.options.interval === 'weekly' ? 'selected' : ''}>Weekly</option>
          </select>
        </label>
        <label class="${state.options.interval === 'weekly' ? '' : 'muted'}">Week start
          <select id="weekStart" ${state.options.interval === 'weekly' ? '' : 'disabled'}>
            <option value="monday" ${state.options.weekStart === 'monday' ? 'selected' : ''}>Monday</option>
            <option value="sunday" ${state.options.weekStart === 'sunday' ? 'selected' : ''}>Sunday</option>
          </select>
        </label>
      </div>
      <section class="confirm-card">
        <div class="confirm-header">
          <div>
            <h2>Resolved assumptions</h2>
            <p>Confirm these before calculating the curve.</p>
          </div>
          <button class="primary-button" id="confirmButton" type="button" ${projection.totalWf <= 0 ? 'disabled' : ''}>Confirm & Calculate</button>
        </div>
        <div class="fact-grid">
          ${fact('Source', extract.projectMeta.sourceMode === 'single' ? `Single file: ${extract.projectMeta.liveFileName}` : `Status: ${extract.projectMeta.liveFileName}<br>Plan: ${extract.projectMeta.planFileName}`)}
          ${fact('Live project', `${extract.projectMeta.liveProjectId || '(no id)'}<br>${extract.projectMeta.liveProjectName ?? ''}<br>ObjectId ${extract.projectMeta.liveProjectObjectId}`)}
          ${fact('Plan project', `${extract.projectMeta.baselineProjectId || '(no id)'}<br>${extract.projectMeta.baselineProjectName ?? ''}<br>ObjectId ${extract.projectMeta.baselineProjectObjectId}`)}
          ${fact('Data date', formatIsoDate(extract.projectMeta.dataDate))}
          ${fact('Chosen basis', `${chosen?.label ?? state.options.wfColumnKey}<br>${state.options.pctType} complete<br>${state.options.interval}${state.options.interval === 'weekly' ? `, ${state.options.weekStart}` : ''}`)}
          ${fact('Scope counts', `${projection.stats.validTaskCount.toLocaleString()} valid tasks<br>${extract.reconciliation.matched.toLocaleString()} matched<br>${extract.reconciliation.baselineOnly.toLocaleString()} planned-only`)}
          ${fact('Discarded', `${extract.summaryStats.wbsNodesDiscarded.toLocaleString()} WBS nodes<br>${extract.summaryStats.excludedActivityCount.toLocaleString()} excluded activity types<br>${extract.summaryStats.milestoneCount.toLocaleString()} milestones`)}
          ${fact('Total WF', projection.totalWf.toLocaleString(undefined, { maximumFractionDigits: 2 }))}
        </div>
        <div class="health-list">
          ${health(`${extract.reconciliation.liveOnly.toLocaleString()} live activities have no baseline twin and are excluded.`)}
          ${health(`${projection.quarantine.length.toLocaleString()} activities are excluded under ${chosen?.label ?? 'the chosen column'}.`)}
          ${health(`${actualEqualsPlanned.toLocaleString()} tasks have actual starts identical to planned starts.`)}
        </div>
        <details class="quarantine-box">
          <summary>Quarantine (${allQuarantine.length.toLocaleString()} items)</summary>
          <div class="quarantine-list">${allQuarantine
            .slice(0, 300)
            .map((item) => `<div><strong>${escapeHtml(item.id)}</strong><span>${escapeHtml(item.reasons.join(', '))}</span></div>`)
            .join('')}${allQuarantine.length > 300 ? '<p>Showing first 300 items. Full list is available in the download after calculation.</p>' : ''}</div>
        </details>
      </section>
    </section>
  `;
  wireReviewOptions();
  document.querySelector<HTMLButtonElement>('#confirmButton')!.addEventListener('click', confirmCalculate);
}

function renderDone(container: HTMLElement): void {
  const extract = state.extract!;
  const projection = state.projection!;
  const chosen = extract.weightColumns.find((column) => column.key === state.options.wfColumnKey);
  const output = document.createElement('section');
  output.className = 'done-layout';
  container.append(output);
  chart = renderOutput(output, {
    scurve: state.scurve!,
    projectMeta: extract.projectMeta,
    summaryStats: extract.summaryStats,
    quarantine: [...extract.quarantine, ...projection.quarantine],
    options: confirmedOptions(chosen)
  });
}

function dropZone(kind: 'status' | 'plan', title: string, file: File | null): string {
  return `
    <label class="drop-zone" data-kind="${kind}">
      <input id="${kind}Input" type="file" accept=".xml" />
      <span>${title}</span>
      <strong>${file ? escapeHtml(file.name) : 'Drop or choose XML'}</strong>
      <small>${file ? formatBytes(file.size) : 'Primavera P6 PMXML'}</small>
    </label>
  `;
}

function wireDropZone(kind: 'status' | 'plan'): void {
  const zone = document.querySelector<HTMLElement>(`[data-kind="${kind}"]`)!;
  const input = document.querySelector<HTMLInputElement>(`#${kind}Input`)!;
  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    zone.classList.remove('drag-over');
    const file = event.dataTransfer?.files[0];
    if (file) setFile(kind, file);
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) setFile(kind, file);
  });
}

async function setFile(kind: 'status' | 'plan', file: File): Promise<void> {
  if (!file.name.toLowerCase().endsWith('.xml')) {
    state.phase = 'error';
    state.message = 'Choose a .xml Primavera P6 PMXML file.';
    render();
    return;
  }
  const sniff = await file.slice(0, 2048).text();
  if (!/APIBusinessObjects|PMXML|Primavera|Project/i.test(sniff)) {
    state.phase = 'error';
    state.message = 'This does not look like a Primavera P6 PMXML export.';
    render();
    return;
  }
  if (kind === 'status') state.statusFile = file;
  else state.planFile = file;
  render();
}

function startParse(): void {
  if (!state.statusFile) return;
  state.worker?.terminate();
  state.phase = 'parsing';
  state.progress = null;
  render();
  const worker = new Worker(new URL('./workers/extractWorker.ts', import.meta.url), { type: 'module' });
  state.worker = worker;
  worker.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (data.type === 'progress') {
      state.progress = { label: data.label, loaded: data.loaded, total: data.total };
      render();
    } else if (data.type === 'need-plan') {
      state.phase = 'need-plan';
      state.mode = 'dual';
      worker.terminate();
      render();
    } else if (data.type === 'done') {
      state.extract = reviveExtractDates(data.result);
      chooseDefaultOptions();
      reproject();
      state.phase = state.projection?.totalWf === 0 ? 'error' : 'review';
      state.message = state.projection?.totalWf === 0 ? 'All tasks were excluded under the selected weight column. Try another weight column.' : '';
      worker.terminate();
      render();
    } else if (data.type === 'error') {
      state.phase = 'error';
      state.message = data.message;
      worker.terminate();
      render();
    }
  };
  if (state.mode === 'dual') {
    if (!state.planFile) return;
    worker.postMessage({ mode: 'dual', statusFile: state.statusFile, planFile: state.planFile });
  } else {
    worker.postMessage({ mode: 'single', file: state.statusFile });
  }
}

function wireReviewOptions(): void {
  document.querySelector<HTMLSelectElement>('#wfColumn')!.addEventListener('change', (event) => {
    state.options.wfColumnKey = (event.target as HTMLSelectElement).value;
    reproject();
    render();
  });
  document.querySelector<HTMLSelectElement>('#pctType')!.addEventListener('change', (event) => {
    state.options.pctType = (event.target as HTMLSelectElement).value as PercentType;
    reproject();
    render();
  });
  document.querySelector<HTMLSelectElement>('#interval')!.addEventListener('change', (event) => {
    state.options.interval = (event.target as HTMLSelectElement).value as IntervalType;
    render();
  });
  document.querySelector<HTMLSelectElement>('#weekStart')!.addEventListener('change', (event) => {
    state.options.weekStart = (event.target as HTMLSelectElement).value as WeekStart;
    render();
  });
}

function chooseDefaultOptions(): void {
  const columns = state.extract?.weightColumns ?? [];
  state.options.wfColumnKey = columns.find((column) => column.key === 'PlannedLaborUnits' && column.populatedCount > 0)?.key ?? columns.find((column) => column.populatedCount > 0)?.key ?? columns[0]?.key ?? '';
}

function reproject(): void {
  if (!state.extract || !state.options.wfColumnKey) return;
  state.projection = selectBasis(state.extract, { wfColumnKey: state.options.wfColumnKey, pctType: state.options.pctType });
}

function confirmCalculate(): void {
  if (!state.extract || !state.projection || state.projection.totalWf <= 0) return;
  state.scurve = calculate(state.projection.tasks, state.extract.projectMeta, state.projection.totalWf, {
    interval: state.options.interval,
    weekStart: state.options.weekStart
  });
  state.phase = 'done';
  render();
}

function reset(): void {
  state.worker?.terminate();
  Object.assign(state, {
    mode: 'single',
    statusFile: null,
    planFile: null,
    phase: 'idle',
    message: '',
    progress: null,
    extract: null,
    projection: null,
    scurve: null,
    worker: null
  });
  render();
}

function reviveExtractDates(result: ExtractResult): ExtractResult {
  result.projectMeta.dataDate = new Date(result.projectMeta.dataDate);
  for (const record of result.records) {
    if (record.plannedStart) record.plannedStart = new Date(record.plannedStart);
    if (record.plannedFinish) record.plannedFinish = new Date(record.plannedFinish);
    if (record.actualStart) record.actualStart = new Date(record.actualStart);
    if (record.actualFinish) record.actualFinish = new Date(record.actualFinish);
  }
  return result;
}

function confirmedOptions(column: WeightColumn | undefined): ConfirmedOptions {
  return {
    wfColumnLabel: column?.label ?? state.options.wfColumnKey,
    pctType: state.options.pctType,
    interval: state.options.interval === 'monthly' ? 'Monthly' : 'Weekly',
    weekStart: state.options.interval === 'weekly' ? state.options.weekStart : undefined
  };
}

function fact(label: string, value: string): string {
  return `<div class="fact"><span>${label}</span><strong>${value}</strong></div>`;
}

function health(value: string): string {
  return `<p>${escapeHtml(value)}</p>`;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]!);
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
