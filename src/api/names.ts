/** rowdy's own names in routes and URLs, apart from its API, so what the API uses can name them too. */
export class RowdyNames {
  static readonly SLUG = '@rowdy';
  static readonly ERROR = 'error';
  static readonly HTTP = 'http';
  static readonly CRI = 'cri';
  static readonly HEALTH = 'health';
  static readonly PING = 'ping';
  static readonly ROUTES = 'routes';
  static readonly VERSION = 'version';

  static readonly CRON = 'cron';

  static readonly HEADERS = {
    // DEVNOTE: A trusted signal. Rowdy strips any inbound value, so its presence proves the
    // request originated from one of this deployment's own schedules.
    CRON: 'x-rowdy-cron',
  };

  static readonly PREFIXES = {
    CRI: `/${RowdyNames.SLUG}/${RowdyNames.CRI}`,
  };

  static readonly PATHS = {
    CRI: `${RowdyNames.PREFIXES.CRI}{/*path}`,
    VERSION: `/${RowdyNames.SLUG}/${RowdyNames.VERSION}`,
    HEALTH: `/${RowdyNames.SLUG}/${RowdyNames.HEALTH}`,
    PING: `/${RowdyNames.SLUG}/${RowdyNames.PING}`,
  };

  static readonly TARGETS = {
    CRI: `rowdy://${RowdyNames.CRI}/*path`,
  };
}
