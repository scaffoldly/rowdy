/**
 * What a host needs of rowdy's sandboxes without their runtimes: the defaults and sizes a sandbox takes, and its
 * errors, said for a person. It loads no AWS client, so a host like a Cloudflare Worker can import it for little.
 *
 * @module
 */
export { DEFAULTS, MICROVM_MEMORY, SandboxError } from './internal/compute';
export { describeError, humanize, OUT_OF_REQUESTS, type ErrorDescription } from '../aws/errors';
