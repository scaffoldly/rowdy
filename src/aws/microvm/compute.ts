import type { StartLiveTailCommandInput } from '@aws-sdk/client-cloudwatch-logs';
import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  GetMicrovmImageCommand,
  GetMicrovmImageVersionCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  ListTagsCommand,
  paginateListMicrovmImages,
  paginateListMicrovms,
  RunMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import {
  catchError,
  concatMap,
  defer,
  filter,
  first,
  forkJoin,
  from,
  last,
  map,
  merge,
  mergeMap,
  finalize,
  Observable,
  of,
  repeat,
  shareReplay,
  switchMap,
  toArray,
} from 'rxjs';
import type { AwsSandboxOptions, FileRange, SandboxStatus, SandboxSummary } from '../../sandbox';
import { Exec, ExecOutput, ExecOutputOptions } from '../../api/types';
import type { SandboxEnvironment } from '../../sandbox/internal/environment';
import { Logger } from '../../log';
import { ExecSchema } from '../../routes';
import { ComputeSpec, MICROVM_MEMORY, SandboxCompute, SandboxError } from '../../sandbox/internal/compute';
import { META_TAG, TAG_KEY_REGEX, TAG_VALUE_REGEX } from '../tags';
import { isNotFound } from '../lambda/shared';
import { AwsClientLogger } from '../logger';
import { EXEC_LOG } from '../../proxy/frames';
import { execOf, execOutput, framesOf } from '../exec';
import { EXEC_ID_HEADER, EXEC_PATH, FILES_PATH, HOOKS_PORT } from './hooks';
import { concurrency } from '../../concurrency';
import { COMPUTE_TAG, MicrovmImage, POLL, TIMEOUT_TAG } from './image';

const DEAD: ReadonlyArray<string> = ['TERMINATING', 'TERMINATED'];

export { POLL };

/** How often a terminating VM is polled, in milliseconds. */
export const TERMINATE_POLL = { delay: 250 };

type Vm = { microvmId: string; endpoint: string; imageVersion: string; startedAt: Date };

/** Each image's VM while it's being found or started, shared by every handle in the process. */
const STARTING = new Map<string, Observable<Vm>>();

export class MicrovmCompute extends AwsClientLogger implements SandboxCompute {
  static readonly env = {};

  static list(credentials?: AwsSandboxOptions['credentials']): Observable<SandboxSummary> {
    // One ListTags per image, so a busy host is throttled: adaptive retries slow down until AWS lets them through.
    const microvms = new LambdaMicrovmsClient({ credentials, retryMode: 'adaptive', maxAttempts: 8 });
    return forkJoin([
      from(paginateListMicrovms({ client: microvms }, {})).pipe(
        concatMap(({ items = [] }) => items),
        toArray()
      ),
      from(paginateListMicrovmImages({ client: microvms }, {})).pipe(
        concatMap(({ items = [] }) => items),
        toArray()
      ),
    ]).pipe(
      switchMap(([vms, images]) =>
        from(images).pipe(
          // A deleted sandbox's image lingers for a while.
          filter(({ state }) => state !== 'DELETING' && state !== 'DELETED'),
          mergeMap(
            ({ imageArn, name, state, latestActiveImageVersion }) =>
              from(microvms.send(new ListTagsCommand({ Resource: imageArn }))).pipe(
                // An image of the account's own, not a sandbox, has no compute tag.
                filter(({ Tags }) => Tags?.[COMPUTE_TAG] === 'microvm'),
                map(({ Tags }): SandboxSummary => {
                  const [live] = vms.filter(
                    ({ imageArn: arn, state }) => arn === imageArn && state && !DEAD.includes(state)
                  );
                  const seconds = Number(Tags?.[TIMEOUT_TAG]);
                  return {
                    sandboxId: imageArn!,
                    name: name!,
                    runtime: 'aws.microvm',
                    running: !!live,
                    startedAt: live?.startedAt,
                    stopsAt:
                      live?.startedAt && seconds ? new Date(live.startedAt.getTime() + seconds * 1000) : undefined,
                    meta: Object.fromEntries(
                      Object.entries(Tags ?? {})
                        .filter(([key]) => key.startsWith(META_TAG))
                        .map(([key, value]) => [key.slice(META_TAG.length), value])
                    ),
                    state: state?.endsWith('FAILED')
                      ? 'failed'
                      : latestActiveImageVersion && !state?.endsWith('ING')
                        ? 'ready'
                        : 'building',
                  };
                })
              ),
            concurrency()
          )
        )
      ),
      finalize(() => microvms.destroy())
    );
  }

