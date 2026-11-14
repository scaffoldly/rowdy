/**
 * What a host needs of rowdy's sandboxes without their runtimes: the defaults and sizes a sandbox takes, rowdy's own
 * port in a microVM, and its errors, said for a person. It loads no AWS client, so a host like a Cloudflare Worker can
 * import it for little.
 *
 * @module
 */
export { DEFAULTS, MICROVM_MEMORY, SandboxError } from './internal/compute';
/** rowdy's own port in a microVM. A `url()` token for it can run any command, so never hand one out. */
export { HOOKS_PORT } from '../aws/microvm/hooks';
export { describeError, humanize, OUT_OF_REQUESTS, type ErrorDescription } from '../aws/errors';
