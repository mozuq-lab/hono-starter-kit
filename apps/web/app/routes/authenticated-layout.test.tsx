// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@starter/api-client";
import { QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import { authClient } from "../lib/api-client.js";
import { queryClient } from "../lib/query-client.js";
import AuthenticatedLayout, {
  createAuthenticatedLoader,
  ErrorBoundary,
} from "./authenticated-layout.js";

const currentUser = {
  user: {
    id: "user_local_developer",
    email: "developer@example.test",
    displayName: "Local Developer",
    roles: ["user"],
  },
};

const unauthenticated = new ApiError({
  type: "https://starter.local/problems/unauthenticated",
  title: "Unauthenticated",
  status: 401,
  code: "UNAUTHENTICATED",
  requestId: "request_unauthenticated",
});

const internalError = new ApiError({
  type: "https://starter.local/problems/internal-server-error",
  title: "Internal Server Error",
  status: 500,
  code: "INTERNAL_ERROR",
  requestId: "request_internal",
});

const request = new Request(
  "https://app.example.test/projects/project_alpha?tab=details#ignored",
);

const renderAuthenticatedLayout = ({
  navigateToProviderLogout,
}: {
  navigateToProviderLogout?: () => void;
} = {}) => {
  const router = createMemoryRouter(
    [
      { path: "/login", element: <p>Login page</p> },
      {
        path: "/projects",
        loader: () => currentUser,
        element: (
          <AuthenticatedLayout
            {...(navigateToProviderLogout === undefined
              ? {}
              : { navigateToProviderLogout })}
          />
        ),
        children: [{ index: true, element: <p>Project outlet content</p> }],
      },
    ],
    { initialEntries: ["/projects"] },
  );

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return router;
};

beforeEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("authenticated loader", () => {
  it("returns the current authenticated user", async () => {
    const loader = createAuthenticatedLoader({
      getMe: vi.fn().mockResolvedValue(currentUser),
    });

    await expect(loader({ request } as never)).resolves.toEqual(currentUser);
  });

  it("redirects a 401 to login with pathname and search encoded once", async () => {
    const loader = createAuthenticatedLoader({
      getMe: vi.fn().mockRejectedValue(unauthenticated),
    });

    const result = await loader({ request } as never).catch(
      (error: unknown) => error,
    );

    expect(result).toBeInstanceOf(Response);
    expect(result).toMatchObject({ status: 302 });
    expect((result as Response).headers.get("Location")).toBe(
      "/login?returnTo=%2Fprojects%2Fproject_alpha%3Ftab%3Ddetails",
    );
  });

  it("rethrows a 500 API error", async () => {
    const loader = createAuthenticatedLoader({
      getMe: vi.fn().mockRejectedValue(internalError),
    });

    await expect(loader({ request } as never)).rejects.toBe(internalError);
  });
});

describe("AuthenticatedLayout", () => {
  it("renders the current user, Projects navigation, and child route", async () => {
    renderAuthenticatedLayout();

    expect(await screen.findByText("Local Developer")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute(
      "href",
      "/projects",
    );
    expect(screen.getByText("Project outlet content")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
  });

  it("navigates to the fixed provider logout route after session revocation", async () => {
    const user = userEvent.setup();
    let finishLogout: (() => void) | undefined;
    const logout = vi.spyOn(authClient, "logout").mockReturnValue(
      new Promise<void>((resolve) => {
        finishLogout = resolve;
      }),
    );
    const clear = vi.spyOn(queryClient, "clear");
    let cachedQueriesAtNavigation: number | undefined;
    const navigateToProviderLogout = vi.fn(() => {
      cachedQueriesAtNavigation = queryClient.getQueryCache().getAll().length;
    });
    queryClient.setQueryData(["projects"], { items: ["cached"] });
    renderAuthenticatedLayout({ navigateToProviderLogout });

    const button = await screen.findByRole("button", { name: "Sign out" });
    await user.dblClick(button);

    expect(logout).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
    expect(navigateToProviderLogout).not.toHaveBeenCalled();

    finishLogout?.();

    await waitFor(() =>
      expect(navigateToProviderLogout).toHaveBeenCalledOnce(),
    );
    expect(clear).toHaveBeenCalledOnce();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(cachedQueriesAtNavigation).toBe(0);
  });

  it("announces the in-flight sign out to assistive technology", async () => {
    const user = userEvent.setup();
    let finishLogout: (() => void) | undefined;
    vi.spyOn(authClient, "logout").mockReturnValue(
      new Promise<void>((resolve) => {
        finishLogout = resolve;
      }),
    );
    renderAuthenticatedLayout({ navigateToProviderLogout: vi.fn() });

    const button = await screen.findByRole("button", { name: "Sign out" });
    expect(button).toHaveAttribute("aria-busy", "false");

    await user.click(button);

    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();

    finishLogout?.();

    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "false"));
  });

  it("shows an alert and preserves route and query state when logout fails", async () => {
    const user = userEvent.setup();
    vi.spyOn(authClient, "logout").mockRejectedValue(
      new Error("network unavailable"),
    );
    const clear = vi.spyOn(queryClient, "clear");
    const navigateToProviderLogout = vi.fn();
    queryClient.setQueryData(["projects"], { items: ["cached"] });
    const router = renderAuthenticatedLayout({ navigateToProviderLogout });

    await user.click(await screen.findByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/sign out/i);
    await waitFor(() => expect(clear).not.toHaveBeenCalled());
    expect(navigateToProviderLogout).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(["projects"])).toEqual({
      items: ["cached"],
    });
    expect(router.state.location.pathname).toBe("/projects");
    expect(screen.getByText("Project outlet content")).toBeInTheDocument();
  });
});

describe("AuthenticatedLayout ErrorBoundary", () => {
  it("recovers a failed session load with Retry instead of the default error screen", async () => {
    const user = userEvent.setup();
    const getMe = vi
      .fn()
      .mockRejectedValueOnce(internalError)
      .mockResolvedValue(currentUser);
    const loadUser = createAuthenticatedLoader({ getMe });
    const router = createMemoryRouter(
      [
        {
          path: "/projects",
          loader: ({ request }) => loadUser({ request } as never),
          element: <AuthenticatedLayout />,
          errorElement: <ErrorBoundary />,
          children: [{ index: true, element: <p>Project outlet content</p> }],
        },
      ],
      { initialEntries: ["/projects"] },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Request ID: request_internal",
    );
    expect(screen.queryByText(/Internal Server Error/u)).toBeNull();
    // 外枠のエラーは Projects に限らない失敗（/api/me など）も受けるので、機能名を出さない。
    expect(
      screen.getByRole("heading", { name: "読み込めませんでした" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Projects/u)).toBeNull();

    await user.click(screen.getByRole("button", { name: "再試行" }));

    expect(await screen.findByText("Local Developer")).toBeInTheDocument();
    expect(screen.getByText("Project outlet content")).toBeInTheDocument();
  });
});
