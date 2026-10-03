// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryRouter, RouterProvider } from "react-router";
import LoginRoute, { clientLoader } from "./login.js";

afterEach(cleanup);

const renderLogin = async (returnTo: string) => {
  const router = createMemoryRouter(
    [
      {
        path: "/login",
        loader: ({ request }) => clientLoader({ request } as never),
        Component: LoginRoute,
      },
    ],
    {
      initialEntries: [`/login?returnTo=${encodeURIComponent(returnTo)}`],
    },
  );

  render(<RouterProvider router={router} />);

  return screen.findByRole("link", { name: "Sign in" });
};

const renderLoginAt = async (entry: string) => {
  const router = createMemoryRouter(
    [
      {
        path: "/login",
        loader: ({ request }) => clientLoader({ request } as never),
        Component: LoginRoute,
      },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  await screen.findByRole("link", { name: "Sign in" });
};

describe("login route", () => {
  it("renders a same-origin login anchor with the valid return path encoded once", async () => {
    const link = await renderLogin(
      "/projects/project_alpha?tab=details&view=summary",
    );

    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute(
      "href",
      "/auth/login?returnTo=%2Fprojects%2Fproject_alpha%3Ftab%3Ddetails%26view%3Dsummary",
    );
  });

  it.each([
    "//evil.example/steal",
    "/projects/../auth/login?returnTo=%2Fprojects",
    "/projects\\evil",
  ])(
    "forwards the raw returnTo for the server to resolve: %s",
    async (returnTo) => {
      const link = await renderLogin(returnTo);

      expect(link).toHaveAttribute(
        "href",
        `/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
      );
    },
  );

  it("omits returnTo when the query has none", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/login",
          loader: ({ request }) => clientLoader({ request } as never),
          Component: LoginRoute,
        },
      ],
      { initialEntries: ["/login"] },
    );
    render(<RouterProvider router={router} />);

    expect(
      await screen.findByRole("link", { name: "Sign in" }),
    ).toHaveAttribute("href", "/auth/login");
  });

  it("tells the user that the previous sign-in failed", async () => {
    await renderLoginAt("/login?error=authentication_failed");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sign-in could not be completed. Please try again.",
    );
  });

  it("shows no alert on a normal visit or for an unknown error value", async () => {
    await renderLoginAt("/login?returnTo=%2Fprojects");
    expect(screen.queryByRole("alert")).toBeNull();
    cleanup();

    await renderLoginAt("/login?error=%3Cscript%3Eunknown");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toContain("unknown");
  });
});
