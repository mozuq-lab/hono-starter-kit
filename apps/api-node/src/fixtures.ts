import {
  getDevIdentity,
  InMemoryProjectRepository,
  InMemoryProjectUnitOfWork,
  type KnownIdentity,
  type Project,
  type ProjectRepository,
  type ProjectUnitOfWork,
} from "@starter/backend";
import { devUserId } from "./dev-user.js";

// NODE_ENV=test 専用の差し替え実装。本番ランタイムバンドルからは除外されており
// （scripts/build-api-runtime.ts が静的 import を拒否する）、動的 import でしか届かない。
export type NodeScenario = "success" | "empty" | "error";

export const alphaProject: Readonly<Project> = Object.freeze({
  id: "project_alpha",
  ownerUserId: devUserId,
  name: "Alpha",
  status: "active",
  version: 1,
  createdAt: new Date("2026-08-03T00:00:00.000Z"),
  updatedAt: new Date("2026-08-03T00:00:00.000Z"),
});

export type ProjectPersistence = {
  repository: ProjectRepository;
  unitOfWork: ProjectUnitOfWork;
};

export type FixturePersistence = ProjectPersistence & {
  /** memory の auth store に渡す、起動時から user に結び付いた identity。 */
  knownIdentities: readonly KnownIdentity[];
};

// DB の seed と同じく Dev identity を devUserId に結び付けて memory の auth store に渡し、
// Dev ログインの利用者を Alpha の所有者と一致させる。
const devIdentity = getDevIdentity();
const knownIdentities: readonly KnownIdentity[] = [
  {
    issuer: devIdentity.issuer,
    subject: devIdentity.subject,
    userId: devUserId,
  },
];

export const createFixturePersistence = (
  scenario: NodeScenario,
): FixturePersistence => {
  if (scenario === "error") {
    const failure = new Error("fixture repository failure");
    const reject = <T>(): Promise<T> => Promise.reject(failure);
    return {
      repository: {
        list: reject,
        findById: reject,
        create: reject,
        update: reject,
        archive: reject,
      },
      unitOfWork: { execute: reject },
      knownIdentities,
    };
  }

  const repository = new InMemoryProjectRepository(
    scenario === "success" ? [alphaProject] : [],
  );
  return {
    repository,
    unitOfWork: new InMemoryProjectUnitOfWork(repository),
    knownIdentities,
  };
};
