import {
  addUtcDays,
  addUtcMonths,
  dateFromUtcDay,
  firstOfUtcMonth,
  formatIsoDate,
  formatMonthLabel,
  utcDay
} from '../domain/date';
import type { Anomaly, IntervalRow, IntervalType, ProjectMeta, SCurveResult, Task, WeekStart } from '../domain/types';

type Interval = { label: string; start: Date; end: Date; startDay: number; endDay: number };

export function calculate(
  tasks: Task[],
  projectMeta: Pick<ProjectMeta, 'dataDate'>,
  totalWf: number,
  options: { interval: IntervalType; weekStart?: WeekStart } = { interval: 'monthly' }
): SCurveResult {
  const validTasks = tasks.filter((task) => task.plannedStart && task.plannedFinish && task.wf > 0);
  const starts = validTasks.flatMap((task) => [task.plannedStart, task.actualStart].filter(Boolean) as Date[]);
  const finishes = validTasks.map((task) => task.plannedFinish!).filter(Boolean);
  const gridStart = starts.length ? minDate(starts) : projectMeta.dataDate;
  const gridEnd = finishes.length ? maxDate(finishes) : projectMeta.dataDate;
  const intervals = buildGrid(gridStart, gridEnd, options);
  const plannedPeriodic = new Array(intervals.length).fill(0);
  const actualPeriodic = new Array(intervals.length).fill(0);
  const dataDateDay = utcDay(projectMeta.dataDate);
  const dataDateIntervalIndex = Math.max(0, intervals.findIndex((interval) => containsDay(interval, dataDateDay)));

  for (const task of validTasks) {
    distribute(plannedPeriodic, intervals, task.plannedStart!, task.plannedFinish!, task.wf, task.isMilestone);
    if (task.earnedWf > 0 && task.actualStart) {
      const finishDay = Math.min(task.actualFinish ? utcDay(task.actualFinish) : dataDateDay, dataDateDay);
      distribute(actualPeriodic, intervals, task.actualStart, dateFromUtcDay(finishDay), task.earnedWf, task.isMilestone);
    }
  }

  const rows: IntervalRow[] = [];
  let plannedCumulative = 0;
  let actualCumulative = 0;
  for (let index = 0; index < intervals.length; index += 1) {
    plannedCumulative += plannedPeriodic[index];
    const actualIsVisible = index <= dataDateIntervalIndex;
    if (actualIsVisible) actualCumulative += actualPeriodic[index] ?? 0;
    rows.push({
      index,
      label: intervals[index].label,
      start: intervals[index].start,
      end: intervals[index].end,
      plannedPeriodic: plannedPeriodic[index],
      plannedCumulative,
      plannedCumulativePct: pct(plannedCumulative, totalWf),
      actualPeriodic: actualIsVisible ? actualPeriodic[index] : null,
      actualCumulative: actualIsVisible ? actualCumulative : null,
      actualCumulativePct: actualIsVisible ? pct(actualCumulative, totalWf) : null,
      isDataDateInterval: index === dataDateIntervalIndex,
      planAnomaly: null,
      actualAnomaly: null
    });
  }

  const anomalies = [...detectAnomalies(rows, totalWf, 'plan'), ...detectAnomalies(rows, totalWf, 'actual', dataDateIntervalIndex)];
  for (const anomaly of anomalies) {
    if (anomaly.series === 'plan') rows[anomaly.rowIndex].planAnomaly = anomaly;
    else rows[anomaly.rowIndex].actualAnomaly = anomaly;
  }

  const dataRow = rows[dataDateIntervalIndex] ?? rows[rows.length - 1];
  const plannedAtData = plannedCumulativeAtDay(tasks, totalWf, dataDateDay);
  const actualPctAtDataDate = dataRow?.actualCumulativePct ?? 0;
  return {
    rows,
    anomalies,
    dataDateIntervalIndex,
    totals: {
      totalWf,
      plannedPctAtDataDate: plannedAtData,
      actualPctAtDataDate,
      scheduleVariancePct: actualPctAtDataDate - plannedAtData,
      overallActualPct: actualPctAtDataDate
    },
    meta: {
      interval: options.interval,
      weekStart: options.interval === 'weekly' ? (options.weekStart ?? 'monday') : undefined,
      gridStart,
      gridEnd
    }
  };
}

function distribute(periodic: number[], intervals: Interval[], start: Date, finish: Date, value: number, isMilestone: boolean): void {
  const startDay = utcDay(start);
  const finishDay = utcDay(finish);
  const duration = finishDay - startDay;
  if (isMilestone || duration === 0) {
    const index = intervals.findIndex((interval) => containsDay(interval, startDay));
    if (index >= 0) periodic[index] += value;
    return;
  }
  for (let index = 0; index < intervals.length; index += 1) {
    const overlap = Math.max(0, Math.min(finishDay, intervals[index].endDay) - Math.max(startDay, intervals[index].startDay));
    if (overlap > 0) periodic[index] += (value * overlap) / duration;
  }
}

