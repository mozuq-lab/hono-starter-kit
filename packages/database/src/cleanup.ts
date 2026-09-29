export const runWithCleanup = async <Result>(
  operation: () => Promise<Result>,
  cleanup: () => Promise<void>,
): Promise<Result> => {
  let outcome:
    | { readonly status: "fulfilled"; readonly value: Result }
    | { readonly reason: unknown; readonly status: "rejected" };

  try {
    outcome = { status: "fulfilled", value: await operation() };
  } catch (reason) {
    outcome = { reason, status: "rejected" };
  }

  if (outcome.status === "rejected") {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [outcome.reason, cleanupError],
        "Operation failed and cleanup also failed.",
        { cause: cleanupError },
      );
    }
    throw outcome.reason;
  }

  await cleanup();
  return outcome.value;
};
