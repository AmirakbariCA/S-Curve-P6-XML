import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../src/calc/calculate';
import { parsePmDate } from '../src/domain/date';
import type { Task } from '../src/domain/types';

function d(value: string): Date {
  return parsePmDate(value)!;
}

function near(actual: number | null, expected: number, epsilon = 0.01): void {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual as number) - expected) <= epsilon, `${actual} should be near ${expected}`);
}

function task(overrides: Partial<Task>): Task {
  return {
    id: overrides.id ?? 'T1',
    name: null,
    isMilestone: false,
    plannedStart: d('2017-01-15'),
    plannedFinish: d('2017-03-15'),
    wf: 300,
    actualStart: d('2017-01-15'),
    pctComplete: 0.5,
    earnedWf: 150,
    status: 'In Progress',
    bucket: 'matched',
    ...overrides
  };
}

describe('calculation engine', () => {
  it('matches the monthly worked example', () => {
    const result = calculate([task({})], { dataDate: d('2017-02-15') }, 300, { interval: 'monthly' });
    near(result.rows[0].plannedPeriodic, 86.44);
    near(result.rows[1].plannedPeriodic, 142.37);
    near(result.rows[2].plannedPeriodic, 71.19);
    near(result.rows[0].plannedCumulativePct, 28.81);
    near(result.rows[1].plannedCumulativePct, 76.27);
    near(result.rows[2].plannedCumulativePct, 100);
    near(result.rows[0].actualPeriodic, 82.26);
    near(result.rows[1].actualPeriodic, 67.74);
    assert.equal(result.rows[2].actualCumulativePct, null);
    near(result.totals.overallActualPct, 50);
    assert.ok(result.totals.scheduleVariancePct < 0);
  });

  it('preserves planned and actual sum invariants', () => {
    const tasks = [
      task({ id: 'A', wf: 100, earnedWf: 25, pctComplete: 0.25, plannedStart: d('2024-01-10'), plannedFinish: d('2024-02-10'), actualStart: d('2024-01-15') }),
      task({ id: 'B', wf: 200, earnedWf: 100, pctComplete: 0.5, plannedStart: d('2024-02-01'), plannedFinish: d('2024-04-01'), actualStart: d('2024-02-15') })
    ];
    const result = calculate(tasks, { dataDate: d('2024-03-01') }, 300, { interval: 'monthly' });
    near(result.rows.reduce((sum, row) => sum + row.plannedPeriodic, 0), 300, 0.000001);
    near(result.rows.reduce((sum, row) => sum + (row.actualPeriodic ?? 0), 0), 125, 0.000001);
  });

  it('places milestones in exactly one interval', () => {
    const result = calculate(
      [task({ isMilestone: true, plannedStart: d('2024-02-15'), plannedFinish: d('2024-02-15'), actualStart: d('2024-02-15'), wf: 10, earnedWf: 10, pctComplete: 1 })],
      { dataDate: d('2024-02-20') },
      10,
      { interval: 'monthly' }
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].plannedPeriodic, 10);
    assert.equal(result.rows[0].actualPeriodic, 10);
  });

  it('anchors weekly intervals by Monday or Sunday', () => {
    const t = task({ plannedStart: d('2024-01-07'), plannedFinish: d('2024-01-09'), actualStart: null, earnedWf: 0, pctComplete: 0, wf: 20 });
    const monday = calculate([t], { dataDate: d('2024-01-07') }, 20, { interval: 'weekly', weekStart: 'monday' });
    const sunday = calculate([t], { dataDate: d('2024-01-07') }, 20, { interval: 'weekly', weekStart: 'sunday' });
    assert.equal(monday.rows[0].label, 'WE 2024-01-07');
    assert.equal(sunday.rows[0].label, 'WE 2024-01-13');
  });

  it('stops actual values and anomalies after the data date', () => {
    const result = calculate([task({ plannedFinish: d('2017-06-01') })], { dataDate: d('2017-02-15') }, 300, { interval: 'monthly' });
    assert.equal(result.rows.slice(result.dataDateIntervalIndex + 1).every((row) => row.actualCumulativePct === null && row.actualAnomaly === null), true);
  });

  it('uses actual finish for completed tasks', () => {
    const result = calculate(
      [task({ actualStart: d('2024-01-01'), actualFinish: d('2024-01-11'), plannedStart: d('2024-01-01'), plannedFinish: d('2024-03-01'), pctComplete: 1, earnedWf: 100, wf: 100 })],
      { dataDate: d('2024-02-01') },
      100,
      { interval: 'monthly' }
    );
    near(result.rows[0].actualPeriodic, 100);
    near(result.rows[1].actualPeriodic, 0);
  });

  it('keeps UTC day math stable across DST windows', () => {
    const result = calculate(
      [task({ plannedStart: d('2024-03-25'), plannedFinish: d('2024-04-05'), actualStart: null, earnedWf: 0, pctComplete: 0, wf: 11 })],
      { dataDate: d('2024-03-30') },
      11,
      { interval: 'monthly' }
    );
    near(result.rows.reduce((sum, row) => sum + row.plannedPeriodic, 0), 11, 0.000001);
  });

  it('detects jump and stall anomalies independently for plan and actual', () => {
    const tasks = Array.from({ length: 8 }, (_, index) =>
      task({
        id: `P${index}`,
        plannedStart: d(`2024-${String(index + 1).padStart(2, '0')}-01`),
        plannedFinish: d(`2024-${String(index + 2).padStart(2, '0')}-01`),
        actualStart: index === 3 ? null : d(`2024-${String(index + 1).padStart(2, '0')}-01`),
        actualFinish: index === 3 ? null : d(`2024-${String(index + 2).padStart(2, '0')}-01`),
        wf: index === 4 ? 400 : 40,
        pctComplete: index === 3 ? 0 : 1,
        earnedWf: index === 3 ? 0 : 40
      })
    );
    const total = tasks.reduce((sum, item) => sum + item.wf, 0);
    const result = calculate(tasks, { dataDate: d('2024-08-15') }, total, { interval: 'monthly' });
    assert.ok(result.anomalies.some((item) => item.series === 'plan' && item.type === 'jump'));
    assert.ok(result.anomalies.some((item) => item.series === 'actual' && item.type === 'plunge'));
  });
});
