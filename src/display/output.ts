import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
  Title,
  Filler,
  type ChartConfiguration
} from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { formatIsoDate } from '../domain/date';
import type { Anomaly, ProjectMeta, QuarantineItem, SCurveResult } from '../domain/types';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend, Title, Filler, annotationPlugin);

export type ConfirmedOptions = {
  wfColumnLabel: string;
  pctType: string;
  interval: string;
  weekStart?: string;
};

export type DisplayView = {
  scurve: SCurveResult;
  projectMeta: ProjectMeta;
  summaryStats: Record<string, unknown>;
  quarantine: QuarantineItem[];
  options: ConfirmedOptions;
};

export type KeyDateTable = {
  labels: string[];
  plan: string[];
  actual: string[];
};

export function buildKeyDateTable(scurve: SCurveResult, targetCount = 8): KeyDateTable {
  if (!scurve.rows.length) return { labels: [], plan: [], actual: [] };
  const indexes = new Set<number>([0, scurve.dataDateIntervalIndex, scurve.rows.length - 1]);
  const slots = Math.max(targetCount, indexes.size);
  for (let i = 0; i < slots; i += 1) {
    indexes.add(Math.round((i * (scurve.rows.length - 1)) / (slots - 1)));
  }
  const sorted = Array.from(indexes)
    .filter((index) => index >= 0 && index < scurve.rows.length)
    .sort((a, b) => a - b)
    .slice(0, targetCount);
  return {
    labels: sorted.map((index) => scurve.rows[index].label),
    plan: sorted.map((index) => formatPct(scurve.rows[index].plannedCumulativePct)),
    actual: sorted.map((index) => {
      const value = scurve.rows[index].actualCumulativePct;
      return value == null ? '' : formatPct(value);
    })
  };
}

export function buildChartConfig(view: DisplayView): ChartConfiguration<'line'> {
  const labels = view.scurve.rows.map((row) => row.label);
  const anomalyNotes = new Map<string, string>();
  for (const anomaly of view.scurve.anomalies) anomalyNotes.set(`${anomaly.series}:${anomaly.rowIndex}`, anomaly.note);
  const planRadii = anomalyRadii(view.scurve, 'plan');
  const actualRadii = anomalyRadii(view.scurve, 'actual');
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Plan (Cumulative)',
          data: view.scurve.rows.map((row) => row.plannedCumulativePct),
          borderColor: '#2563eb',
          backgroundColor: '#2563eb',
          borderWidth: 2,
          pointRadius: planRadii.radius,
          pointHoverRadius: planRadii.hoverRadius,
          pointBorderWidth: planRadii.borderWidth,
          pointBorderColor: planRadii.borderColor,
          tension: 0.25
        },
        {
          label: 'Actual (Cumulative)',
          data: view.scurve.rows.map((row) => row.actualCumulativePct),
          borderColor: '#dc2626',
          backgroundColor: '#dc2626',
          borderWidth: 2,
          pointRadius: actualRadii.radius,
          pointHoverRadius: actualRadii.hoverRadius,
          pointBorderWidth: actualRadii.borderWidth,
          pointBorderColor: actualRadii.borderColor,
          spanGaps: false,
          tension: 0.25
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: {
          display: true,
          text: `S-Curve: Plan vs Actual Progress${view.projectMeta.liveProjectName ? ` - ${view.projectMeta.liveProjectName}` : ''}`,
          color: '#172033',
          font: { size: 18, weight: 600 }
        },
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            afterBody(items) {
              const notes = items
                .map((item) => {
                  const series = item.datasetIndex === 0 ? 'plan' : 'actual';
                  return anomalyNotes.get(`${series}:${item.dataIndex}`);
                })
                .filter(Boolean);
              return notes as string[];
            }
          }
        },
        annotation: {
          annotations: {
            dataDate: {
              type: 'line',
              xMin: view.scurve.dataDateIntervalIndex,
              xMax: view.scurve.dataDateIntervalIndex,
              borderColor: '#475569',
              borderWidth: 1,
              borderDash: [4, 4],
              label: {
                display: true,
                content: `Data date ${formatIsoDate(view.projectMeta.dataDate)}`,
                position: 'start',
                backgroundColor: '#475569'
              }
            }
          }
        }
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          ticks: { callback: (value) => `${value}%` },
          grid: { color: '#e5e7eb' }
        },
        x: { grid: { display: false } }
      }
    }
  };
}

