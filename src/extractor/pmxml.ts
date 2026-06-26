import { SaxesParser } from 'saxes';
import { parsePmDate } from '../domain/date';
import type {
  ExtractResult,
  PercentType,
  ProjectionResult,
  QuarantineItem,
  ReconciledRecord,
  WeightColumn
} from '../domain/types';

type ActivityRaw = {
  id: string | null;
  name: string | null;
  type: string | null;
  status: string | null;
  projectObjId: string | null;
  plannedStart: Date | null;
  plannedFinish: Date | null;
  actualStart: Date | null;
  actualFinish: Date | null;
  pctUnits: number | null;
  pctPhysical: number | null;
  pctDuration: number | null;
  weightCandidates: Record<string, number | null>;
  raw: Record<string, unknown>;
};

type ParsedProject = {
  kind: 'Project' | 'BaselineProject';
  objectId: string | null;
  id: string | null;
  name: string | null;
  dataDate: Date | null;
  activities: ActivityRaw[];
};

type ParsedFile = {
  fileName: string;
  projects: ParsedProject[];
  udfTypes: Map<string, { title: string; dataType: string; subjectArea: string }>;
  wbsNodesDiscarded: number;
  excludedActivityCount: number;
  unknownTypes: Set<string>;
};

type UdfTypeDraft = Partial<{ objectId: string; title: string; dataType: string; subjectArea: string }>;
type UdfDraft = Partial<{ typeObjectId: string; value: number | null }>;

const STANDARD_WEIGHT_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'PlannedLaborUnits', label: 'Planned Labor Units (man-hours)' },
  { key: 'PlannedLaborCost', label: 'Planned Labor Cost' },
  { key: 'PlannedNonLaborUnits', label: 'Planned Non-Labor Units' },
  { key: 'PlannedTotalCost', label: 'Planned Total Cost' },
  { key: 'BudgetedTotalCost', label: 'Budgeted Total Cost' },
  { key: 'PlannedDuration', label: 'Planned Duration' }
];

const STANDARD_WEIGHT_KEYS = new Set(STANDARD_WEIGHT_FIELDS.map((field) => field.key));
const NUMERIC_UDF_TYPES = new Set(['double', 'integer', 'cost']);
const EXCLUDED_TYPES = new Set(['WBS Summary', 'Level of Effort']);
const KNOWN_TYPES = new Set(['Task Dependent', 'Resource Dependent', 'Start Milestone', 'Finish Milestone']);

export class NoEmbeddedBaselineError extends Error {
  constructor() {
    super('NO_EMBEDDED_BASELINE');
    this.name = 'NoEmbeddedBaselineError';
  }
}

export function parsePmxmlText(xml: string, fileName = 'fixture.xml'): ParsedFile {
  return parsePmxmlChunks([xml], fileName);
}

