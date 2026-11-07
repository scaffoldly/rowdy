import { SmithyClientLogger } from '@scaffoldly/rowdy-cdk';
import { map, Observable } from 'rxjs';
import type { Event } from '../events';

const COMMANDS = {
  describe: /^Describe/,
  read: /^(Get|List|Head)/,
  create: /^(?!.*AuthToken)(Create|Run|Publish|Add)/,
  update: /^(Update|Put)/,
  dispose: /^(Delete|Remove|Terminate)/,
  tag: /^Tag/,
};

// The fields that name what a command changes, most specific first, in lower case: AWS's APIs differ in theirs.
const NAMES = ['functionname', 'rolename', 'name', 'microvmidentifier', 'imageidentifier', 'key', 'bucket'];

/** Logs what an AWS SDK client does, and emits each step of a client it tracks. */
export abstract class AwsClientLogger extends SmithyClientLogger {
  constructor() {
    super({ commands: COMMANDS, names: NAMES });
  }

  override events(): Observable<Event> {
    return super.events().pipe(map((event) => ({ source: 'cdk', ...event })));
  }
}
