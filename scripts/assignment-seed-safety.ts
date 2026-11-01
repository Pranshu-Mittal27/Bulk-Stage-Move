const confirmationFlag = '--confirm-disposable-database';
const databaseNamePattern = /^[a-z][a-z0-9_]{0,62}$/;

function validateDatabaseName(name: string): string {
  if (databaseNamePattern.exec(name)?.[0] !== name) {
    throw new Error(
      'Database names must start with a lowercase letter and contain only lowercase letters, digits, or underscores, with a maximum length of 63 characters.',
    );
  }
  return name;
}

export function parseConfirmedDatabaseName(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== confirmationFlag) {
    throw new Error(`Pass exactly ${confirmationFlag} <database-name>.`);
  }

  return validateDatabaseName(args[1] ?? '');
}

export function assertDatabaseUrlMatchesConfirmation(
  connectionString: string,
  confirmedDatabaseName: string,
): void {
  validateDatabaseName(confirmedDatabaseName);

  if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    throw new Error(
      'DATABASE_URL must be a hierarchical PostgreSQL URL with a database path.',
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL URL.');
  }

  if (
    parsedUrl.protocol !== 'postgresql:' &&
    parsedUrl.protocol !== 'postgres:'
  ) {
    throw new Error('DATABASE_URL must use a PostgreSQL URL protocol.');
  }

  if (!parsedUrl.host || !parsedUrl.pathname.startsWith('/')) {
    throw new Error(
      'DATABASE_URL must include a host and slash-prefixed database path.',
    );
  }

  if (parsedUrl.pathname.length < 2) {
    throw new Error('DATABASE_URL must include a database name in its path.');
  }

  let urlDatabaseName: string;
  try {
    urlDatabaseName = decodeURIComponent(parsedUrl.pathname.slice(1));
  } catch {
    throw new Error('DATABASE_URL contains an invalid encoded database name.');
  }
  validateDatabaseName(urlDatabaseName);

  if (urlDatabaseName !== confirmedDatabaseName) {
    throw new Error(
      'DATABASE_URL database name does not match the confirmed database name.',
    );
  }
}

export async function runSeedWritesAfterDatabaseNameCheck<T>(
  connectedDatabaseName: string | undefined,
  confirmedDatabaseName: string,
  writeSeedData: () => Promise<T>,
): Promise<T> {
  assertConnectedDatabaseMatchesConfirmation(
    connectedDatabaseName,
    confirmedDatabaseName,
  );
  return writeSeedData();
}

export function assertConnectedDatabaseMatchesConfirmation(
  connectedDatabaseName: string | undefined,
  confirmedDatabaseName: string,
): void {
  validateDatabaseName(confirmedDatabaseName);
  if (connectedDatabaseName !== confirmedDatabaseName) {
    throw new Error(
      'Connected PostgreSQL database name does not match the confirmed database name.',
    );
  }
}
