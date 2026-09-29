// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { ApiError } from "@starter/api-client";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ErrorBoundary, HydrateFallback } from "./root.js";

afterEach(cleanup);

const renderFailingApp = (failures: readonly unknown[]) => {
  const remaining = [...failures];
  const router = createMemoryRouter(
    [
      {
        path: "/",
        loader: () => {
          const failure = remaining.shift();
          // ErrorBoundary は Error 以外が投げられた場合も守る必要があるため、
          // ここでは意図的に任意の値を投げる。
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          if (failure !== undefined) throw failure;
          return null;
        },
        Component: () => <h1>Projects</h1>,
        errorElement: <ErrorBoundary />,
      },
    ],
    { initialEntries: ["/"] },
  );

  render(<RouterProvider router={router} />);

  return router;
};

describe("root HydrateFallback", () => {
  it("does not name a feature module", () => {
    render(<HydrateFallback />);

    const loading = screen.getByRole("main");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).not.toHaveTextContent("Projects");
  });
});

describe("root ErrorBoundary", () => {
  it("shows the Problem request id without leaking internal details", async () => {
    renderFailingApp([
      new ApiError({
        type: "https://starter.local/problems/internal-server-error",
        title: "Internal Server Error",
        status: 500,
        code: "INTERNAL_ERROR",
        requestId: "request_root_failed",
        detail: "connection refused at 10.0.0.1:5432",
      }),
    ]);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Request ID: request_root_failed",
    );
    expect(screen.queryByText(/connection refused/u)).toBeNull();
    expect(screen.queryByText(/Internal Server Error/u)).toBeNull();
  });

  it("recovers a failed load with Retry and hides the raw error message", async () => {
    const user = userEvent.setup();
    renderFailingApp([new Error("network unavailable")]);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText(/network unavailable/u)).toBeNull();
    expect(screen.queryByText(/Request ID/u)).toBeNull();

    await user.click(screen.getByRole("button", { name: "再試行" }));

    expect(
      await screen.findByRole("heading", { name: "Projects" }),
    ).toBeInTheDocument();
  });
});
