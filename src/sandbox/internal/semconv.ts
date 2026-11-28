/**
 * The OpenTelemetry attribute names rowdy's spans use, copied from `@opentelemetry/semantic-conventions` 1.45.0's
 * `/incubating` entry, as it advises: importing that entry bundles every name it has, over 1.5 MB.
 */
export const ATTR_CONTAINER_IMAGE_NAME = 'container.image.name' as const;
export const ATTR_FILE_PATH = 'file.path' as const;
export const ATTR_FILE_SIZE = 'file.size' as const;
export const ATTR_PROCESS_ARGS_COUNT = 'process.args_count' as const;
export const ATTR_PROCESS_COMMAND = 'process.command' as const;
export const ATTR_PROCESS_COMMAND_LINE = 'process.command_line' as const;
export const ATTR_PROCESS_EXIT_CODE = 'process.exit.code' as const;
export const ATTR_PROCESS_WORKING_DIRECTORY = 'process.working_directory' as const;
export const ATTR_URL_FULL = 'url.full' as const;
export const ATTR_URL_PORT = 'url.port' as const;
