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
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  paginateListObjectsV2,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  catchError,
  concat,
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
  fromEvent,
  takeUntil,
  tap,
  throwError,
  throwIfEmpty,
  timer,
  toArray,
  EMPTY,
  ignoreElements,
} from 'rxjs';
import type { AwsSandboxOptions, FileRange, SandboxStatus, SandboxSummary } from '../../sandbox';
import { Exec, ExecOutput, ExecOutputOptions } from '../../api/types';
import type { SandboxEnvironment } from '../../sandbox/internal/environment';
import { Logger } from '../../log';
import { ExecSchema } from '../../routes';
import { ComputeSpec, MICROVM_MEMORY, SandboxCompute, SandboxError } from '../../sandbox/internal/compute';
import { META_TAG, TAG_KEY_REGEX, TAG_VALUE_REGEX } from '../tags';
import { isNotFound } from '../shared';
import { ownedBucket } from '../s3';
import { AwsClientLogger } from '../logger';
import { CmdId, execOf, execOutput, execRead, framesOf } from '../exec';
import { EXEC_FILES, EXEC_ID_HEADER, EXEC_PATH, FILES_PATH, HOOKS_PORT } from './hooks';
import { concurrency } from '../../concurrency';
import { BUCKET_OWNER, BUCKET_PREFIX, COMPUTE_TAG, MicrovmImage, POLL, TIMEOUT_TAG } from './index';

const DEAD: ReadonlyArray<string> = ['TERMINATING', 'TERMINATED'];

export { POLL };

/** How often a command's file in the VM is read again while `output` waits for more, in milliseconds. */
export const EXEC_FILE_POLL = { delay: 1000 };

/** How often a terminating VM is polled, in milliseconds. */
export const TERMINATE_POLL = { delay: 250 };

type Vm = { microvmId: string; endpoint: string; imageVersion: string; startedAt: Date };

/**
 * A sandbox started from a prebuilt image, kept in the sandbox bucket under `RECORDS`: its one VM, whose id is the
 * sandbox's. The VM runs with no role, so it writes no log, and its command output is read from the VM.
 */
export type PrebuiltRecord = {
  microvmId: string;
  name: string;
  meta: Record<string, string>;
  /** In milliseconds. */
  timeout: number;
  imageArn: string;
  imageVersion: string;
  bucket: string;
  startedAt: string;
};

/** Where a sandbox started from a prebuilt image is kept, by its VM's id. */
export const RECORDS = 'sandboxes/';

/** A sandbox started from a prebuilt image is named for its VM. */
const MICROVM_ID = /^microvm-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Each image's VM while it's being found or started, shared by every handle in the process. */
const STARTING = new Map<string, Observable<Vm>>();

export class MicrovmCompute extends AwsClientLogger implements SandboxCompute {
  static readonly env = {};

