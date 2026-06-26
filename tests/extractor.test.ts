import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDualExtract,
  buildSingleExtract,
  NoEmbeddedBaselineError,
  parsePmxmlChunks,
  parsePmxmlText,
  selectBasis
} from '../src/extractor/pmxml';

function expect<T>(actual: T) {
  return {
    toBe(expected: unknown) {
      assert.equal(actual, expected);
    },
    toEqual(expected: unknown) {
      assert.deepEqual(actual, expected);
    },
    toHaveLength(expected: number) {
      assert.equal((actual as { length: number }).length, expected);
    },
    toThrow(expected: unknown) {
      assert.throws(actual as () => unknown, expected as never);
    }
  };
}

const xmlHead = `<?xml version="1.0" encoding="UTF-8"?><APIBusinessObjects>`;
const xmlTail = `</APIBusinessObjects>`;

function project(kind: 'Project' | 'BaselineProject', objectId: string, id: string, body: string, dataDate = '2024-02-15T00:00:00') {
  return `<${kind}>
    <ObjectId>${objectId}</ObjectId>
    <Id>${id}</Id>
    <Name>${id} name</Name>
    <DataDate>${dataDate}</DataDate>
    ${body}
  </${kind}>`;
}

function activity(id: string, body: string) {
  return `<Activity>
    <Id>${id}</Id>
    <Name>Task ${id}</Name>
    <Type>Task Dependent</Type>
    <Status>In Progress</Status>
    ${body}
  </Activity>`;
}

const udfTypes = `
  <UDFType><ObjectId>48</ObjectId><SubjectArea>Activity</SubjectArea><DataType>Double</DataType><Title>Custom Weight</Title></UDFType>
  <UDFType><ObjectId>49</ObjectId><SubjectArea>Activity</SubjectArea><DataType>Text</DataType><Title>Not Numeric</Title></UDFType>
`;

