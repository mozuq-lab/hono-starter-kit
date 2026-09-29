import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

const restrictedImportDiagnostics = (result: ESLint.LintResult) =>
  result.messages
    .filter((message) => message.ruleId === "no-restricted-imports")
    .map(({ ruleId, severity, message }) => ({ ruleId, severity, message }));

const dependencyBoundaryDiagnostics = (result: ESLint.LintResult) =>
  result.messages.filter(
    (message) =>
      message.ruleId === "no-restricted-imports" ||
      message.ruleId?.startsWith("dependency-boundaries/"),
  );

const expectedDiagnostic = (importSource: string, message: string) => ({
  ruleId: "no-restricted-imports",
  severity: 2,
  message: `'${importSource}' import is restricted from being used by a pattern. ${message}`,
});

const assertSingleBoundaryDiagnostic = (
  result: ESLint.LintResult,
  {
    ruleId,
    message,
    source,
  }: { ruleId: string; message: string; source: string },
) => {
  const diagnostics = result.messages.filter(
    (diagnostic) =>
      diagnostic.severity === 2 && diagnostic.message.endsWith(message),
  );

  assert.equal(
    diagnostics.length,
    1,
    `${source} must emit exactly one dependency-boundary diagnostic`,
  );
  assert.equal(diagnostics[0]?.ruleId, ruleId);
};

const createModuleFormProbes = (
  specifier: string,
  expressionRuleId: string,
): { importSource?: string; ruleId: string; source: string }[] => [
  {
    importSource: specifier,
    ruleId: "no-restricted-imports",
    source: `import "${specifier}";`,
  },
  {
    importSource: specifier,
    ruleId: "no-restricted-imports",
    source: `import type { Probe } from "${specifier}"; export type Result = Probe;`,
  },
  {
    ruleId: expressionRuleId,
    source: `export type Result = import("${specifier}").Probe;`,
  },
  {
    ruleId: expressionRuleId,
    source: `export const load = () => import("${specifier}");`,
  },
  {
    ruleId: expressionRuleId,
    source: `export const dependency = require("${specifier}");`,
  },
];

const assertForbiddenModuleForms = async ({
  expressionRuleId,
  filePath,
  message,
  specifiers,
}: {
  expressionRuleId: string;
  filePath: string;
  message: string;
  specifiers: readonly string[];
}) => {
  for (const specifier of specifiers) {
    for (const probe of createModuleFormProbes(specifier, expressionRuleId)) {
      const [result] = await eslint.lintText(probe.source, { filePath });

      if (probe.ruleId === "no-restricted-imports") {
        assert.deepEqual(restrictedImportDiagnostics(result!), [
          expectedDiagnostic(probe.importSource!, message),
        ]);
        continue;
      }

      assertSingleBoundaryDiagnostic(result!, {
        ruleId: probe.ruleId,
        message,
        source: probe.source,
      });
    }
  }
};

const otelProbeSources = (specifier: string) => [
  `import "${specifier}";`,
  `import type { Probe } from "${specifier}"; export type Result = Probe;`,
  `export type Result = import("${specifier}").Probe;`,
  `export const load = () => import("${specifier}");`,
  `export const dependency = require("${specifier}");`,
  `export { Probe } from "${specifier}";`,
  `export * from "${specifier}";`,
];

const javascriptOidcProbeSources = (specifier: string) => [
  `import "${specifier}";`,
  `export { Probe } from "${specifier}";`,
  `export * from "${specifier}";`,
  `export const load = () => import("${specifier}");`,
  `export const dependency = require("${specifier}");`,
];

const oidcSdkSpecifiers = [
  "openid-client",
  "openid-client/helpers",
  "oauth4webapi",
  "oauth4webapi/build",
  "amazon-cognito-identity-js",
  "amazon-cognito-identity-js/lib",
  "@aws-sdk/client-cognito-identity",
  "@aws-sdk/client-cognito-identity/commands",
  "@aws-sdk/client-cognito-identity-provider",
  "@aws-sdk/client-cognito-identity-provider/commands",
];

