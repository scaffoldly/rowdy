import { firstValueFrom, from, ReplaySubject } from 'rxjs';

/** AWS credentials, as the AWS SDK's own credential providers give them. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** When they stop working. */
  expiration?: Date;
}

/** Credentials asked for once, when it's made, and replayed to every client that asks. A failure replays too. */
export class CredentialsReplay extends ReplaySubject<AwsCredentials> {
  constructor(credentials: () => Promise<AwsCredentials>) {
    super(1);
    from(credentials()).subscribe(this);
  }

  /** What an AWS client takes as its `credentials`. */
  readonly provider = (): Promise<AwsCredentials> => firstValueFrom(this);
}