  static list(credentials?: AwsSandboxOptions['credentials']): Observable<SandboxSummary> {
    // One ListTags per image, so a busy host is throttled: adaptive retries slow down until AWS lets them through.
    const microvms = new LambdaMicrovmsClient({ credentials, retryMode: 'adaptive', maxAttempts: 8 });
    const s3 = new S3Client({ credentials });
    return forkJoin([
      from(paginateListMicrovms({ client: microvms }, {})).pipe(
        concatMap(({ items = [] }) => items),
        toArray()
      ),
      from(paginateListMicrovmImages({ client: microvms }, {})).pipe(
        concatMap(({ items = [] }) => items),
        toArray()
      ),
      // Without a sandbox bucket, there are no sandboxes started from a prebuilt image.
      ownedBucket(s3, new Logger(), BUCKET_PREFIX, BUCKET_OWNER, false).pipe(
        switchMap((Bucket) =>
          from(paginateListObjectsV2({ client: s3 }, { Bucket, Prefix: RECORDS })).pipe(
            concatMap(({ Contents = [] }) => Contents),
            mergeMap(
              ({ Key }) =>
                from(s3.send(new GetObjectCommand({ Bucket, Key }))).pipe(
                  switchMap(({ Body }) => Body!.transformToString()),
                  map((text) => JSON.parse(text) as PrebuiltRecord)
                ),
              concurrency()
            )
          )
        ),
        toArray()
      ),
    ]).pipe(
      switchMap(([vms, images, records]) =>
        merge(
          from(records).pipe(
            map((record): SandboxSummary => {
              const live = vms.find(
                ({ microvmId, state }) => microvmId === record.microvmId && state && !DEAD.includes(state)
              );
              const startedAt = new Date(record.startedAt);
              return {
                sandboxId: record.microvmId,
                name: record.name,
                runtime: 'aws.microvm',
                running: !!live,
                startedAt: live ? startedAt : undefined,
                stopsAt: live ? new Date(startedAt.getTime() + record.timeout) : undefined,
                meta: record.meta,
                state: 'ready',
              };
            })
          ),
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
                      sandboxId: name!,
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
        )
      ),
      finalize(() => {
        microvms.destroy();
        s3.destroy();
      })
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
  private sts = this.track(new STSClient({ logger: this, credentials: this.environment.credentials }));
  private s3 = this.track(new S3Client({ logger: this, credentials: this.environment.credentials }));

  // Set for a sandbox started from a prebuilt image, which is its VM rather than an image of its own.
  private record?: PrebuiltRecord;

  // What rowdy makes for the sandbox, apart from its running VMs.
  private image = new MicrovmImage(this.environment);
  private commands = new Set<AbortController>();

  constructor(private environment: SandboxEnvironment) {
    super();
  }

  override get log(): Logger {
    return this.environment.log.child('deploy');
  }

  // The image's ARN has the account in it, so only its name leaves rowdy.
  get sandboxId(): string {
    return this.record?.microvmId ?? this.imageArn.split(':').pop()!;
  }

  private get imageArn(): string {
    if (this.record) return this.record.imageArn;
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
    this.image
      .withName(name)
      .withImage(image, layersFrom)
      .withTimeout(timeout)
      .withMemory(memory)
      .withEnvironment(env)
      .withMeta(meta)
      .withWait(wait);

    // An image prebuilt from exactly what this sandbox would build, found by its name with nothing copied.
    const prebuilt$ = this.image.prebuilt(false).pipe(
      switchMap(({ name: prebuilt, hash }) =>
        forkJoin({
          Region: defer(() => this.microvms.config.region()),
          Identity: defer(() => this.sts.send(new GetCallerIdentityCommand({}))),
        }).pipe(
          map(({ Region, Identity: { Account } }) => `arn:aws:lambda:${Region}:${Account}:microvm-image:${prebuilt}`),
          switchMap((imageArn) =>
            from(this.microvms.send(new GetMicrovmImageCommand({ imageIdentifier: imageArn }))).pipe(
              map(({ state, latestActiveImageVersion: imageVersion, tags }) =>
                (state === 'CREATED' || state === 'UPDATED') && imageVersion && tags?.spec === hash
                  ? { imageArn, imageVersion }
                  : undefined
              )
            )
          )
        )
      ),
      // None, or a lookup that fails for any reason, builds as it would without one.
      catchError((error) => {
        if (!isNotFound(error)) this.log.debug('Prebuilt Image Lookup Failed', { error });
        return of(undefined);
      })
    );

    return prebuilt$.pipe(
      switchMap((found) => {
        if (!found) {
          return this.image.observe().pipe(
            last(),
            map(() => this)
          );
        }

        const { imageArn, imageVersion } = found;
        const region = imageArn.split(':')[3];
        let started: string | undefined;
        this.environment.event$.next({
          source: 'sandbox',
          type: 'prebuilt',
          summary: 'Starting from a prebuilt image',
          message: 'Starting from a prebuilt image',
        });

        const seconds = timeout / 1000;
        const connector = (id: string): string =>
          `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:${id}`;
        return forkJoin({
          bucket: ownedBucket(this.s3, this.log, BUCKET_PREFIX, BUCKET_OWNER),
          // No execution role: code in the VM could read a role's credentials, and with none it has nothing to use.
          run: defer(() =>
            this.microvms.send(
              new RunMicrovmCommand({
                imageIdentifier: imageArn,
                imageVersion,
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
            )
          ).pipe(tap(({ microvmId }) => (started = microvmId))),
        }).pipe(
          switchMap(({ bucket, run: { microvmId: microvmIdentifier } }) =>
            (wait
              ? defer(() => this.microvms.send(new GetMicrovmCommand({ microvmIdentifier }))).pipe(
                  repeat({ delay: this.environment.pollInterval ?? POLL.delay }),
                  first(({ state }) => state !== 'PENDING'),
                  map(({ state, stateReason, startedAt }) => {
                    if (state === undefined || DEAD.includes(state)) {
                      throw new Error(`Sandbox ${microvmIdentifier} stopped: ${stateReason ?? state}`);
                    }
                    return startedAt;
                  })
                )
              : of(undefined)
            ).pipe(
              map(
                (startedAt): PrebuiltRecord => ({
                  microvmId: microvmIdentifier!,
                  name,
                  meta,
                  timeout,
                  imageArn,
                  imageVersion,
                  bucket,
                  startedAt: (startedAt ?? new Date()).toISOString(),
                })
              )
            )
          ),
          switchMap((record) =>
            from(
              this.s3.send(
                new PutObjectCommand({
                  Bucket: record.bucket,
                  Key: `${RECORDS}${record.microvmId}.json`,
                  Body: JSON.stringify(record),
                  ContentType: 'application/json',
                })
              )
            ).pipe(map(() => record))
          ),
          tap((record) => (this.record = record)),
          map(() => this),
          // A VM started for a sandbox that has no record would run on unseen until its timeout.
          catchError((error) =>
            concat(
              (started ? this.terminate(started) : EMPTY).pipe(
                ignoreElements(),
                catchError((cleanup) => {
                  this.log.warn('Sandbox Cleanup Failed', { error: cleanup });
                  return EMPTY;
                })
              ),
              throwError(() => error)
            )
          )
        );
      })
    );
  }

  attach(sandboxId: string, meta: Record<string, string> = {}): Observable<this> {
    const missing = () =>
      Object.assign(new SandboxError(`No sandbox named ${sandboxId}`), { name: 'ResourceNotFoundException' });
    if (MICROVM_ID.test(sandboxId)) {
      return ownedBucket(this.s3, this.log, BUCKET_PREFIX, BUCKET_OWNER, false).pipe(
        switchMap((Bucket) => this.s3.send(new GetObjectCommand({ Bucket, Key: `${RECORDS}${sandboxId}.json` }))),
        switchMap(({ Body }) => Body!.transformToString()),
        map((text) => JSON.parse(text) as PrebuiltRecord),
        catchError((error) => throwError(() => (error?.name === 'NoSuchKey' ? missing() : error))),
        throwIfEmpty(missing),
        map((record) => {
          // A value that isn't a string, like an undefined one, matches no sandbox.
          const matches = Object.entries(meta).every(
            ([key, value]) => typeof value === 'string' && record.meta[key] === value
          );
          if (!matches) throw new SandboxError(`Not a sandbox: ${sandboxId}`);
          this.record = record;
          return this;
        })
      );
    }
    // AWS finds an image only by its ARN, which is the caller's own account and region.
    return forkJoin({
      Region: defer(() => this.microvms.config.region()),
      Identity: defer(() => this.sts.send(new GetCallerIdentityCommand({}))),
    }).pipe(
      map(({ Region, Identity: { Account } }) => `arn:aws:lambda:${Region}:${Account}:microvm-image:${sandboxId}`),
      switchMap((imageArn) =>
        from(this.microvms.send(new ListTagsCommand({ Resource: imageArn }))).pipe(
          map(({ Tags }) => ({ imageArn, Tags }))
        )
      ),
      map(({ imageArn, Tags }) => {
        // A value that isn't a string, like an undefined one, matches no sandbox.
        const matches = Object.entries(meta).every(
          ([key, value]) => typeof value === 'string' && Tags?.[`${META_TAG}${key}`] === value
        );
        if (Tags?.[COMPUTE_TAG] !== 'microvm' || !matches) {
          throw new SandboxError(`Not a sandbox: ${sandboxId}`);
        }
        this.image.withArn(imageArn);
        return this;
      })
    );
  }

  exec(event: ExecSchema): Observable<Exec> {
    const controller = new AbortController();
    this.commands.add(controller);

    return defer(() => this.vm()).pipe(
      switchMap(({ microvmId, endpoint, imageVersion, startedAt }) =>
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
            const execId = response.headers.get(EXEC_ID_HEADER) ?? '';
            // A stream is named after the VM's start, so one that crosses midnight keeps its day.
            const day = startedAt.toISOString().slice(0, 10).replace(/-/g, '/');
            const cmdId = CmdId.stringify({
              sandbox: this.sandboxId,
              day,
              version: `${imageVersion}`,
              vm: microvmId,
              exec: execId,
            });
            return execOf(() => cmdId, from(response.body!).pipe(framesOf()));
          })
        )
      ),
      finalize(() => {
        this.commands.delete(controller);
        controller.abort();
      })
    );
  }

  output(cmdId: string, options?: ExecOutputOptions): Observable<ExecOutput> {
    return defer(() => {
      const { day, version, vm, exec } = CmdId.parse(cmdId, this.sandboxId);
      // Read from the VM, which keeps each command's lines in a file: with no role, it writes no log.
      if (this.record) {
        if (!/^[0-9a-f-]{36}$/.test(exec)) throw new SandboxError('Not a command in this sandbox.');
        const { cursor, stream, timeout, signal = new AbortController().signal } = options ?? {};
        const [offset = 0, start = 0] = cursor?.split('.').map(Number) ?? [];
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(start) || offset < 0) {
          throw new SandboxError('Not a cursor from this command.');
        }
        const path = `${EXEC_FILES.dir}/${exec}.jsonl`;
        let at = offset;
        // Each whole line, with where the next read starts as its `timestamp`.
        const read$ = defer(() => this.readFile(path, { offset: at }, signal)).pipe(
          concatMap((bytes) => {
            const end = bytes ? bytes.lastIndexOf('\n') + 1 : 0;
            const from = at;
            at += end;
            let next = from;
            return (bytes?.subarray(0, end).toString() ?? '')
              .split('\n')
              .filter(Boolean)
              .map((message) => ({ message, timestamp: (next += Buffer.byteLength(message) + 1) }));
          })
        );
        const event$ =
          timeout === undefined
            ? read$
            : read$.pipe(
                repeat({ delay: EXEC_FILE_POLL.delay }),
                takeUntil(timer(timeout)),
                takeUntil(fromEvent(signal, 'abort'))
              );
        return execRead(event$, { cursor, stream }, start).pipe(
          catchError((error) => {
            if (error instanceof SandboxError && /stopped/.test(error.message)) {
              throw new SandboxError('This sandbox has stopped, and its command output went with it.');
            }
            throw error;
          })
        );
      }

      return from(this.microvms.send(new GetMicrovmImageCommand({ imageIdentifier: this.imageArn }))).pipe(
        switchMap(({ latestActiveImageVersion: imageVersion }) =>
          this.microvms.send(new GetMicrovmImageVersionCommand({ imageIdentifier: this.imageArn, imageVersion }))
        ),
        switchMap(({ logging }) => {
          const [, , , region, account] = this.imageArn.split(':');
          const logGroup = logging?.cloudWatch?.logGroup;
          return execOutput(
            `arn:aws:logs:${region}:${account}:log-group:${logGroup}`,
            { logStreamNamePrefix: `${day}[${version}]${vm}`, exec },
            options,
            this.environment.credentials
          );
        })
      );
    });
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
    if (this.record) {
      const { microvmId } = this.record;
      return defer(() => {
        this.commands.forEach((controller) => controller.abort(new Error('Sandbox stopped')));
        return this.terminate(microvmId);
      }).pipe(map(() => this));
    }
    return defer(() => this.microvms.send(new ListMicrovmsCommand({ imageIdentifier: this.imageArn }))).pipe(
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
    // Its image was built before it started.
    if (this.record) return of<SandboxStatus>({ state: 'ready' });
    const imageIdentifier = this.imageArn;
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
    if (this.record) {
      const { bucket: Bucket, microvmId } = this.record;
      // The prebuilt image is never its to delete: only its VM and its record are its own.
      return this.stop().pipe(
        switchMap(() => this.s3.send(new DeleteObjectCommand({ Bucket, Key: `${RECORDS}${microvmId}.json` }))),
        map(() => this)
      );
    }
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
    // A sandbox started from a prebuilt image is its one VM, and ends with it.
    if (this.record) {
      const { microvmId: microvmIdentifier } = this.record;
      return defer(() => this.microvms.send(new GetMicrovmCommand({ microvmIdentifier }))).pipe(
        repeat({ delay: this.environment.pollInterval ?? POLL.delay }),
        first(({ state }) => state !== 'PENDING'),
        map(({ microvmId, state, endpoint, imageVersion, startedAt }) => {
          if (state === undefined || DEAD.includes(state)) {
            throw new SandboxError('This sandbox has stopped: create another to run a command.');
          }
          return { microvmId: microvmId!, endpoint: endpoint!, imageVersion: imageVersion!, startedAt: startedAt! };
        })
      );
    }
    const imageIdentifier = this.imageArn;
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