test("OpenTelemetry implementation packages belong only to api-node", async () => {
  for (const filePath of [
    "apps/web/app/routes/projects.tsx",
    "packages/backend/src/modules/projects/list-projects.ts",
    "packages/database/src/database.ts",
    "packages/contracts/src/index.ts",
  ]) {
    for (const source of otelProbeSources("@opentelemetry/sdk-node")) {
      const [result] = await eslint.lintText(source, { filePath });
      assertSingleBoundaryDiagnostic(result!, {
        ruleId: "dependency-boundaries/otel-ownership",
        message: "OpenTelemetry implementation belongs to apps/api-node.",
        source,
      });
    }
  }
});

test("only the request-ID adapter may use the OpenTelemetry API outside api-node", async () => {
  const [allowed] = await eslint.lintText(
    'import { trace } from "@opentelemetry/api"; void trace;',
    { filePath: "packages/backend/src/app/request-id.ts" },
  );
  assert.deepEqual(dependencyBoundaryDiagnostics(allowed!), []);

  for (const source of otelProbeSources("@opentelemetry/api")) {
    const [forbidden] = await eslint.lintText(source, {
      filePath: "packages/backend/src/modules/projects/list-projects.ts",
    });
    assertSingleBoundaryDiagnostic(forbidden!, {
      ruleId: "dependency-boundaries/otel-ownership",
      message:
        "Only the request-ID adapter may use @opentelemetry/api outside apps/api-node.",
      source,
    });
  }
});

test("api-node owns OpenTelemetry implementation", async () => {
  const [allowed] = await eslint.lintText(
    'import { NodeSDK } from "@opentelemetry/sdk-node"; void NodeSDK;',
    { filePath: "apps/api-node/src/telemetry.ts" },
  );
  assert.deepEqual(dependencyBoundaryDiagnostics(allowed!), []);
});

test("OIDC and provider identity SDKs belong only to api-node", async () => {
  const specifiers = [
    "openid-client",
    "oauth4webapi",
    "@aws-sdk/client-cognito-identity-provider",
    "amazon-cognito-identity-js",
  ];

  for (const filePath of [
    "apps/web/app/root.tsx",
    "packages/backend/src/platform/auth/auth.model.ts",
    "packages/database/src/database.ts",
    "packages/contracts/src/index.ts",
  ]) {
    for (const specifier of specifiers) {
      for (const source of otelProbeSources(specifier)) {
        const [result] = await eslint.lintText(source, { filePath });
        assertSingleBoundaryDiagnostic(result!, {
          ruleId: "dependency-boundaries/oidc-ownership",
          message: "OIDC and provider identity SDKs belong to apps/api-node.",
          source,
        });
      }
    }
  }
});

test("api-node owns OIDC and provider identity SDKs", async () => {
  for (const specifier of [
    "openid-client",
    "oauth4webapi",
    "@aws-sdk/client-cognito-identity-provider",
    "amazon-cognito-identity-js",
  ]) {
    const [allowed] = await eslint.lintText(`import "${specifier}";`, {
      filePath: "apps/api-node/src/oidc-identity-provider.ts",
    });
    assert.deepEqual(dependencyBoundaryDiagnostics(allowed!), []);
  }
});

test("JavaScript modules outside api-node reject every OIDC SDK module form", async () => {
  for (const filePath of [
    "apps/web/app/identity.js",
    "packages/backend/src/platform/auth/identity.mjs",
    "packages/database/src/identity.cjs",
  ]) {
    for (const specifier of oidcSdkSpecifiers) {
      for (const source of javascriptOidcProbeSources(specifier)) {
        const [result] = await eslint.lintText(source, { filePath });
        assertSingleBoundaryDiagnostic(result!, {
          ruleId: "dependency-boundaries/oidc-ownership",
          message: "OIDC and provider identity SDKs belong to apps/api-node.",
          source,
        });
      }
    }
  }
});

test("api-node owns OIDC SDK imports in JavaScript modules", async () => {
  for (const extension of ["js", "mjs", "cjs"]) {
    for (const specifier of oidcSdkSpecifiers) {
      for (const source of javascriptOidcProbeSources(specifier)) {
        const [result] = await eslint.lintText(source, {
          filePath: `apps/api-node/src/identity.${extension}`,
        });
        assert.deepEqual(dependencyBoundaryDiagnostics(result!), []);
      }
    }
  }
});

