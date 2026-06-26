export type PercentType = 'Units' | 'Physical' | 'Duration';
export type IntervalType = 'monthly' | 'weekly';
export type WeekStart = 'monday' | 'sunday';

export type WeightColumn = {
  key: string;
  label: string;
  source: 'standard' | 'udf';
  populatedCount: number;
};

export type ProjectMeta = {
  sourceMode: 'single' | 'dual';
  liveProjectObjectId: string;
  baselineProjectObjectId: string;
  liveProjectId: string;
  liveProjectName: string | null;
  baselineProjectId: string | null;
  baselineProjectName: string | null;
  liveFileName: string;
  planFileName: string | null;
  dataDate: Date;
};

export type ReconciledRecord = {
  id: string;
  name: string | null;
  isMilestone: boolean;
  bucket: 'matched' | 'baselineOnly';
  status: string;
  plannedStart: Date | null;
  plannedFinish: Date | null;
  weightCandidates: Record<string, number | null>;
  actualStart: Date | null;
  actualFinish: Date | null;
  pctUnits: number | null;
  pctPhysical: number | null;
  pctDuration: number | null;
};

export type QuarantineItem = {
  id: string;
  reasons: string[];
  raw: Record<string, unknown>;
};

export type ExtractResult = {
  records: ReconciledRecord[];
  projectMeta: ProjectMeta;
  weightColumns: WeightColumn[];
  reconciliation: { matched: number; baselineOnly: number; liveOnly: number };
  quarantine: QuarantineItem[];
  summaryStats: {
    liveActivityCount: number;
    baselineActivityCount: number;
    wbsNodesDiscarded: number;
    excludedActivityCount: number;
    milestoneCount: number;
    unknownTypes: string[];
    udfTypesFound: number;
    candidates: {
      hasPctUnits: boolean;
      hasPctPhysical: boolean;
      hasPctDuration: boolean;
    };
  };
};

export type Task = {
  id: string;
  name: string | null;
  isMilestone: boolean;
  plannedStart: Date | null;
  plannedFinish: Date | null;
  wf: number;
  actualStart: Date | null;
  actualFinish?: Date | null;
  pctComplete: number;
  earnedWf: number;
  status: string;
  bucket: 'matched' | 'baselineOnly';
};

export type ProjectionResult = {
  tasks: Task[];
  totalWf: number;
  quarantine: QuarantineItem[];
  stats: {
    validTaskCount: number;
    quarantinedCount: number;
    wfColumnUsed: string;
    wfColumnLabel: string;
    pctTypeUsed: PercentType;
  };
};

export type Anomaly = {
  rowIndex: number;
  series: 'plan' | 'actual';
  type: 'jump' | 'plunge';
  periodicPct: number;
  note: string;
};

export type IntervalRow = {
  index: number;
  label: string;
  start: Date;
  end: Date;
  plannedPeriodic: number;
  plannedCumulative: number;
  plannedCumulativePct: number;
  actualPeriodic: number | null;
  actualCumulative: number | null;
  actualCumulativePct: number | null;
  isDataDateInterval: boolean;
  planAnomaly: Anomaly | null;
  actualAnomaly: Anomaly | null;
};

export type SCurveResult = {
  rows: IntervalRow[];
  anomalies: Anomaly[];
  dataDateIntervalIndex: number;
  totals: {
    totalWf: number;
    plannedPctAtDataDate: number;
    actualPctAtDataDate: number;
    scheduleVariancePct: number;
    overallActualPct: number;
  };
  meta: { interval: IntervalType; weekStart?: WeekStart; gridStart: Date; gridEnd: Date };
};