export function parsePmxmlChunks(chunks: Iterable<string>, fileName = 'fixture.xml'): ParsedFile {
  const result: ParsedFile = {
    fileName,
    projects: [],
    udfTypes: new Map(),
    wbsNodesDiscarded: 0,
    excludedActivityCount: 0,
    unknownTypes: new Set()
  };
  const parser = new SaxesParser({ xmlns: false, fragment: false });
  const stack: string[] = [];
  let text = '';
  let currentProject: ParsedProject | null = null;
  let currentActivity: ActivityRaw | null = null;
  let currentUdfType: UdfTypeDraft | null = null;
  let currentUdf: UdfDraft | null = null;

  parser.on('opentag', (node) => {
    const name = localName(node.name);
    stack.push(name);
    text = '';
    if (name === 'Project' || name === 'BaselineProject') {
      currentProject = { kind: name, objectId: null, id: null, name: null, dataDate: null, activities: [] };
      result.projects.push(currentProject);
    } else if (name === 'Activity' && currentProject) {
      currentActivity = {
        id: null,
        name: null,
        type: null,
        status: null,
        projectObjId: null,
        plannedStart: null,
        plannedFinish: null,
        actualStart: null,
        actualFinish: null,
        pctUnits: null,
        pctPhysical: null,
        pctDuration: null,
        weightCandidates: {},
        raw: {}
      };
    } else if (name === 'UDFType') {
      currentUdfType = {};
    } else if (name === 'UDF' && currentActivity) {
      currentUdf = {};
    } else if (name === 'WBS') {
      result.wbsNodesDiscarded += 1;
    }
  });

  parser.on('text', (value) => {
    text += value;
  });
  parser.on('cdata', (value) => {
    text += value;
  });
  parser.on('closetag', (tag) => {
    const name = localName(typeof tag === 'string' ? tag : tag.name);
    const value = text.trim();
    const parent = stack.length >= 2 ? stack[stack.length - 2] : null;

    if (currentUdfType && parent === 'UDFType') {
      assignUdfType(currentUdfType, name, value);
    } else if (currentActivity && currentUdf && parent === 'UDF') {
      assignUdf(currentUdf, name, value);
    } else if (currentActivity && parent === 'Activity') {
      assignActivityField(currentActivity, name, value);
    } else if (currentProject && parent === currentProject.kind) {
      assignProjectField(currentProject, name, value);
    }

    if (name === 'UDF' && currentActivity && currentUdf) {
      if (currentUdf.typeObjectId) {
        currentActivity.weightCandidates[`udf:${currentUdf.typeObjectId}`] = currentUdf.value ?? null;
      }
      currentUdf = null;
    } else if (name === 'UDFType' && currentUdfType) {
      if (
        currentUdfType.objectId &&
        currentUdfType.title &&
        currentUdfType.subjectArea === 'Activity' &&
        currentUdfType.dataType &&
        NUMERIC_UDF_TYPES.has(currentUdfType.dataType.toLowerCase())
      ) {
        result.udfTypes.set(currentUdfType.objectId, {
          title: currentUdfType.title,
          dataType: currentUdfType.dataType,
          subjectArea: currentUdfType.subjectArea
        });
      }
      currentUdfType = null;
    } else if (name === 'Activity' && currentProject && currentActivity) {
      if (currentActivity.type && EXCLUDED_TYPES.has(currentActivity.type)) {
        result.excludedActivityCount += 1;
      } else {
        if (currentActivity.type && !KNOWN_TYPES.has(currentActivity.type)) result.unknownTypes.add(currentActivity.type);
        currentProject.activities.push(currentActivity);
      }
      currentActivity = null;
    } else if ((name === 'Project' || name === 'BaselineProject') && currentProject?.kind === name) {
      currentProject = null;
    }

    stack.pop();
    text = '';
  });

  parser.on('error', (error) => {
    throw error;
  });

  for (const chunk of chunks) parser.write(chunk);
  parser.close();
  return result;
}

export async function extract(input: { mode: 'single'; file: File } | { mode: 'dual'; planFile: File; statusFile: File }): Promise<ExtractResult> {
  if (input.mode === 'single') {
    const parsed = await parsePmxmlFile(input.file);
    return buildSingleExtract(parsed);
  }
  const [plan, status] = await Promise.all([parsePmxmlFile(input.planFile), parsePmxmlFile(input.statusFile)]);
  return buildDualExtract(plan, status);
}

export async function parsePmxmlFile(file: File, onProgress?: (loaded: number) => void): Promise<ParsedFile> {
  const chunks: string[] = [];
  const decoder = new TextDecoder('utf-8');
  const reader = file.stream().getReader();
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    onProgress?.(loaded);
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return parsePmxmlChunks(chunks, file.name);
}

export function buildSingleExtract(file: ParsedFile): ExtractResult {
  const live = file.projects.find((project) => project.kind === 'Project');
  const baseline = file.projects.find((project) => project.kind === 'BaselineProject');
  if (!live || !baseline) throw new NoEmbeddedBaselineError();
  return reconcile({
    sourceMode: 'single',
    live,
    baseline,
    liveFile: file,
    planFile: null,
    udfTypes: file.udfTypes,
    wbsNodesDiscarded: file.wbsNodesDiscarded,
    excludedActivityCount: file.excludedActivityCount,
    unknownTypes: file.unknownTypes
  });
}

