import type { External } from './transfer';

/** rowdy's own image: its layer is added to every deployed image, after any layers-from source. */
export const ROWDY_LAYERS = 'ghcr.io/scaffoldly/rowdy:beta';

// The function runs this platform's copy; a source missing from any other cannot reach it.
const DEPLOYED_PLATFORM = 'linux/amd64';

/** How loudly to log a source a platform of the app does not get: only the platform Lambda runs is worth a warning. */
export const skippedLevel = (platform: string): 'warn' | 'debug' => (platform === DEPLOYED_PLATFORM ? 'warn' : 'debug');

/** One platform of a layers-from image: `platform` is `os/architecture`. */
export type SourcePlatform = { platform: string; image: External['Image']; config: External['Config'] };

// The first rule a platform breaks; undefined when its layers can go in as they are.
const brokenRule = ({ image, config }: SourcePlatform): string | undefined => {
  const layers = image.layers ?? [];
  if (!layers.length) {
    return 'no layers';
  }
  const diffIds = config.rootfs?.diff_ids ?? [];
  if (diffIds.length !== layers.length) {
    return `${layers.length} layers but ${diffIds.length} diff_ids`;
  }
  const history = config.history;
  if (!history?.length) {
    return 'no history';
  }
  const layerEntries = history.filter((entry) => entry.empty_layer !== true).length;
  if (layerEntries !== layers.length) {
    return `${layers.length} layers but ${layerEntries} layer entries in history`;
  }
  // Only the layers go in, not the config, so a tool that needs its own env wouldn't get it.
  const env = (config.config?.Env ?? []).find((entry) => !entry.startsWith('PATH='));
  if (env !== undefined) {
    return `Env sets ${env.split('=')[0]}`;
  }
  return undefined;
};

/** Throws for the first platform of `from` whose layers can't go in as they are. rowdy's own is exempt. */
export const checkSource = (from: string, platforms: SourcePlatform[]): void => {
  if (from === ROWDY_LAYERS) {
    return;
  }
  for (const source of platforms) {
    const rule = brokenRule(source);
    if (rule) {
      throw new Error(
        `layers-from ${from} (${source.platform}): ${rule}; only its layers go in, so they must match its config and it can't set Env beyond PATH`
      );
    }
  }
};