test("enabling JavaScript OIDC ownership does not widen OpenTelemetry ownership", async () => {
  const [result] = await eslint.lintText(
    'import { NodeSDK } from "@opentelemetry/sdk-node"; void NodeSDK;',
    { filePath: "packages/backend/src/telemetry.mjs" },
  );

  assert.equal(
    result!.messages.some(
      (message) => message.ruleId === "dependency-boundaries/otel-ownership",
    ),
    false,
  );
});

test("web rejects backend root and subpath imports with its exact diagnostic", async () => {
  const probes = [
    {
      importSource: "@starter/backend",
      source: 'import { createApp } from "@starter/backend"; void createApp;',
    },
    {
      importSource: "@starter/backend/app-type",
      source:
        'import type { PublicAppType } from "@starter/backend/app-type"; export type Probe = PublicAppType;',
    },
  ];

  for (const probe of probes) {
    const [result] = await eslint.lintText(probe.source, {
      filePath: "apps/web/app/routes/projects.tsx",
    });

    assert.deepEqual(restrictedImportDiagnostics(result!), [
      expectedDiagnostic(
        probe.importSource,
        "Web must use @starter/api-client and public contracts.",
      ),
    ]);
  }

  const expressionProbes = [
    'export type Probe = import("@starter/backend").Project;',
    'export const load = () => import("@starter/backend");',
    "export const load = () => import(`@starter/backend/app-type`);",
    'export const backend = require("@starter/backend");',
    "export const backend = require(`@starter/backend/app-type`);",
    'declare function require(specifier: string, options?: unknown): unknown; export const backend = require!("@starter/backend");',
    'declare const require: unknown; export const backend = (require as (specifier: string) => unknown)("@starter/backend");',
    'declare const require: unknown; export const backend = (<(specifier: string) => unknown>require)("@starter/backend");',
    'declare function require<T>(specifier: string): T; export const backend = require<unknown>("@starter/backend");',
    'declare function require<T>(specifier: string): T; export const backend = (require<unknown>)("@starter/backend");',
    'declare function require<T>(specifier: string): T; export const backend = ((require! as typeof require)<unknown>)("@starter/backend");',
    'declare const require: ((specifier: string) => unknown) | undefined; export const backend = require?.("@starter/backend");',
    'declare function require(specifier: string, options?: unknown): unknown; export const backend = require("@starter/backend", undefined);',
  ];

  for (const source of expressionProbes) {
    const [result] = await eslint.lintText(source, {
      filePath: "apps/web/app/routes.ts",
    });

    assertSingleBoundaryDiagnostic(result!, {
      ruleId: "dependency-boundaries/web-backend",
      message: "Web must use @starter/api-client and public contracts.",
      source,
    });
  }

  const [allowedExpression] = await eslint.lintText(
    'export const load = () => import("@starter/api-client");',
    { filePath: "apps/web/app/routes.ts" },
  );
  assert.deepEqual(dependencyBoundaryDiagnostics(allowedExpression!), []);
});