export function buildDualExtract(planFile: ParsedFile, statusFile: ParsedFile): ExtractResult {
  const baseline = planFile.projects.find((project) => project.kind === 'BaselineProject') ?? planFile.projects.find((project) => project.kind === 'Project');
  const live = statusFile.projects.find((project) => project.kind === 'Project');
  if (!baseline || !live) throw new Error('PARSE_ERROR: missing project in plan/status file');
  return reconcile({
    sourceMode: 'dual',
    live,
    baseline,
    liveFile: statusFile,
    planFile,
    udfTypes: new Map([...planFile.udfTypes, ...statusFile.udfTypes]),
    wbsNodesDiscarded: planFile.wbsNodesDiscarded + statusFile.wbsNodesDiscarded,
    excludedActivityCount: planFile.excludedActivityCount + statusFile.excludedActivityCount,
    unknownTypes: new Set([...planFile.unknownTypes, ...statusFile.unknownTypes])
  });
}

export function selectBasis(
  extractResult: ExtractResult,
  opts: { wfColumnKey: string; pctType: PercentType }
): ProjectionResult {
  const column = extractResult.weightColumns.find((item) => item.key === opts.wfColumnKey);
  const quarantine: QuarantineItem[] = [];
  const tasks = [];
  let totalWf = 0;

  for (const record of extractResult.records) {
    const reasons: string[] = [];
    const wf = record.weightCandidates[opts.wfColumnKey];
    const pctComplete = pickPct(record, opts.pctType);
    if (wf == null || Number.isNaN(wf)) reasons.push('MISSING_WF');
    else if (wf <= 0 && !record.isMilestone) reasons.push('NONPOSITIVE_WF');
    if (pctComplete == null || pctComplete < 0 || pctComplete > 1) reasons.push('PCT_OUT_OF_RANGE');
    if ((pctComplete ?? 0) > 0 && !record.actualStart && record.bucket === 'matched') {
      reasons.push('PROGRESS_WITHOUT_ACTUAL_START');
    }
    if (reasons.length) {
      quarantine.push({ id: record.id, reasons, raw: record as unknown as Record<string, unknown> });
      continue;
    }
    const safeWf = wf ?? 0;
    const safePct = record.bucket === 'baselineOnly' ? 0 : (pctComplete ?? 0);
    totalWf += safeWf;
    tasks.push({
      id: record.id,
      name: record.name,
      isMilestone: record.isMilestone,
      plannedStart: record.plannedStart,
      plannedFinish: record.plannedFinish,
      wf: safeWf,
      actualStart: record.actualStart,
      actualFinish: record.actualFinish,
      pctComplete: safePct,
      earnedWf: safeWf * safePct,
      status: record.status,
      bucket: record.bucket
    });
  }

  return {
    tasks,
    totalWf,
    quarantine,
    stats: {
      validTaskCount: tasks.length,
      quarantinedCount: quarantine.length,
      wfColumnUsed: opts.wfColumnKey,
      wfColumnLabel: column?.label ?? opts.wfColumnKey,
      pctTypeUsed: opts.pctType
    }
  };
}