describe('PMXML extractor', () => {
  it('parses single-file embedded baseline and projects the default basis', () => {
    const live = project(
      'Project',
      '100',
      'LIVE',
      activity('A1', '<ActualStartDate>2024-01-10T08:00:00</ActualStartDate><UnitsPercentComplete>0.5</UnitsPercentComplete>') +
        activity('A2', '<ActualStartDate>2024-01-20T08:00:00</ActualStartDate><UnitsPercentComplete>1</UnitsPercentComplete>')
    );
    const base = project(
      'BaselineProject',
      '101',
      'BASE',
      activity('A1', '<PlannedStartDate>2024-01-01T08:00:00</PlannedStartDate><PlannedFinishDate>2024-02-01T17:00:00</PlannedFinishDate><PlannedLaborUnits>100</PlannedLaborUnits>') +
        activity('A2', '<PlannedStartDate>2024-02-01T08:00:00</PlannedStartDate><PlannedFinishDate>2024-03-01T17:00:00</PlannedFinishDate><PlannedLaborUnits>200</PlannedLaborUnits>')
    );
    const extract = buildSingleExtract(parsePmxmlText(`${xmlHead}${live}${base}${xmlTail}`));
    const projection = selectBasis(extract, { wfColumnKey: 'PlannedLaborUnits', pctType: 'Units' });
    expect(extract.reconciliation).toEqual({ matched: 2, baselineOnly: 0, liveOnly: 0 });
    expect(projection.totalWf).toBe(300);
    expect(projection.tasks.map((task) => task.earnedWf)).toEqual([50, 200]);
  });

  it('parses two-file plan and status schedules', () => {
    const plan = parsePmxmlText(
      `${xmlHead}${project('Project', '201', 'PLAN', activity('A1', '<PlannedStartDate>2024-01-01T08:00:00</PlannedStartDate><PlannedFinishDate>2024-01-10T17:00:00</PlannedFinishDate><PlannedLaborUnits>10</PlannedLaborUnits>'))}${xmlTail}`,
      'plan.xml'
    );
    const status = parsePmxmlText(
      `${xmlHead}${project('Project', '200', 'STATUS', activity('A1', '<ActualStartDate>2024-01-02T08:00:00</ActualStartDate><UnitsPercentComplete>0.25</UnitsPercentComplete>'))}${xmlTail}`,
      'status.xml'
    );
    const extract = buildDualExtract(plan, status);
    expect(extract.projectMeta.sourceMode).toBe('dual');
    expect(extract.reconciliation.matched).toBe(1);
    expect(selectBasis(extract, { wfColumnKey: 'PlannedLaborUnits', pctType: 'Units' }).tasks[0].earnedWf).toBe(2.5);
  });

  it('signals when a single file has no embedded baseline', () => {
    expect(() =>
      buildSingleExtract(parsePmxmlText(`${xmlHead}${project('Project', '100', 'LIVE', '')}${xmlTail}`))
    ).toThrow(NoEmbeddedBaselineError);
  });

  it('enumerates standard and numeric UDF weight columns and can select the custom basis', () => {
    const live = project(
      'Project',
      '100',
      'LIVE',
      activity('A1', '<ActualStartDate>2024-01-01T08:00:00</ActualStartDate><PhysicalPercentComplete>0.2</PhysicalPercentComplete>') +
        activity('A2', '<ActualStartDate>2024-01-01T08:00:00</ActualStartDate><PhysicalPercentComplete>0.5</PhysicalPercentComplete>')
    );
    const base = project(
      'BaselineProject',
      '101',
      'BASE',
      activity('A1', '<PlannedStartDate>2024-01-01T08:00:00</PlannedStartDate><PlannedFinishDate>2024-01-10T17:00:00</PlannedFinishDate><PlannedLaborUnits>10</PlannedLaborUnits><PlannedLaborCost>30</PlannedLaborCost><UDF><TypeObjectId>48</TypeObjectId><DoubleValue>7</DoubleValue></UDF>') +
        activity('A2', '<PlannedStartDate>2024-01-01T08:00:00</PlannedStartDate><PlannedFinishDate>2024-01-10T17:00:00</PlannedFinishDate><PlannedLaborUnits>20</PlannedLaborUnits><PlannedLaborCost>60</PlannedLaborCost><UDF><TypeObjectId>48</TypeObjectId><DoubleValue>3</DoubleValue></UDF>')
    );
    const extract = buildSingleExtract(parsePmxmlText(`${xmlHead}${udfTypes}${live}${base}${xmlTail}`));
    expect(extract.weightColumns.map((column) => column.key)).toEqual(['PlannedLaborUnits', 'PlannedLaborCost', 'udf:48']);
    expect(extract.weightColumns[2].label).toBe('Custom Weight');
    const projection = selectBasis(extract, { wfColumnKey: 'udf:48', pctType: 'Physical' });
    expect(projection.totalWf).toBe(10);
    expect(projection.tasks.map((task) => task.wf)).toEqual([7, 3]);
  });

  it('handles baselineOnly, liveOnly, milestones, WBS discard, duplicates, and basis quarantine', () => {
    const live = project(
      'Project',
      '100',
      'LIVE',
      activity('A1', '<ActualStartDate>2024-01-01T08:00:00</ActualStartDate><UnitsPercentComplete>0.4</UnitsPercentComplete>') +
        activity('LIVEONLY', '<ActualStartDate>2024-01-01T08:00:00</ActualStartDate><UnitsPercentComplete>0.4</UnitsPercentComplete>')
    );
    const base = project(
      'BaselineProject',
      '101',
      'BASE',
      '<WBS><Name>Summary</Name></WBS>' +
        activity('A1', '<PlannedStartDate>2024-01-01T08:00:00</PlannedStartDate><PlannedFinishDate>2024-01-01T08:00:00</PlannedFinishDate><Type>Start Milestone</Type><PlannedLaborUnits>0</PlannedLaborUnits>') +
        activity('BASEONLY', '<PlannedStartDate>2024-01-01T08:00:00</PlannedStartDate><PlannedFinishDate>2024-01-10T17:00:00</PlannedFinishDate><PlannedLaborUnits>5</PlannedLaborUnits>') +
        activity('DUP', '<PlannedStartDate>2024-01-01T08:00:00</PlannedStartDate><PlannedFinishDate>2024-01-10T17:00:00</PlannedFinishDate><PlannedLaborUnits>5</PlannedLaborUnits>') +
        activity('DUP', '<PlannedStartDate>2024-01-01T08:00:00</PlannedStartDate><PlannedFinishDate>2024-01-10T17:00:00</PlannedFinishDate><PlannedLaborUnits>5</PlannedLaborUnits>')
    );
    const extract = buildSingleExtract(parsePmxmlText(`${xmlHead}${live}${base}${xmlTail}`));
    const projection = selectBasis(extract, { wfColumnKey: 'PlannedLaborUnits', pctType: 'Units' });
    expect(extract.summaryStats.wbsNodesDiscarded).toBe(1);
    expect(extract.reconciliation.baselineOnly).toBe(1);
    expect(extract.reconciliation.liveOnly).toBe(1);
    expect(extract.quarantine.some((item) => item.reasons.includes('UNBASELINED_SCOPE'))).toBe(true);
    expect(extract.quarantine.some((item) => item.reasons.includes('DUPLICATE_ID'))).toBe(true);
    expect(projection.tasks.find((task) => task.id === 'A1')?.isMilestone).toBe(true);
  });

  it('keeps parsing stable across chunk boundaries and multibyte text', () => {
    const xml = `${xmlHead}${project(
      'Project',
      '100',
      'LIVE',
      activity('A1', '<ActualStartDate>2024-01-01T08:00:00</ActualStartDate><UnitsPercentComplete>0.4</UnitsPercentComplete>')
    )}${project(
      'BaselineProject',
      '101',
      'BASE',
      activity('A1', '<Name>Tâche café</Name><PlannedStartDate>2024-01-01T08:00:00</PlannedStartDate><PlannedFinishDate>2024-01-10T17:00:00</PlannedFinishDate><PlannedLaborUnits>5</PlannedLaborUnits>')
    )}${xmlTail}`;
    const whole = buildSingleExtract(parsePmxmlText(xml));
    const split = buildSingleExtract(parsePmxmlChunks([xml.slice(0, 211), xml.slice(211, 388), xml.slice(388)]));
    expect(split.records).toHaveLength(whole.records.length);
    expect(split.records[0].name).toBe(whole.records[0].name);
  });
});
