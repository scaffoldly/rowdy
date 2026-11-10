import { ReplaySubject } from 'rxjs';

/** AWS credentials, as the AWS SDK's own credential providers give them. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** When they stop working. */
  expiration?: Date;
}

/**
 * Credentials asked for once, when it's made, and replayed to every client that asks until half their life is gone,
 * from when they came to their `expiration`. Then the next client's ask gets new ones, which replay in turn. One ask
 * runs at a time, and a failed one reaches only the clients waiting on it: the next ask tries again.
 */
export class CredentialsReplay extends ReplaySubject<AwsCredentials> {
  private last?: AwsCredentials;
  // When `last` is half spent: halfway from when it came to its expiration.
  private halfLife = Infinity;
  private asking?: Promise<AwsCredentials>;

  constructor(private readonly credentials: () => Promise<AwsCredentials>) {
    super(1);
    this.ask().catch(() => undefined);
  }

  /** What an AWS client takes as its `credentials`. */
  readonly provider = (): Promise<AwsCredentials> => {
    const { last } = this;
    if (this.asking) return this.asking;
    if (last && Date.now() < this.halfLife) return Promise.resolve(last);
    return this.ask();
  };

  private ask(): Promise<AwsCredentials> {
    this.asking = this.credentials().then(
      (asked) => {
        const now = Date.now();
        this.asking = undefined;
        this.last = asked;
        this.halfLife = asked.expiration ? now + (asked.expiration.getTime() - now) / 2 : Infinity;
        this.next(asked);
        return asked;
      },
      (error) => {
        this.asking = undefined;
        throw error;
      }
    );
    return this.asking;
  }
}
