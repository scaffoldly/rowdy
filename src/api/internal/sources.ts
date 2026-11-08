import { specList } from '../../util/list';
import { ROWDY_LAYERS } from './layers';

/** The user's layers-from images, from repeated flags or `ROWDY_LAYERS_FROM`: the first of a repeat, without rowdy's. */
export const layerSources = (value: string | string[] | undefined): string[] => {
  const all = [value ?? []].flat().flatMap((entry) => specList(entry));
  return [...new Set(all)].filter((source) => source !== ROWDY_LAYERS);
};

/** The images whose layers a deploy adds, in order: the user's, then rowdy's. */
export const deploySources = (value: string | string[] | undefined): string[] => [...layerSources(value), ROWDY_LAYERS];
