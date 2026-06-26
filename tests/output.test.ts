import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildChartConfig, buildDetailCsv, buildKeyDateTable, buildQuarantineCsv, type DisplayView } from '../src/display/output';
import { parsePmDate } from '../src/domain/date';
import type { IntervalRow, SCurveResult } from '../src/domain/types';

function d(value: string): Date {
  return parsePmDate(value)!;
}

function sampleView(): DisplayView {
  const rows: IntervalRow[] = Array.from({ length: 12 }, (_, index) => ({
    index,
    label: `2024-${String(index + 1).padStart(2, '0')}`,
    start: d(`2024-${String(index + 1).padStart(2, '0')}-01`),
    end: new Date(Date.UTC(2024, index + 1, 1)),
    plannedPeriodic: 10,
    plannedCumulative: (index + 1) * 10,
    plannedCumulativePct: (index + 1) * 8,
    actualPeriodic: index <= 5 ? 8 : null,
    actualCumulative: index <= 5 ? (index + 1) * 8 : null,
    actualCumulativePct: index <= 5 ? (index + 1) * 6 : null,
    isDataDateInterval: index === 5,
    planAnomaly: null,
    actualAnomaly: null
  }));
  const anomaly = { rowIndex: 4, series: 'plan' as const, type: 'jump' as const, periodicPct: 20, note: 'Plan: +20% this interval' };
  rows[4].planAnomaly = anomaly;
  const scurve: SCurveResult = {
    rows,
    anomalies: [anomaly],
    dataDateIntervalIndex: 5,
    totals: {
      totalWf: 120,
      plannedPctAtDataDate: 50,
      actualPctAtDataDate: 36,
      scheduleVariancePct: -14,
      overallActualPct: 36
    },
    meta: { interval: 'monthly', gridStart: d('2024-01-01'), gridEnd: d('2024-12-01') }
  };
  return {
    scurve,
    projectMeta: {
      sourceMode: 'dual',
      liveProjectObjectId: '1',
      baselineProjectObjectId: '2',
      liveProjectId: 'LIVE',
      liveProjectName: 'Live Project',
      baselineProjectId: 'PLAN',
      baselineProjectName: 'Plan Project',
      liveFileName: 'status.xml',
      planFileName: 'plan.xml',
      dataDate: d('2024-06-15')
    },
    summaryStats: {},
    quarantine: [{ id: 'X1', reasons: ['UNBASELINED_SCOPE'], raw: {} }],
    options: { wfColumnLabel: 'Planned Labor Units', pctType: 'Units', interval: 'Monthly' }
  };
}

describe('display output models', () => {
  it('builds a three-row key-date table with first, data date, and last included', () => {
    const table = buildKeyDateTable(sampleView().scurve);
    assert.equal(table.labels.length <= 8, true);
    assert.equal(table.labels.includes('2024-01'), true);
    assert.equal(table.labels.includes('2024-06'), true);
    assert.equal(table.labels.includes('2024-12'), true);
    assert.equal(table.actual[table.labels.indexOf('2024-12')], '');
  });

  it('builds chart config with blue plan, red actual, null-stop data, marker, and anomaly point', () => {
    const config = buildChartConfig(sampleView());
    assert.equal(config.data.datasets[0].borderColor, '#2563eb');
    assert.equal(config.data.datasets[1].borderColor, '#dc2626');
    assert.equal(config.data.datasets[1].data[6], null);
    assert.ok(config.options?.plugins?.annotation);
    assert.equal((config.data.datasets[0].pointRadius as number[])[4], 6);
  });

  it('exports full-detail and quarantine CSV content', () => {
    const view = sampleView();
    const detail = buildDetailCsv(view);
    const quarantine = buildQuarantineCsv(view.quarantine);
    assert.match(detail, /Plan Cumulative \(Planned Labor Units\)/);
    assert.match(detail, /Plan: \+20% this interval/);
    assert.match(detail, /Schedule variance %/);
    assert.match(quarantine, /UNBASELINED_SCOPE/);
  });
});