test("api client permits the backend app type only through type-only imports", async () => {
  const allowedSources = [
    'import type { PublicAppType } from "@starter/backend/app-type"; export type Probe = PublicAppType;',
    'import { type PublicAppType } from "@starter/backend/app-type"; export type Probe = PublicAppType;',
  ];

  for (const source of allowedSources) {
    const [result] = await eslint.lintText(source, {
      filePath: "packages/api-client/src/client.ts",
    });

    assert.deepEqual(dependencyBoundaryDiagnostics(result!), []);
  }

  const forbiddenProbes = [
    {
      ruleId: "no-restricted-imports",
      source:
        'import type { Project } from "@starter/backend"; export type Probe = Project;',
    },
    {
      ruleId: "no-restricted-imports",
      source:
        'import type { ProjectModel } from "@starter/backend/src/modules/projects/project.model"; export type Probe = ProjectModel;',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'import type { InternalAppType } from "@starter/backend/app-type"; export type Probe = InternalAppType;',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'import type { PublicAppType as AppType } from "@starter/backend/app-type"; export type Probe = AppType;',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'import { type PublicAppType as AppType } from "@starter/backend/app-type"; export type Probe = AppType;',
    },
    {
      ruleId: "no-restricted-imports",
      source: 'import { createApp } from "@starter/backend"; void createApp;',
    },
    {
      ruleId: "no-restricted-imports",
      source:
        'import { createApp } from "@starter/backend/src/app/create-app"; void createApp;',
    },
    {
      ruleId: "no-restricted-imports",
      source:
        'import { PublicAppType } from "@starter/backend/app-type"; export type Probe = PublicAppType;',
    },
    {
      ruleId: "no-restricted-imports",
      source:
        'import { InternalAppType } from "@starter/backend/app-type"; export type Probe = InternalAppType;',
    },
    {
      ruleId: "no-restricted-imports",
      source: 'import "@starter/backend/app-type";',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source: 'export type X = import("@starter/backend").Project;',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'export type X = import("@starter/backend/src/modules/projects/project.model").ProjectModel;',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source: 'export const load = () => import("@starter/backend");',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source: "export const load = () => import(`@starter/backend`);",
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'export const load = () => import("@starter/backend/src/app/create-app");',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source: 'export const load = () => import("@starter/backend/app-type");',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source: 'export type { PublicAppType } from "@starter/backend/app-type";',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source: 'export { type PublicAppType } from "@starter/backend/app-type";',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source: 'export type * from "@starter/backend/app-type";',
    },
    {
      ruleId: "no-restricted-imports",
      source: 'export type { Project } from "@starter/backend";',
    },
    {
      ruleId: "no-restricted-imports",
      source:
        'export type { ProjectModel } from "@starter/backend/src/modules/projects/project.model";',
    },
    {
      ruleId: "no-restricted-imports",
      source: 'export { createApp } from "@starter/backend";',
    },
    {
      ruleId: "no-restricted-imports",
      source:
        'export { createApp } from "@starter/backend/src/app/create-app";',
    },
    {
      ruleId: "no-restricted-imports",
      source: 'export * from "@starter/backend";',
    },
    {
      ruleId: "no-restricted-imports",
      source: 'export * from "@starter/backend/src/app/create-app";',
    },
    {
      ruleId: "no-restricted-imports",
      source: 'export { PublicAppType } from "@starter/backend/app-type";',
    },
    {
      ruleId: "no-restricted-imports",
      source: 'export * from "@starter/backend/app-type";',
    },
    {
      ruleId: "no-restricted-imports",
      source:
        'import Backend = require("@starter/backend"); export { Backend };',
    },
    {
      ruleId: "no-restricted-imports",
      source:
        'import Backend = require("@starter/backend/src/app/create-app"); export { Backend };',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'import type Backend = require("@starter/backend/app-type"); export type Probe = Backend.PublicAppType;',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'declare function require(specifier: string, options?: unknown): unknown; export const backend = require!("@starter/backend");',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'declare const require: unknown; export const backend = (require as (specifier: string) => unknown)("@starter/backend");',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'declare const require: unknown; export const backend = (<(specifier: string) => unknown>require)("@starter/backend");',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'declare function require<T>(specifier: string): T; export const backend = require<unknown>("@starter/backend");',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'declare function require<T>(specifier: string): T; export const backend = (require<unknown>)("@starter/backend");',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'declare function require<T>(specifier: string): T; export const backend = ((require! as typeof require)<unknown>)("@starter/backend");',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'declare const require: ((specifier: string) => unknown) | undefined; export const backend = require?.("@starter/backend");',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'declare function require(specifier: string, options?: unknown): unknown; export const backend = require("@starter/backend", undefined);',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source: 'export const backend = require("@starter/backend");',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source: "export const backend = require(`@starter/backend`);",
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source:
        'export const backend = require("@starter/backend/src/app/create-app");',
    },
    {
      ruleId: "dependency-boundaries/api-client-backend-types",
      source: 'export const backend = require("@starter/backend/app-type");',
    },
  ];

  for (const probe of forbiddenProbes) {
    const [result] = await eslint.lintText(probe.source, {
      filePath: "packages/api-client/src/client.ts",
    });

    assertSingleBoundaryDiagnostic(result!, {
      ruleId: probe.ruleId,
      message: "API client may import only PublicAppType as a type.",
      source: probe.source,
    });
  }
});

test("backend rejects database root and subpath imports in every module form", async () => {
  await assertForbiddenModuleForms({
    expressionRuleId: "dependency-boundaries/backend-database",
    filePath: "packages/backend/src/modules/projects/list-projects.ts",
    message: "Backend must expose ports without importing @starter/database.",
    specifiers: ["@starter/database", "@starter/database/project-row"],
  });
});