function reconcile(args: {
  sourceMode: 'single' | 'dual';
  live: ParsedProject;
  baseline: ParsedProject;
  liveFile: ParsedFile;
  planFile: ParsedFile | null;
  udfTypes: Map<string, { title: string; dataType: string; subjectArea: string }>;
  wbsNodesDiscarded: number;
  excludedActivityCount: number;
  unknownTypes: Set<string>;
}): ExtractResult {
  const duplicateBaseline = findDuplicates(args.baseline.activities);
  const duplicateLive = findDuplicates(args.live.activities);
  const quarantine: QuarantineItem[] = [];
  for (const item of duplicateBaseline) quarantine.push({ id: item.id ?? '(missing id)', reasons: ['DUPLICATE_ID'], raw: item.raw });
  for (const item of duplicateLive) quarantine.push({ id: item.id ?? '(missing id)', reasons: ['DUPLICATE_ID'], raw: item.raw });

  const baselineById = indexById(args.baseline.activities, duplicateBaseline);
  const liveById = indexById(args.live.activities, duplicateLive);
  const records: ReconciledRecord[] = [];
  let matched = 0;
  let baselineOnly = 0;
  let liveOnly = 0;
  let milestoneCount = 0;

  for (const [id, planned] of baselineById) {
    const live = liveById.get(id) ?? null;
    const reasons = validatePlan(planned);
    if (live?.actualStart && args.live.dataDate && live.actualStart > args.live.dataDate) reasons.push('ACTUAL_START_AFTER_DATADATE');
    if (reasons.length) {
      quarantine.push({ id, reasons, raw: { planned, live } as unknown as Record<string, unknown> });
      continue;
    }
    const isMilestone = planned.type === 'Start Milestone' || planned.type === 'Finish Milestone';
    if (isMilestone) milestoneCount += 1;
    if (live) matched += 1;
    else baselineOnly += 1;
    records.push({
      id,
      name: planned.name ?? live?.name ?? null,
      isMilestone,
      bucket: live ? 'matched' : 'baselineOnly',
      status: live?.status ?? 'Not in live schedule',
      plannedStart: planned.plannedStart,
      plannedFinish: planned.plannedFinish,
      weightCandidates: planned.weightCandidates,
      actualStart: live?.actualStart ?? null,
      actualFinish: live?.actualFinish ?? null,
      pctUnits: live?.pctUnits ?? 0,
      pctPhysical: live?.pctPhysical ?? 0,
      pctDuration: live?.pctDuration ?? 0
    });
  }

  for (const [id, live] of liveById) {
    if (baselineById.has(id)) continue;
    liveOnly += 1;
    quarantine.push({ id, reasons: ['UNBASELINED_SCOPE'], raw: live as unknown as Record<string, unknown> });
  }

  const dataDate = args.live.dataDate ?? new Date(Date.UTC(1970, 0, 1));
  const weightColumns = buildWeightColumns(args.baseline.activities, args.udfTypes);
  return {
    records,
    projectMeta: {
      sourceMode: args.sourceMode,
      liveProjectObjectId: args.live.objectId ?? '',
      baselineProjectObjectId: args.baseline.objectId ?? '',
      liveProjectId: args.live.id ?? '',
      liveProjectName: args.live.name,
      baselineProjectId: args.baseline.id,
      baselineProjectName: args.baseline.name,
      liveFileName: args.liveFile.fileName,
      planFileName: args.planFile?.fileName ?? null,
      dataDate
    },
    weightColumns,
    reconciliation: { matched, baselineOnly, liveOnly },
    quarantine,
    summaryStats: {
      liveActivityCount: args.live.activities.length,
      baselineActivityCount: args.baseline.activities.length,
      wbsNodesDiscarded: args.wbsNodesDiscarded,
      excludedActivityCount: args.excludedActivityCount,
      milestoneCount,
      unknownTypes: Array.from(args.unknownTypes),
      udfTypesFound: Array.from(args.udfTypes.keys()).length,
      candidates: {
        hasPctUnits: args.live.activities.some((activity) => activity.pctUnits != null),
        hasPctPhysical: args.live.activities.some((activity) => activity.pctPhysical != null),
        hasPctDuration: args.live.activities.some((activity) => activity.pctDuration != null)
      }
    }
  };
}

function assignProjectField(project: ParsedProject, name: string, value: string): void {
  if (name === 'ObjectId') project.objectId = value;
  if (name === 'Id') project.id = value;
  if (name === 'Name') project.name = value;
  if (name === 'DataDate') project.dataDate = parsePmDate(value);
}

function assignActivityField(activity: ActivityRaw, name: string, value: string): void {
  activity.raw[name] = value;
  if (name === 'Id') activity.id = value;
  else if (name === 'Name') activity.name = value;
  else if (name === 'Type') activity.type = value;
  else if (name === 'Status') activity.status = value;
  else if (name === 'ProjectObjectId') activity.projectObjId = value;
  else if (name === 'PlannedStartDate') activity.plannedStart = parsePmDate(value);
  else if (name === 'PlannedFinishDate') activity.plannedFinish = parsePmDate(value);
  else if (name === 'ActualStartDate') activity.actualStart = parsePmDate(value);
  else if (name === 'ActualFinishDate') activity.actualFinish = parsePmDate(value);
  else if (name === 'UnitsPercentComplete') activity.pctUnits = parseNumber(value);
  else if (name === 'PhysicalPercentComplete') activity.pctPhysical = parseNumber(value);
  else if (name === 'DurationPercentComplete') activity.pctDuration = parseNumber(value);
  if (STANDARD_WEIGHT_KEYS.has(name) || isExtraPlannedNumericCandidate(name, value)) {
    activity.weightCandidates[name] = parseNumber(value);
  }
}

