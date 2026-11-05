import type { MaintenanceWindow } from "@lorenzh/pulse-contract";
import type { FileMaintenanceWindow } from "./config.ts";
import type { WindowDefinition } from "./maintenance-store.ts";

/** The windows in effect: the applied file wins over a database window with the same id. */
export interface EffectiveMaintenance {
  /**
   * File windows in file order without their id, then one entry per effective check id of each
   * unshadowed database window, in creation order. Exactly `checkId, start, end, note`.
   */
  windows: MaintenanceWindow[];
  /** Database windows whose id no file window holds, in creation order. */
  effective: WindowDefinition[];
  /** Database windows whose id a file window holds; stored, but not applied. */
  shadowed: WindowDefinition[];
}

/** The public form of a file window: its id is not part of public JSON. */
export function publicWindow(w: FileMaintenanceWindow): MaintenanceWindow {
  return { checkId: w.checkId, start: w.start, end: w.end, note: w.note };
}

/**
 * Project the file windows and the database definitions onto the effective checks. A database
 * check id that is not effective right now is skipped, not removed from the definition.
 */
export function effectiveMaintenance(
  file: readonly FileMaintenanceWindow[],
  definitions: readonly WindowDefinition[],
  checkIds: ReadonlySet<string>,
): EffectiveMaintenance {
  const windows = file.map(publicWindow);
  const fileIds = new Set(file.flatMap((w) => (w.id === undefined ? [] : [w.id])));
  const effective: WindowDefinition[] = [];
  const shadowed: WindowDefinition[] = [];
  for (const definition of definitions) {
    if (fileIds.has(definition.id)) {
      shadowed.push(definition);
      continue;
    }
    effective.push(definition);
    const { start, end, note } = definition;
    for (const checkId of definition.checkIds) {
      if (checkIds.has(checkId)) windows.push({ checkId, start, end, note });
    }
  }
  return { windows, effective, shadowed };
}
