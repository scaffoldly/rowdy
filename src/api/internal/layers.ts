import { specList } from '../../util/list';
import type { External } from './transfer';

/** rowdy's own image: its one layer is added to every deployed image, after any layers-from source. */
export const ROWDY_LAYERS = 'ghcr.io/scaffoldly/rowdy:beta';

/** The largest compressed layer a layers-from image may have. */
export const MAX_LAYER_BYTES = 64 * 1024 * 1024;

// The one non-empty history entry must add files; only these may sit beside it.
const LAYER_INSTRUCTIONS: ReadonlyArray<string> = ['COPY', 'ADD'];
const EMPTY_INSTRUCTIONS: ReadonlyArray<string> = ['ENTRYPOINT', 'CMD', 'LABEL'];

/** One platform of a layers-from image: `platform` is `os/architecture`. */
export type SourcePlatform = { platform: string; image: External['Image']; config: External['Config'] };

/** The user's layers-from images, from repeated flags or `ROWDY_LAYERS_FROM`: the first of a repeat, without rowdy's. */
export const layerSources = (value: string | string[] | undefined): string[] => {
  const all = [value ?? []].flat().flatMap((entry) => specList(entry));
  return [...new Set(all)].filter((source) => source !== ROWDY_LAYERS);
};

/** The images whose layers a deploy adds, in order: the user's, then rowdy's. */
export const deploySources = (value: string | string[] | undefined): string[] => [...layerSources(value), ROWDY_LAYERS];

/** The Dockerfile instruction a history entry's `created_by` records, buildkit's or the classic builder's. */
export const instructionOf = (createdBy: string): string => {
  const nop = /^\/bin\/sh -c #\(nop\)\s+/.exec(createdBy);
  if (nop) {
    return (createdBy.slice(nop[0].length).split(/\s+/)[0] ?? '').toUpperCase();
  }
  if (createdBy.startsWith('/bin/sh -c ')) {
    return 'RUN';
  }
  return (createdBy.trim().split(/\s+/)[0] ?? '').toUpperCase();
};

// The first rule a platform breaks, in the order of rowdy's own final stage; undefined when it keeps them all.
const brokenRule = ({ image, config }: SourcePlatform): string | undefined => {
  const layers = image.layers ?? [];
  if (layers.length !== 1) {
    return `${layers.length} layers`;
  }
  const diffIds = config.rootfs?.diff_ids ?? [];
  if (diffIds.length !== 1) {
    return `${diffIds.length} diff_ids`;
  }
  const size = layers[0]?.size ?? 0;
  if (size > MAX_LAYER_BYTES) {
    return `layer is ${size} bytes, over ${MAX_LAYER_BYTES}`;
  }
  const history = config.history;
  if (!history?.length) {
    return 'no history';
  }
  let layerEntries = 0;
  for (const entry of history) {
    const instruction = instructionOf(typeof entry.created_by === 'string' ? entry.created_by : '');
    const empty = entry.empty_layer === true;
    if (!(empty ? EMPTY_INSTRUCTIONS : LAYER_INSTRUCTIONS).includes(instruction)) {
      return `${instruction || 'an unnamed step'} in history`;
    }
    if (!empty) {
      layerEntries++;
    }
  }
  if (layerEntries !== 1) {
    return `${layerEntries} layer entries in history`;
  }
  const env = (config.config?.Env ?? []).find((entry) => !entry.startsWith('PATH='));
  if (env !== undefined) {
    return `Env sets ${env.split('=')[0]}`;
  }
  return undefined;
};

/** Throws for the first platform of `from` that is not one small layer, as rowdy's own image is. */
export const checkSource = (from: string, platforms: SourcePlatform[]): void => {
  for (const source of platforms) {
    const rule = brokenRule(source);
    if (rule) {
      throw new Error(
        `layers-from ${from} (${source.platform}): ${rule}; a layers-from image must be one small layer, as rowdy's is (FROM scratch, one COPY, ENTRYPOINT)`
      );
    }
  }
};