  static assert({ timeout, memory, env, meta }: Pick<ComputeSpec, 'timeout' | 'memory' | 'env' | 'meta'>): void {
    if (!Number.isInteger(timeout / 1000) || timeout < 1000 || timeout > 28_800_000) {
      throw new RangeError(`timeout must be whole seconds from 1000 to 28800000 ms, got ${timeout}`);
    }
    if (!(MICROVM_MEMORY as readonly number[]).includes(memory)) {
      throw new RangeError(`memory must be one of ${MICROVM_MEMORY.join(', ')}, got ${memory}`);
    }
    if (Object.keys(env).length > 50) {
      throw new RangeError(`env must have at most 50 variables, got ${Object.keys(env).length}`);
    }
    Object.entries(meta).forEach(([key, value]) => {
      if (typeof value !== 'string' || !TAG_KEY_REGEX.test(`${META_TAG}${key}`) || !TAG_VALUE_REGEX.test(value)) {
        throw new RangeError(`meta must be what AWS takes in a tag, got ${key}=${value}`);
      }
    });
  }

  readonly stoppable = true;

  private microvms = this.track(new LambdaMicrovmsClient({ logger: this, credentials: this.environment.credentials }));

  // What rowdy makes for the sandbox, apart from its running VMs.
  private image = new MicrovmImage(this.environment);
  private commands = new Set<AbortController>();

  constructor(private environment: SandboxEnvironment) {
    super();
  }

  override get log(): Logger {
    return this.environment.log.child('deploy');
  }

  get sandboxId(): string {
    const { ImageArn } = this.image.State;
    if (!ImageArn) {
      throw new Error('Sandbox has no image');
    }
    return ImageArn;
  }

  override events(): ReturnType<AwsClientLogger['events']> {
    return merge(super.events(), this.image.events());
  }

  create({ image, name, timeout, memory, env, meta, layersFrom, wait }: ComputeSpec): Observable<this> {
    return this.image
      .withName(name)
      .withImage(image, layersFrom)
      .withTimeout(timeout)
      .withMemory(memory)
      .withEnvironment(env)
      .withMeta(meta)
      .withWait(wait)
      .observe()
      .pipe(
        last(),
        map(() => this)
      );
  }

  attach(sandboxId: string, meta: Record<string, string> = {}): Observable<this> {
    return defer(() => this.microvms.send(new ListTagsCommand({ Resource: sandboxId }))).pipe(
      map(({ Tags }) => {
        // A value that isn't a string, like an undefined one, matches no sandbox.
        const matches = Object.entries(meta).every(
          ([key, value]) => typeof value === 'string' && Tags?.[`${META_TAG}${key}`] === value
        );
        if (Tags?.[COMPUTE_TAG] !== 'microvm' || !matches) {
          throw new SandboxError(`Not a sandbox: ${sandboxId}`);
        }
        this.image.withArn(sandboxId);
        return this;
      })
    );
  }