function assignUdfType(udf: UdfTypeDraft, name: string, value: string): void {
  if (name === 'ObjectId') udf.objectId = value;
  else if (name === 'Title') udf.title = value;
  else if (name === 'DataType') udf.dataType = value;
  else if (name === 'SubjectArea') udf.subjectArea = value;
}

function assignUdf(udf: UdfDraft, name: string, value: string): void {
  if (name === 'TypeObjectId') udf.typeObjectId = value;
  if (name === 'DoubleValue' || name === 'IntegerValue' || name === 'CostValue') udf.value = parseNumber(value);
}

function pickPct(record: ReconciledRecord, pctType: PercentType): number | null {
  if (pctType === 'Units') return record.pctUnits;
  if (pctType === 'Physical') return record.pctPhysical;
  return record.pctDuration;
}

function validatePlan(activity: ActivityRaw): string[] {
  const reasons: string[] = [];
  if (!activity.plannedStart) reasons.push('MISSING_PLANNED_START');
  if (!activity.plannedFinish) reasons.push('MISSING_PLANNED_FINISH');
  if (activity.plannedStart && activity.plannedFinish && activity.plannedFinish < activity.plannedStart) {
    reasons.push('NEGATIVE_PLANNED_DURATION');
  }
  return reasons;
}

function buildWeightColumns(
  baselineActivities: ActivityRaw[],
  udfTypes: Map<string, { title: string; dataType: string; subjectArea: string }>
): WeightColumn[] {
  const keys = new Set<string>();
  for (const activity of baselineActivities) {
    for (const key of Object.keys(activity.weightCandidates)) keys.add(key);
  }
  const populatedCount = (key: string) =>
    baselineActivities.filter((activity) => {
      const value = activity.weightCandidates[key];
      return typeof value === 'number' && Number.isFinite(value) && value > 0;
    }).length;
  const standard = STANDARD_WEIGHT_FIELDS.filter((field) => keys.has(field.key)).map((field) => ({
    ...field,
    source: 'standard' as const,
    populatedCount: populatedCount(field.key)
  }));
  const extras = Array.from(keys)
    .filter((key) => !STANDARD_WEIGHT_KEYS.has(key) && !key.startsWith('udf:'))
    .sort()
    .map((key) => ({ key, label: key, source: 'standard' as const, populatedCount: populatedCount(key) }));
  const udf = Array.from(keys)
    .filter((key) => key.startsWith('udf:'))
    .sort((a, b) => (udfTypes.get(a.slice(4))?.title ?? a).localeCompare(udfTypes.get(b.slice(4))?.title ?? b))
    .map((key) => ({
      key,
      label: udfTypes.get(key.slice(4))?.title ?? key,
      source: 'udf' as const,
      populatedCount: populatedCount(key)
    }));
  return [...standard, ...extras, ...udf];
}

function findDuplicates(activities: ActivityRaw[]): ActivityRaw[] {
  const counts = new Map<string, number>();
  for (const activity of activities) {
    if (!activity.id) continue;
    counts.set(activity.id, (counts.get(activity.id) ?? 0) + 1);
  }
  return activities.filter((activity) => activity.id && (counts.get(activity.id) ?? 0) > 1);
}

function indexById(activities: ActivityRaw[], duplicates: ActivityRaw[]): Map<string, ActivityRaw> {
  const duplicateIds = new Set(duplicates.map((activity) => activity.id).filter(Boolean));
  const map = new Map<string, ActivityRaw>();
  for (const activity of activities) {
    if (!activity.id || duplicateIds.has(activity.id)) continue;
    map.set(activity.id, activity);
  }
  return map;
}

function isExtraPlannedNumericCandidate(name: string, value: string): boolean {
  return /^(Planned|Budgeted).*(Cost|Units|Duration|Quantity|Amount)$/i.test(name) && parseNumber(value) != null;
}

function parseNumber(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function localName(name: string): string {
  return name.includes(':') ? name.split(':').pop()! : name;
}
