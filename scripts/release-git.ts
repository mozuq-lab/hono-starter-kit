import type { CommandRunner } from "./docker/compose-project.ts";

// release:api と release:web が共有する、公開する成果物と commit の対応の確認。
// 未コミットの変更を含む成果物が commit の sha だけで識別されると、あとから何が
// 配信されているかを再現できなくなるため、既定では clean な作業ツリーを要求する。

// SHA-1 と SHA-256 のどちらの object format の repository でも受け付ける。
const commitPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

const capturedText = (output: unknown) =>
  typeof output === "string" ? output : "";

export type ReleaseGitState = {
  commit: string;
  dirty: boolean;
  /** git status --porcelain の出力。build の後の再確認で、前と同じかを比べる。 */
  status: string;
};

const readCommit = async (commandRunner: Pick<CommandRunner, "run">) => {
  const commit = capturedText(
    await commandRunner.run("git", ["rev-parse", "HEAD"], { capture: true }),
  ).trim();
  if (!commitPattern.test(commit)) {
    throw new Error("git rev-parse HEAD did not return a full commit id.");
  }
  return commit;
};

// 未追跡のファイルも数える。Docker の build context と web の build に入り得るため。
const readStatus = async (commandRunner: Pick<CommandRunner, "run">) =>
  capturedText(
    await commandRunner.run("git", ["status", "--porcelain"], {
      capture: true,
    }),
  );

export const readReleaseGitState = async ({
  allowDirty,
  commandRunner,
  warn,
}: {
  allowDirty: boolean;
  commandRunner: Pick<CommandRunner, "run">;
  warn: (message: string) => void;
}): Promise<ReleaseGitState> => {
  const commit = await readCommit(commandRunner);
  const status = await readStatus(commandRunner);
  const dirty = status.trim() !== "";
  if (dirty && !allowDirty) {
    throw new Error(
      "The working tree has uncommitted changes. Commit them, or pass --allow-dirty in an emergency.",
    );
  }
  if (dirty) {
    warn(
      `Warning: releasing ${commit} with uncommitted changes (--allow-dirty). The release is marked dirty.`,
    );
  }
  return { commit, dirty, status };
};

// build の間に作業ツリーや HEAD が変わると、tag や release.json の commit と成果物の中身がずれる。
// dirty な tree では porcelain の行が同じでも既存ファイルの中身の変更は検出できない（best effort）。
export const assertReleaseGitStateUnchanged = async ({
  before,
  commandRunner,
  consequence,
}: {
  before: ReleaseGitState;
  commandRunner: Pick<CommandRunner, "run">;
  consequence: string;
}) => {
  const commit = await readCommit(commandRunner);
  const status = await readStatus(commandRunner);
  if (commit !== before.commit || status !== before.status) {
    throw new Error(
      `The working tree changed while the release was being built. ${consequence}`,
    );
  }
};

export const formatUtcTimestamp = (date: Date) =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/u, "")
    .replace(/[-:T]/gu, "");

// release の手順は AWS CLI を前提にする。起動できないときの「Unable to start aws」だけでは
// 何を用意すればよいか分からないので、先に確かめて案内する。
export const requireAwsCli = async (
  run: (
    command: string,
    args: readonly string[],
    options?: { capture?: boolean },
  ) => Promise<unknown>,
  interrupted: () => boolean = () => false,
) => {
  try {
    await run("aws", ["--version"], { capture: true });
  } catch (error) {
    if (interrupted()) throw error;
    throw new Error(
      "The AWS CLI (aws) is required to publish to AWS. Install it and configure credentials.",
      { cause: error },
    );
  }
};