  exec(event: ExecSchema): Observable<Exec> {
    const controller = new AbortController();
    this.commands.add(controller);

    return defer(() => this.vm()).pipe(
      switchMap(({ microvmId, endpoint, imageVersion, startedAt }) =>
        from(
          this.microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: this.sandboxId, imageVersion }))
        ).pipe(
          switchMap(({ logging }) =>
            this.fetchHooks(microvmId, endpoint, EXEC_PATH, {
              method: 'POST',
              body: JSON.stringify(event),
              signal: controller.signal,
            }).pipe(
              map((response) => {
                if (!response.ok || !response.body) {
                  throw new Error(`Command refused: ${response.status}`);
                }
                return response;
              }),
              switchMap((response) => {
                const [, , , region, account] = this.sandboxId.split(':');
                const execId = response.headers.get(EXEC_ID_HEADER) ?? '';
                // A stream is named after the VM's start, so one that crosses midnight keeps its day.
                const day = startedAt.toISOString().slice(0, 10).replace(/-/g, '/');
                const locator: StartLiveTailCommandInput = {
                  logGroupIdentifiers: [`arn:aws:logs:${region}:${account}:log-group:${logging?.cloudWatch?.logGroup}`],
                  logStreamNamePrefixes: [`${day}[${imageVersion}]${microvmId}`],
                  logEventFilterPattern: `"${EXEC_LOG.key}" "${execId}"`,
                };
                const cmdId = Buffer.from(JSON.stringify(locator)).toString('base64url');
                return execOf(() => cmdId, from(response.body!).pipe(framesOf()));
              })
            )
          )
        )
      ),
      finalize(() => {
        this.commands.delete(controller);
        controller.abort();
      })
    );
  }

  output(cmdId: string, options?: ExecOutputOptions): Observable<ExecOutput> {
    return defer(() => this.microvms.send(new GetMicrovmImageCommand({ imageIdentifier: this.sandboxId }))).pipe(
      switchMap(({ latestActiveImageVersion: imageVersion }) =>
        this.microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: this.sandboxId, imageVersion }))
      ),
      switchMap(({ logging }) => {
        const [, , , region, account] = this.sandboxId.split(':');
        const logGroup = logging?.cloudWatch?.logGroup;
        return execOutput(
          `arn:aws:logs:${region}:${account}:log-group:${logGroup}`,
          cmdId,
          options,
          this.environment.credentials
        );
      })
    );
  }

  writeFile(path: string, content: Uint8Array, mode: number | undefined, signal: AbortSignal): Observable<void> {
    const query = new URLSearchParams({ path, ...(mode === undefined ? {} : { mode: mode.toString(8) }) });
    return defer(() => this.vm()).pipe(
      switchMap(({ microvmId, endpoint }) =>
        this.fetchHooks(microvmId, endpoint, `${FILES_PATH}?${query}`, { method: 'PUT', body: content, signal })
      ),
      switchMap(async (response) => {
        if (response.status !== 204) throw new Error(`Writing ${path} failed: ${await response.text()}`);
      })
    );
  }

  readFile(path: string, { offset, length }: FileRange, signal: AbortSignal): Observable<Buffer | null> {
    const ranged = offset !== undefined || length !== undefined;
    const start = offset ?? 0;
    const end = length === undefined ? undefined : start + length;
    return defer(() => this.vm()).pipe(
      switchMap(({ microvmId, endpoint }) =>
        this.fetchHooks(microvmId, endpoint, `${FILES_PATH}?${new URLSearchParams({ path })}`, {
          signal,
          headers: ranged ? { range: `bytes=${start}-${end === undefined ? '' : end - 1}` } : undefined,
        })
      ),
      switchMap(async (response) => {
        if (response.status === 404) return null;
        // From past the end.
        if (response.status === 416) return Buffer.alloc(0);
        if (response.status !== 200 && response.status !== 206) {
          throw new Error(`Reading ${path} failed: ${await response.text()}`);
        }
        const body = Buffer.from(await response.arrayBuffer());
        // A runtime without ranges, or one that ignored this range, sends the whole file.
        return ranged && response.status === 200 ? body.subarray(start, end) : body;
      })
    );
  }

  mkDir(path: string, signal: AbortSignal): Observable<void> {
    return defer(() => this.vm()).pipe(
      switchMap(({ microvmId, endpoint }) =>
        this.fetchHooks(microvmId, endpoint, `${FILES_PATH}?${new URLSearchParams({ path })}`, {
          method: 'POST',
          signal,
        })
      ),
      switchMap(async (response) => {
        if (response.status !== 204) throw new Error(`Making ${path} failed: ${await response.text()}`);
      })
    );
  }

  stop(): Observable<this> {
    return defer(() => this.microvms.send(new ListMicrovmsCommand({ imageIdentifier: this.sandboxId }))).pipe(
      switchMap(({ items = [] }) => {
        const live = items.flatMap(({ microvmId, state }) =>
          microvmId && state && !DEAD.includes(state) ? microvmId : []
        );
        // A VM's end doesn't reach an open response until the connection times out, a minute later.
        this.commands.forEach((controller) => controller.abort(new Error('Sandbox stopped')));
        return live.length ? forkJoin(live.map((microvmIdentifier) => this.terminate(microvmIdentifier))) : of([]);
      }),
      map(() => this)
    );
  }

  status(): Observable<SandboxStatus> {
    const imageIdentifier = this.sandboxId;
    return defer(() => this.microvms.send(new GetMicrovmImageCommand({ imageIdentifier }))).pipe(
      switchMap(({ state, latestActiveImageVersion, latestFailedImageVersion: imageVersion }) => {
        if ((state === 'CREATE_FAILED' || state === 'UPDATE_FAILED') && imageVersion) {
          return from(this.microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier, imageVersion }))).pipe(
            map(({ stateReason }): SandboxStatus => ({ state: 'failed', reason: stateReason }))
          );
        }
        return of<SandboxStatus>({
          state: latestActiveImageVersion && !state?.endsWith('ING') ? 'ready' : 'building',
        });
      })
    );
  }

  delete(): Observable<this> {
    return this.stop().pipe(
      switchMap(() => this.image.delete()),
      last(),
      map(() => this)
    );
  }

  /** Completes once the VM is gone, so a next command can't land on one that's ending. */
  private terminate(microvmIdentifier: string): Observable<string | undefined> {
    return from(this.microvms.send(new TerminateMicrovmCommand({ microvmIdentifier }))).pipe(
      catchError((error) => {
        // One that ended since the listing is what stop wanted.
        if (isNotFound(error) || error?.name === 'ConflictException') return of(undefined);
        throw error;
      }),
      switchMap(() =>
        defer(() => this.microvms.send(new GetMicrovmCommand({ microvmIdentifier }))).pipe(
          map(({ state }) => state),
          catchError((error) => {
            if (isNotFound(error)) return of(undefined);
            throw error;
          }),
          repeat({ delay: this.environment.pollInterval ?? TERMINATE_POLL.delay }),
          first((state) => state === undefined || DEAD.includes(state))
        )
      )
    );
  }

  /** This image's VM, started if it has none, and where its command output lands. */
  private vm(): Observable<Vm> {
    const imageIdentifier = this.sandboxId;
    const region = imageIdentifier.split(':')[3];

    const start$ = defer(() => this.microvms.send(new GetMicrovmImageCommand({ imageIdentifier }))).pipe(
      map((image) => {
        if (image.latestActiveImageVersion) return image;
        throw new SandboxError(
          image.state?.endsWith('FAILED')
            ? 'This sandbox failed to build: create it again to retry.'
            : "This sandbox is still building, so it can't run a command yet. Try again in a minute."
        );
      }),
      switchMap(({ latestActiveImageVersion: imageVersion, tags }) =>
        from(this.microvms.send(new ListMicrovmsCommand({ imageIdentifier }))).pipe(
          switchMap(({ items = [] }) => {
            const live = items.find(({ state }) => state && !DEAD.includes(state));
            if (live?.microvmId) return of(live.microvmId);

            return from(this.microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier, imageVersion }))).pipe(
              switchMap(({ buildRoleArn: executionRoleArn }) => {
                const seconds = Number(tags?.[TIMEOUT_TAG]) || 900;
                const connector = (id: string): string =>
                  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:${id}`;
                return this.microvms.send(
                  new RunMicrovmCommand({
                    imageIdentifier,
                    imageVersion,
                    executionRoleArn,
                    ingressNetworkConnectors: [connector('HTTP_INGRESS')],
                    egressNetworkConnectors: [connector('INTERNET_EGRESS')],
                    maximumDurationInSeconds: seconds,
                    // Output doesn't count as traffic, so a quiet command must not look idle.
                    idlePolicy: {
                      maxIdleDurationSeconds: Math.min(seconds, 28_800),
                      suspendedDurationSeconds: 60,
                      autoResumeEnabled: true,
                    },
                  })
                );
              }),
              map(({ microvmId }) => microvmId!)
            );
          })
        )
      ),
      switchMap((microvmIdentifier) =>
        defer(() => this.microvms.send(new GetMicrovmCommand({ microvmIdentifier }))).pipe(
          repeat({ delay: this.environment.pollInterval ?? POLL.delay }),
          first(({ state }) => state !== 'PENDING')
        )
      ),
      map(({ microvmId, state, stateReason, endpoint, imageVersion, startedAt }) => {
        if (state === undefined || DEAD.includes(state)) {
          throw new Error(`Sandbox ${imageIdentifier} stopped: ${stateReason ?? state}`);
        }
        return { microvmId: microvmId!, endpoint: endpoint!, imageVersion: imageVersion!, startedAt: startedAt! };
      }),
      finalize(() => STARTING.delete(imageIdentifier)),
      shareReplay({ bufferSize: 1, refCount: false })
    );

    // Two first commands at once would each start a VM, so a second waits on the first's, whichever handle it's on.
    return defer(() => {
      const started$ = STARTING.get(imageIdentifier) ?? start$;
      STARTING.set(imageIdentifier, started$);
      return started$;
    });
  }

  /** A request to rowdy's hooks server in the VM, with an auth token for it. */
  private fetchHooks(
    microvmIdentifier: string,
    endpoint: string,
    path: string,
    init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string>; signal: AbortSignal }
  ): Observable<globalThis.Response> {
    return defer(() =>
      this.microvms.send(
        new CreateMicrovmAuthTokenCommand({
          microvmIdentifier,
          expirationInMinutes: 5,
          allowedPorts: [{ port: HOOKS_PORT }],
        })
      )
    ).pipe(
      switchMap(({ authToken }) =>
        fetch(`https://${endpoint}${path}`, {
          ...init,
          headers: { ...init.headers, ...authToken, 'X-aws-proxy-port': `${HOOKS_PORT}` },
        })
      )
    );
  }
}
