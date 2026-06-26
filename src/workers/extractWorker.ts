import { buildDualExtract, buildSingleExtract, NoEmbeddedBaselineError, parsePmxmlFile } from '../extractor/pmxml';

type WorkerRequest =
  | { mode: 'single'; file: File }
  | { mode: 'dual'; planFile: File; statusFile: File };

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.mode === 'single') {
      const file = request.file;
      postMessage({ type: 'progress', label: file.name, loaded: 0, total: file.size });
      const parsed = await parsePmxmlFile(file, (loaded) =>
        postMessage({ type: 'progress', label: file.name, loaded, total: file.size })
      );
      postMessage({ type: 'done', result: buildSingleExtract(parsed) });
      return;
    }
    let loadedPlan = 0;
    let loadedStatus = 0;
    const planFile = request.planFile;
    const statusFile = request.statusFile;
    const total = planFile.size + statusFile.size;
    const plan = await parsePmxmlFile(planFile, (loaded) => {
      loadedPlan = loaded;
      postMessage({ type: 'progress', label: planFile.name, loaded: loadedPlan + loadedStatus, total });
    });
    const status = await parsePmxmlFile(statusFile, (loaded) => {
      loadedStatus = loaded;
      postMessage({ type: 'progress', label: statusFile.name, loaded: loadedPlan + loadedStatus, total });
    });
    postMessage({ type: 'done', result: buildDualExtract(plan, status) });
  } catch (error) {
    if (error instanceof NoEmbeddedBaselineError) {
      postMessage({ type: 'need-plan' });
    } else {
      postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }
};
