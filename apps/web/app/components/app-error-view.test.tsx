// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorView } from "./app-error-view.js";

afterEach(cleanup);

describe("AppErrorView", () => {
  it("shows a generic heading and the request id without naming any feature", () => {
    render(<AppErrorView requestId="request_test_123" onRetry={() => {}} />);

    expect(
      screen.getByRole("heading", { name: "読み込めませんでした" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("request_test_123");
    expect(screen.getByRole("main")).not.toHaveTextContent("Projects");
  });

  it("omits the request id line when there is none", () => {
    render(<AppErrorView onRetry={() => {}} />);

    expect(screen.queryByText(/Request ID/u)).toBeNull();
  });

  it("calls onRetry from the accessible retry button", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<AppErrorView onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: "再試行" }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});
