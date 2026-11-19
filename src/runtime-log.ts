/**
 * The process's own logger, for rowdy's runtime and CLI: the proxy, the shell, and the Lambda and microVM bootstraps.
 * The SDK never imports this module (tests/sdk-logger.test.ts): a sandbox logs only to the logger its host gave it.
 *
 * @module
 */
export { log as runtimeLog } from '@scaffoldly/rowdy-cdk';