export function renderOutput(container: HTMLElement, view: DisplayView): Chart<'line'> | null {
  container.innerHTML = '';
  if (!view.scurve.rows.length) {
    container.innerHTML = `<div class="empty-state">No valid S-curve rows to display.</div>`;
    return null;
  }
  const chartWrap = document.createElement('section');
  chartWrap.className = 'chart-section';
  const canvas = document.createElement('canvas');
  chartWrap.append(canvas);
  container.append(chartWrap);

  const context = document.createElement('p');
  context.className = 'context-strip';
  context.textContent = `Weight: ${view.options.wfColumnLabel} | % type: ${view.options.pctType} | ${view.options.interval}${view.options.weekStart ? ` (${view.options.weekStart})` : ''} | Data date: ${formatIsoDate(view.projectMeta.dataDate)}`;
  container.append(context);

  const table = buildKeyDateTable(view.scurve);
  container.append(renderKeyDateTable(table));

  const actions = document.createElement('div');
  actions.className = 'output-actions';
  actions.append(
    makeDownloadButton('Download details CSV', `${safeName(view.projectMeta.liveProjectId)}-${formatIsoDate(view.projectMeta.dataDate)}-detail.csv`, () =>
      buildDetailCsv(view)
    ),
    makeDownloadButton('Download quarantine CSV', `${safeName(view.projectMeta.liveProjectId)}-${formatIsoDate(view.projectMeta.dataDate)}-quarantine.csv`, () =>
      buildQuarantineCsv(view.quarantine)
    ),
    makePngButton('Download chart PNG', canvas, `${safeName(view.projectMeta.liveProjectId)}-${formatIsoDate(view.projectMeta.dataDate)}-chart.png`)
  );
  container.append(actions);

  return new Chart(canvas, buildChartConfig(view));
}

export function buildDetailCsv(view: DisplayView): string {
  const header = [
    'Interval',
    `Plan Periodic (${view.options.wfColumnLabel})`,
    `Plan Cumulative (${view.options.wfColumnLabel})`,
    'Plan Cumulative %',
    `Actual Periodic (${view.options.wfColumnLabel})`,
    `Actual Cumulative (${view.options.wfColumnLabel})`,
    'Actual Cumulative %',
    'Variance %',
    'Anomaly'
  ];
  const lines: Array<Array<string | number | null>> = [header];
  for (const row of view.scurve.rows) {
    const anomaly = [row.planAnomaly, row.actualAnomaly].filter(Boolean).map((item) => (item as Anomaly).note).join(' | ');
    lines.push([
      row.label,
      row.plannedPeriodic,
      row.plannedCumulative,
      row.plannedCumulativePct,
      row.actualPeriodic ?? '',
      row.actualCumulative ?? '',
      row.actualCumulativePct ?? '',
      row.actualCumulativePct == null ? '' : row.actualCumulativePct - row.plannedCumulativePct,
      anomaly
    ]);
  }
  lines.push([]);
  lines.push(['Summary', 'Value']);
  lines.push(['Total WF', view.scurve.totals.totalWf]);
  lines.push(['Planned % at data date', view.scurve.totals.plannedPctAtDataDate]);
  lines.push(['Actual % at data date', view.scurve.totals.actualPctAtDataDate]);
  lines.push(['Schedule variance %', view.scurve.totals.scheduleVariancePct]);
  lines.push(['Overall actual %', view.scurve.totals.overallActualPct]);
  return toCsv(lines);
}

export function buildQuarantineCsv(items: QuarantineItem[]): string {
  return toCsv([['Id', 'Reasons'], ...items.map((item) => [item.id, item.reasons.join('|')])]);
}

function renderKeyDateTable(table: KeyDateTable): HTMLTableElement {
  const element = document.createElement('table');
  element.className = 'key-date-table';
  const rows = [
    ['Key dates', ...table.labels],
    ['Plan Cumulative %', ...table.plan],
    ['Actual Cumulative %', ...table.actual]
  ];
  for (const row of rows) {
    const tr = document.createElement('tr');
    row.forEach((value, index) => {
      const cell = document.createElement(index === 0 ? 'th' : 'td');
      cell.textContent = value;
      tr.append(cell);
    });
    element.append(tr);
  }
  return element;
}

function anomalyRadii(scurve: SCurveResult, series: 'plan' | 'actual') {
  const anomalyIndexes = new Set(scurve.anomalies.filter((item) => item.series === series).map((item) => item.rowIndex));
  return {
    radius: scurve.rows.map((_, index) => (anomalyIndexes.has(index) ? 6 : 2)),
    hoverRadius: scurve.rows.map((_, index) => (anomalyIndexes.has(index) ? 8 : 4)),
    borderWidth: scurve.rows.map((_, index) => (anomalyIndexes.has(index) ? 3 : 0)),
    borderColor: scurve.rows.map((_, index) => (anomalyIndexes.has(index) ? '#f59e0b' : 'transparent'))
  };
}

function makeDownloadButton(label: string, filename: string, getContent: () => string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary-button';
  button.textContent = label;
  button.addEventListener('click', () => downloadText(filename, getContent()));
  return button;
}

function makePngButton(label: string, canvas: HTMLCanvasElement, filename: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary-button';
  button.textContent = label;
  button.addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png', 1);
    link.download = filename;
    link.click();
  });
  return button;
}

function downloadText(filename: string, content: string): void {
  const blob = new Blob([`\uFEFF${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function toCsv(rows: Array<Array<string | number | null>>): string {
  return rows
    .map((row) =>
      row
        .map((cell) => String(cell ?? ''))
        .map((cell) => `"${cell.replaceAll('"', '""')}"`)
        .join(',')
    )
    .join('\n');
}

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function safeName(value: string): string {
  return (value || 's-curve').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '');
}
