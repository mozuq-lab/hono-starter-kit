// migrate CLI がそのまま表示してよい、運用者の次の行動を示す固定メッセージの失敗。
// ドライバの message（接続先や SQL の断片が入りうる）は持たせない。
export class ActionableMigrationError extends Error {
  // バンドラは衝突を避けてクラス名を変えることがあるので、new.target.name に頼らない。
  constructor(message: string, name: string) {
    super(message);
    this.name = name;
  }
}

export class MigrationLockWaitExceededError extends ActionableMigrationError {
  constructor() {
    super(
      "Database migration waited too long for another migrator to finish. Check for a stuck migration task.",
      "MigrationLockWaitExceededError",
    );
  }
}

export class MigrationLockRetriesExhaustedError extends ActionableMigrationError {
  constructor(attempts: number) {
    super(
      `Database migration could not acquire a table lock after ${attempts} attempts. Retry when the database is less busy.`,
      "MigrationLockRetriesExhaustedError",
    );
  }
}

export class MigrationStatementTimeoutError extends ActionableMigrationError {
  constructor() {
    super(
      "Database migration exceeded its statement timeout.",
      "MigrationStatementTimeoutError",
    );
  }
}

export class MigrationChangesStatementTimeoutError extends ActionableMigrationError {
  constructor() {
    super(
      "Migration files must not change statement_timeout. Run long operations outside the deploy task.",
      "MigrationChangesStatementTimeoutError",
    );
  }
}

export class MigrationChangesSessionSettingsError extends ActionableMigrationError {
  constructor() {
    super(
      "Migration files must not change lock_timeout or reset session settings. The migration runner sets them for each migration.",
      "MigrationChangesSessionSettingsError",
    );
  }
}

export class MigrationControlsTransactionError extends ActionableMigrationError {
  constructor() {
    super(
      "Migration files must not begin, commit, or roll back transactions. The migration runner wraps each migration in its own transaction.",
      "MigrationControlsTransactionError",
    );
  }
}