test("web rejects database root and subpath imports in every module form", async () => {
  await assertForbiddenModuleForms({
    expressionRuleId: "dependency-boundaries/web-database",
    filePath: "apps/web/app/routes/projects.tsx",
    message: "Web must use @starter/api-client and public contracts.",
    specifiers: ["@starter/database", "@starter/database/project-row"],
  });
});

test("api client rejects database root and subpath imports in every module form", async () => {
  await assertForbiddenModuleForms({
    expressionRuleId: "dependency-boundaries/api-client-database",
    filePath: "packages/api-client/src/client.ts",
    message: "API client must not import @starter/database.",
    specifiers: ["@starter/database", "@starter/database/project-row"],
  });
});

test("database accepts backend ports and types", async () => {
  const allowedSources = [
    'import type { ProjectRepository } from "@starter/backend"; export type Probe = ProjectRepository;',
    'import type { Project } from "@starter/backend/modules/projects/project.model"; export type Probe = Project;',
  ];

  for (const source of allowedSources) {
    const [result] = await eslint.lintText(source, {
      filePath: "packages/database/src/project.repository.kysely.ts",
    });

    assert.deepEqual(dependencyBoundaryDiagnostics(result!), []);
  }
});

test("database imports only types from backend at runtime", async () => {
  const message =
    "Database may import only types from @starter/backend; its index loads the Hono app.";
  const forbiddenSources = [
    'import { getDevIdentity } from "@starter/backend"; void getDevIdentity;',
    'import { getDevIdentity, type VerifiedIdentity } from "@starter/backend"; void getDevIdentity; export type Probe = VerifiedIdentity;',
    'import "@starter/backend";',
    'import * as backend from "@starter/backend"; void backend;',
    'export { getDevIdentity } from "@starter/backend";',
    'export * from "@starter/backend";',
    'export const load = () => import("@starter/backend");',
    'export const dependency = require("@starter/backend");',
    'import { createApp } from "@starter/backend/app/create-app"; void createApp;',
  ];

  for (const source of forbiddenSources) {
    const [result] = await eslint.lintText(source, {
      filePath: "packages/database/src/seed.ts",
    });
    assertSingleBoundaryDiagnostic(result!, {
      ruleId: "dependency-boundaries/database-backend-types",
      message,
      source,
    });
  }

  const allowedSources = [
    'import type { VerifiedIdentity } from "@starter/backend"; export type Probe = VerifiedIdentity;',
    'import { type VerifiedIdentity } from "@starter/backend"; export type Probe = VerifiedIdentity;',
    'export type { VerifiedIdentity } from "@starter/backend";',
    'export type Probe = import("@starter/backend").VerifiedIdentity;',
  ];

  for (const source of allowedSources) {
    const [result] = await eslint.lintText(source, {
      filePath: "packages/database/src/seed.ts",
    });
    assert.deepEqual(dependencyBoundaryDiagnostics(result!), [], source);
  }
});

// 統合テストは adapter を本物のユースケースから呼んで確かめるので、backend を実行時に読む。
// テストはランタイムの依存グラフに入らないため、型だけの制約から外す。
test("database integration tests may drive backend use cases", async () => {
  const [result] = await eslint.lintText(
    'import { createEstablishSession } from "@starter/backend"; void createEstablishSession;',
    { filePath: "packages/database/src/auth-sessions.integration.test.ts" },
  );
  assert.deepEqual(dependencyBoundaryDiagnostics(result!), []);
});

test("database source files import only types from backend", async () => {
  const results = await eslint.lintFiles(["packages/database/src/**/*.ts"]);
  const violations = results.flatMap((result) =>
    result.messages
      .filter(
        (message) =>
          message.ruleId === "dependency-boundaries/database-backend-types",
      )
      .map((message) => `${result.filePath}:${message.line}`),
  );
  assert.deepEqual(violations, []);
});

test("database rejects outward framework and API client imports in every module form", async () => {
  await assertForbiddenModuleForms({
    expressionRuleId: "dependency-boundaries/database-outward-dependencies",
    filePath: "packages/database/src/project.repository.kysely.ts",
    message: "Database must remain an adapter behind backend ports and types.",
    specifiers: [
      "hono",
      "hono/client",
      "react",
      "react/jsx-runtime",
      "react-router",
      "react-router/dom",
      "@starter/api-client",
      "@starter/api-client/projects",
    ],
  });
});