function plannedCumulativeAtDay(tasks: Task[], totalWf: number, day: number): number {
  let cumulative = 0;
  for (const task of tasks) {
    if (!task.plannedStart || !task.plannedFinish || task.wf <= 0) continue;
    const start = utcDay(task.plannedStart);
    const finish = utcDay(task.plannedFinish);
    const duration = finish - start;
    if (task.isMilestone || duration === 0) {
      if (day >= start) cumulative += task.wf;
    } else if (day >= finish) {
      cumulative += task.wf;
    } else if (day > start) {
      cumulative += (task.wf * (day - start)) / duration;
    }
  }
  return pct(cumulative, totalWf);
}

function buildGrid(gridStart: Date, gridEnd: Date, options: { interval: IntervalType; weekStart?: WeekStart }): Interval[] {
  const intervals: Interval[] = [];
  if (options.interval === 'weekly') {
    const weekStart = options.weekStart ?? 'monday';
    let cursor = weekStartOnOrBefore(gridStart, weekStart);
    const endDay = utcDay(gridEnd);
    while (utcDay(cursor) < endDay) {
      const end = addUtcDays(cursor, 7);
      intervals.push({ label: `WE ${formatIsoDate(addUtcDays(end, -1))}`, start: cursor, end, startDay: utcDay(cursor), endDay: utcDay(end) });
      cursor = end;
    }
  } else {
    let cursor = firstOfUtcMonth(gridStart);
    const endDay = utcDay(gridEnd);
    while (utcDay(cursor) < endDay) {
      const end = addUtcMonths(cursor, 1);
      intervals.push({ label: formatMonthLabel(cursor), start: cursor, end, startDay: utcDay(cursor), endDay: utcDay(end) });
      cursor = end;
    }
  }
  return intervals.length ? intervals : [{ label: formatMonthLabel(gridStart), start: gridStart, end: addUtcMonths(firstOfUtcMonth(gridStart), 1), startDay: utcDay(gridStart), endDay: utcDay(addUtcMonths(firstOfUtcMonth(gridStart), 1)) }];
}

function detectAnomalies(rows: IntervalRow[], totalWf: number, series: 'plan' | 'actual', dataDateIndex = rows.length - 1): Anomaly[] {
  const limit = series === 'actual' ? dataDateIndex : rows.length - 1;
  if (totalWf <= 0) return [];
  const steps = rows.slice(0, limit + 1).map((row) => (series === 'plan' ? row.plannedPeriodic : (row.actualPeriodic ?? 0)) / totalWf * 100);
  const active = steps.filter((step) => step > 0.0001);
  if (active.length < 4) return [];
  const median = quantile(active, 0.5);
  const iqr = quantile(active, 0.75) - quantile(active, 0.25);
  const high = median + Math.max(1.5 * iqr, median * 1.25);
  const anomalies: Anomaly[] = [];
  for (let index = 1; index < steps.length - 1; index += 1) {
    if (index === 0 || index === rows.length - 1) continue;
    const step = steps[index];
    if (step >= high && step >= median * 1.5 && step >= 2) {
      anomalies.push({
        rowIndex: index,
        series,
        type: 'jump',
        periodicPct: step,
        note: `${seriesLabel(series)}: +${step.toFixed(1)}% this interval, well above the typical pace`
      });
    } else if (
      ((step <= 0.1 && steps[index - 1] > median * 0.5 && steps[index + 1] > median * 0.5) ||
        (iqr > 0 && step < median - 1.5 * iqr && steps[index - 1] > median * 0.5 && steps[index + 1] > median * 0.5))
    ) {
      anomalies.push({
        rowIndex: index,
        series,
        type: 'plunge',
        periodicPct: step,
        note: `${seriesLabel(series)}: stalled this interval after active progress`
      });
    }
  }
  return anomalies
    .sort((a, b) => Math.abs(b.periodicPct - median) - Math.abs(a.periodicPct - median))
    .slice(0, 4)
    .sort((a, b) => a.rowIndex - b.rowIndex);
}

function containsDay(interval: Interval, day: number): boolean {
  return day >= interval.startDay && day < interval.endDay;
}

function weekStartOnOrBefore(date: Date, weekStart: WeekStart): Date {
  const day = utcDay(date);
  const utcDow = date.getUTCDay();
  const desired = weekStart === 'monday' ? 1 : 0;
  const delta = (utcDow - desired + 7) % 7;
  return dateFromUtcDay(day - delta);
}

function pct(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] == null ? sorted[base] : sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function seriesLabel(series: 'plan' | 'actual'): string {
  return series === 'plan' ? 'Plan' : 'Actual';
}

function minDate(dates: Date[]): Date {
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function maxDate(dates: Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}
