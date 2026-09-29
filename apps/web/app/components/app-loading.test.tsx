// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AppLoading } from "./app-loading.js";

afterEach(cleanup);

describe("AppLoading", () => {
  it("announces a busy state without naming any feature", () => {
    render(<AppLoading />);

    const loading = screen.getByRole("main");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveTextContent("読み込んでいます。");
    expect(loading).not.toHaveTextContent("Projects");
  });
});