test("contracts reject workspace, Hono, and Node imports", async () => {
  const probes = [
    {
      importSource: "@starter/backend",
      source: 'import { createApp } from "@starter/backend"; void createApp;',
    },
    {
      importSource: "hono",
      source: 'import { Hono } from "hono"; void Hono;',
    },
    {
      importSource: "hono/client",
      source: 'import { hc } from "hono/client"; void hc;',
    },
    {
      importSource: "fs",
      source: 'import { readFile } from "fs"; void readFile;',
    },
    {
      importSource: "fs/promises",
      source: 'import { readFile } from "fs/promises"; void readFile;',
    },
    {
      importSource: "node:fs",
      source: 'import { readFile } from "node:fs"; void readFile;',
    },
    {
      importSource: "node:fs/promises",
      source: 'import { readFile } from "node:fs/promises"; void readFile;',
    },
  ];

  for (const probe of probes) {
    const [result] = await eslint.lintText(probe.source, {
      filePath: "packages/contracts/src/index.ts",
    });

    assert.deepEqual(restrictedImportDiagnostics(result!), [
      expectedDiagnostic(
        probe.importSource,
        "Contracts must remain browser-safe.",
      ),
    ]);
  }

  const expressionProbes = [
    'export type Probe = import("@starter/backend").Project;',
    'export type HonoProbe = import("hono").Hono;',
    'export type NodeProbe = import("node:fs").Stats;',
    'export const load = () => import("@starter/backend");',
    'export const load = () => import("hono");',
    'export const load = () => import("node:fs");',
    "export const load = () => import(`fs/promises`);",
    'export const backend = require("@starter/backend");',
    'export const hono = require("hono/client");',
    'export const fs = require("node:fs");',
    "export const fsPromises = require(`fs/promises`);",
    'declare function require(specifier: string, options?: unknown): unknown; export const fs = require!("node:fs");',
    'declare const require: unknown; export const fs = (require as (specifier: string) => unknown)("node:fs");',
    'declare const require: unknown; export const fs = (<(specifier: string) => unknown>require)("node:fs");',
    'declare function require<T>(specifier: string): T; export const fs = require<unknown>("node:fs");',
    'declare function require<T>(specifier: string): T; export const fs = (require<unknown>)("node:fs");',
    'declare function require<T>(specifier: string): T; export const fs = ((require! as typeof require)<unknown>)("node:fs");',
    'declare const require: ((specifier: string) => unknown) | undefined; export const fs = require?.("node:fs");',
    'declare function require(specifier: string, options?: unknown): unknown; export const fs = require("node:fs", undefined);',
  ];

  for (const source of expressionProbes) {
    const [result] = await eslint.lintText(source, {
      filePath: "packages/contracts/src/index.ts",
    });

    assertSingleBoundaryDiagnostic(result!, {
      ruleId: "dependency-boundaries/contracts-browser-safe",
      message: "Contracts must remain browser-safe.",
      source,
    });
  }

  const [allowedExpression] = await eslint.lintText(
    'export const load = () => import("zod");',
    { filePath: "packages/contracts/src/index.ts" },
  );
  assert.deepEqual(dependencyBoundaryDiagnostics(allowedExpression!), []);
});

test("contracts reject database root and subpath imports in every module form", async () => {
  await assertForbiddenModuleForms({
    expressionRuleId: "dependency-boundaries/contracts-browser-safe",
    filePath: "packages/contracts/src/index.ts",
    message: "Contracts must remain browser-safe.",
    specifiers: ["@starter/database", "@starter/database/project-row"],
  });
});

test("the web build config does not reach into the E2E process harness", async () => {
  const source = await readFile(
    new URL("../apps/web/vite.config.ts", import.meta.url),
    "utf8",
  );

  // ハーネスは spawn / net / ワークスペース解決を伴う。ビルド設定が読み込むと、
  // すべての vite build・vite dev・playwright 起動がテスト用の依存を評価する。
  assert.doesNotMatch(
    source,
    /from\s+"\.\/e2e\//u,
    "vite.config.ts must not import the E2E harness",
  );
});
