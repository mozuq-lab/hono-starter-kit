import eslint from "@eslint/js";
import { builtinModules } from "node:module";
import tseslint from "typescript-eslint";

const getStaticModuleSpecifier = (node) => {
  if (typeof node?.value === "string") {
    return node.value;
  }

  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked;
  }

  return undefined;
};

const transparentCalleeWrappers = new Set([
  "TSNonNullExpression",
  "TSAsExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "ChainExpression",
]);

const unwrapTransparentCallee = (node) => {
  let callee = node;

  while (transparentCalleeWrappers.has(callee.type)) {
    callee = callee.expression;
  }

  return callee;
};

const createStaticModuleExpressionVisitors = ({ isForbidden, report }) => ({
  TSImportType(node) {
    if (isForbidden(getStaticModuleSpecifier(node.source))) {
      report(node);
    }
  },
  ImportExpression(node) {
    if (isForbidden(getStaticModuleSpecifier(node.source))) {
      report(node);
    }
  },
  CallExpression(node) {
    const callee = unwrapTransparentCallee(node.callee);

    if (
      callee.type === "Identifier" &&
      callee.name === "require" &&
      node.arguments.length >= 1 &&
      isForbidden(getStaticModuleSpecifier(node.arguments[0]))
    ) {
      report(node);
    }
  },
});

const createStaticModuleExpressionRule = ({
  messageId,
  message,
  isForbidden,
}) => ({
  meta: {
    type: "problem",
    schema: [],
    messages: {
      [messageId]: message,
    },
  },
  create(context) {
    return createStaticModuleExpressionVisitors({
      isForbidden,
      report: (node) => context.report({ node, messageId }),
    });
  },
});

const createAllStaticModuleVisitors = (reportSpecifier) => ({
  ImportDeclaration(node) {
    reportSpecifier(node, getStaticModuleSpecifier(node.source));
  },
  ExportNamedDeclaration(node) {
    if (node.source !== null) {
      reportSpecifier(node, getStaticModuleSpecifier(node.source));
    }
  },
  ExportAllDeclaration(node) {
    reportSpecifier(node, getStaticModuleSpecifier(node.source));
  },
  TSImportEqualsDeclaration(node) {
    if (node.moduleReference.type === "TSExternalModuleReference") {
      reportSpecifier(
        node,
        getStaticModuleSpecifier(node.moduleReference.expression),
      );
    }
  },
  TSImportType(node) {
    reportSpecifier(node, getStaticModuleSpecifier(node.source));
  },
  ImportExpression(node) {
    reportSpecifier(node, getStaticModuleSpecifier(node.source));
  },
  CallExpression(node) {
    const callee = unwrapTransparentCallee(node.callee);
    if (
      callee.type === "Identifier" &&
      callee.name === "require" &&
      node.arguments.length >= 1
    ) {
      reportSpecifier(node, getStaticModuleSpecifier(node.arguments[0]));
    }
  },
});

const isBackendSpecifier = (specifier) =>
  specifier === "@starter/backend" ||
  specifier?.startsWith("@starter/backend/");

const isDatabaseSpecifier = (specifier) =>
  specifier === "@starter/database" ||
  specifier?.startsWith("@starter/database/");

const isDatabaseOutwardSpecifier = (specifier) =>
  specifier === "hono" ||
  specifier?.startsWith("hono/") ||
  specifier === "react" ||
  specifier?.startsWith("react/") ||
  specifier === "react-router" ||
  specifier?.startsWith("react-router/") ||
  specifier === "@starter/api-client" ||
  specifier?.startsWith("@starter/api-client/");

const isOpenTelemetrySpecifier = (specifier) =>
  specifier === "@opentelemetry/api" ||
  specifier?.startsWith("@opentelemetry/");

const isOpenTelemetryImplementationSpecifier = (specifier) =>
  specifier?.startsWith("@opentelemetry/") &&
  specifier !== "@opentelemetry/api";

const isOidcOrProviderIdentitySdkSpecifier = (specifier) =>
  specifier === "openid-client" ||
  specifier?.startsWith("openid-client/") ||
  specifier === "oauth4webapi" ||
  specifier?.startsWith("oauth4webapi/") ||
  specifier === "amazon-cognito-identity-js" ||
  specifier?.startsWith("amazon-cognito-identity-js/") ||
  specifier === "@aws-sdk/client-cognito-identity" ||
  specifier?.startsWith("@aws-sdk/client-cognito-identity/") ||
  specifier === "@aws-sdk/client-cognito-identity-provider" ||
  specifier?.startsWith("@aws-sdk/client-cognito-identity-provider/");

const normalizeLintFilename = (filename) => filename.replaceAll("\\", "/");

const openTelemetryOwnershipRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      adapterOnly: "OpenTelemetry implementation belongs to apps/api-node.",
      apiOnly:
        "Only the request-ID adapter may use @opentelemetry/api outside apps/api-node.",
    },
  },
  create(context) {
    const filename = normalizeLintFilename(context.filename);
    const ownsImplementation = filename.includes("/apps/api-node/");
    const isRequestIdAdapter = filename.endsWith(
      "/packages/backend/src/app/request-id.ts",
    );
    const reportSpecifier = (node, specifier) => {
      if (!isOpenTelemetrySpecifier(specifier) || ownsImplementation) return;
      if (
        isRequestIdAdapter &&
        !isOpenTelemetryImplementationSpecifier(specifier)
      ) {
        return;
      }
      context.report({
        node,
        messageId: isOpenTelemetryImplementationSpecifier(specifier)
          ? "adapterOnly"
          : "apiOnly",
      });
    };

    return createAllStaticModuleVisitors(reportSpecifier);
  },
};

const oidcOwnershipRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      adapterOnly: "OIDC and provider identity SDKs belong to apps/api-node.",
    },
  },
  create(context) {
    const filename = normalizeLintFilename(context.filename);
    const ownsIdentityAdapters = filename.includes("/apps/api-node/");
    const reportSpecifier = (node, specifier) => {
      if (
        ownsIdentityAdapters ||
        !isOidcOrProviderIdentitySdkSpecifier(specifier)
      ) {
        return;
      }
      context.report({ node, messageId: "adapterOnly" });
    };

    return createAllStaticModuleVisitors(reportSpecifier);
  },
};

const apiClientBackendTypeImportRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      onlyPublicAppType: "API client may import only PublicAppType as a type.",
    },
  },
  create(context) {
    const boundaryMessage = "onlyPublicAppType";
    const exactTypePath = "@starter/backend/app-type";
    const report = (node) =>
      context.report({ node, messageId: boundaryMessage });

    return {
      ...createStaticModuleExpressionVisitors({
        isForbidden: isBackendSpecifier,
        report,
      }),
      ImportDeclaration(node) {
        if (node.source.value !== exactTypePath) {
          return;
        }

        const isTypeOnly =
          node.importKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every(
              (specifier) =>
                specifier.type === "ImportSpecifier" &&
                specifier.importKind === "type",
            ));

        if (!isTypeOnly) {
          return;
        }

        const [specifier] = node.specifiers;
        const isPublicAppType =
          node.specifiers.length === 1 &&
          specifier.type === "ImportSpecifier" &&
          specifier.imported.type === "Identifier" &&
          specifier.imported.name === "PublicAppType" &&
          specifier.local.name === "PublicAppType";

        if (!isPublicAppType) {
          report(node);
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source?.value !== exactTypePath) {
          return;
        }

        const isTypeOnly =
          node.exportKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every(
              (specifier) => specifier.exportKind === "type",
            ));

        if (isTypeOnly) {
          report(node);
        }
      },
      ExportAllDeclaration(node) {
        if (node.source.value === exactTypePath && node.exportKind === "type") {
          report(node);
        }
      },
      TSImportEqualsDeclaration(node) {
        if (
          node.importKind === "type" &&
          node.moduleReference.type === "TSExternalModuleReference" &&
          node.moduleReference.expression.value === exactTypePath
        ) {
          report(node);
        }
      },
    };
  },
};

const isInlineTypeOnly = (specifiers, kindOf) =>
  specifiers.length > 0 &&
  specifiers.every((specifier) => kindOf(specifier) === "type");

// backend の index は create-app を再 export するので、値を 1 つ読むだけで Hono ごと読み込まれる。
// database は backend の port と型を実装する側に留め、実行時の値は api-node から受け取る。
const databaseBackendTypeImportRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      onlyTypes:
        "Database may import only types from @starter/backend; its index loads the Hono app.",
    },
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: "onlyTypes" });

    return {
      ImportExpression(node) {
        if (isBackendSpecifier(getStaticModuleSpecifier(node.source))) {
          report(node);
        }
      },
      CallExpression(node) {
        const callee = unwrapTransparentCallee(node.callee);
        if (
          callee.type === "Identifier" &&
          callee.name === "require" &&
          node.arguments.length >= 1 &&
          isBackendSpecifier(getStaticModuleSpecifier(node.arguments[0]))
        ) {
          report(node);
        }
      },
      ImportDeclaration(node) {
        if (!isBackendSpecifier(node.source.value)) return;
        const isTypeOnly =
          node.importKind === "type" ||
          isInlineTypeOnly(node.specifiers, (specifier) =>
            specifier.type === "ImportSpecifier"
              ? specifier.importKind
              : "value",
          );
        if (!isTypeOnly) report(node);
      },
      ExportNamedDeclaration(node) {
        if (node.source === null || !isBackendSpecifier(node.source.value)) {
          return;
        }
        const isTypeOnly =
          node.exportKind === "type" ||
          isInlineTypeOnly(
            node.specifiers,
            (specifier) => specifier.exportKind,
          );
        if (!isTypeOnly) report(node);
      },
      ExportAllDeclaration(node) {
        if (
          isBackendSpecifier(node.source.value) &&
          node.exportKind !== "type"
        ) {
          report(node);
        }
      },
      TSImportEqualsDeclaration(node) {
        if (
          node.importKind !== "type" &&
          node.moduleReference.type === "TSExternalModuleReference" &&
          isBackendSpecifier(node.moduleReference.expression.value)
        ) {
          report(node);
        }
      },
    };
  },
};

const nodeBuiltinSpecifiers = [
  ...new Set(
    builtinModules.flatMap((moduleName) => {
      const bareName = moduleName.replace(/^node:/u, "");
      return [bareName, `node:${bareName}`];
    }),
  ),
].sort();

const nodeBuiltinSpecifierSet = new Set(nodeBuiltinSpecifiers);

const webBackendExpressionRule = createStaticModuleExpressionRule({
  messageId: "mustUsePublicPackages",
  message: "Web must use @starter/api-client and public contracts.",
  isForbidden: isBackendSpecifier,
});

const backendDatabaseExpressionRule = createStaticModuleExpressionRule({
  messageId: "mustDependOnPorts",
  message: "Backend must expose ports without importing @starter/database.",
  isForbidden: isDatabaseSpecifier,
});

const webDatabaseExpressionRule = createStaticModuleExpressionRule({
  messageId: "mustUsePublicPackages",
  message: "Web must use @starter/api-client and public contracts.",
  isForbidden: isDatabaseSpecifier,
});

const apiClientDatabaseExpressionRule = createStaticModuleExpressionRule({
  messageId: "mustNotImportDatabase",
  message: "API client must not import @starter/database.",
  isForbidden: isDatabaseSpecifier,
});

const databaseOutwardDependenciesExpressionRule =
  createStaticModuleExpressionRule({
    messageId: "mustRemainAdapter",
    message: "Database must remain an adapter behind backend ports and types.",
    isForbidden: isDatabaseOutwardSpecifier,
  });

const contractsBrowserSafeExpressionRule = createStaticModuleExpressionRule({
  messageId: "mustRemainBrowserSafe",
  message: "Contracts must remain browser-safe.",
  isForbidden: (specifier) =>
    specifier?.startsWith("@starter/") ||
    specifier === "hono" ||
    specifier?.startsWith("hono/") ||
    nodeBuiltinSpecifierSet.has(specifier),
});

const dependencyBoundariesPlugin = {
  rules: {
    "api-client-database": apiClientDatabaseExpressionRule,
    "api-client-backend-types": apiClientBackendTypeImportRule,
    "backend-database": backendDatabaseExpressionRule,
    "contracts-browser-safe": contractsBrowserSafeExpressionRule,
    "database-backend-types": databaseBackendTypeImportRule,
    "database-outward-dependencies": databaseOutwardDependenciesExpressionRule,
    "oidc-ownership": oidcOwnershipRule,
    "otel-ownership": openTelemetryOwnershipRule,
    "web-backend": webBackendExpressionRule,
    "web-database": webDatabaseExpressionRule,
  },
};

export default tseslint.config(
  {
    ignores: [
      "**/build/**",
      "**/coverage/**",
      "**/dist/**",
      "**/.react-router/**",
      ".superpowers/corepack/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "vitest.config.ts",
            "vitest.database.config.ts",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked,
  },
  // node:test の test() は Promise を返すが、呼び出し側が await しないのが正しい使い方。
  // require-await も同種で、非同期契約を満たすためだけに async を付けたテストダブルは
  // 待つものを持たない。どちらも移行の負債ではなくルール側の想定違いなので恒久的に外す。
  {
    files: ["scripts/**/*.test.ts", "scripts/**/*.acceptance.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    plugins: { "dependency-boundaries": dependencyBoundariesPlugin },
    rules: {
      "dependency-boundaries/oidc-ownership": "error",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "dependency-boundaries": dependencyBoundariesPlugin },
    rules: {
      "dependency-boundaries/otel-ownership": "error",
    },
  },
  {
    files: ["packages/backend/**/*.{ts,tsx}"],
    plugins: {
      "dependency-boundaries": dependencyBoundariesPlugin,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@starter/database", "@starter/database/*"],
              message:
                "Backend must expose ports without importing @starter/database.",
            },
          ],
        },
      ],
      "dependency-boundaries/backend-database": "error",
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: {
      "dependency-boundaries": dependencyBoundariesPlugin,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@starter/backend", "@starter/backend/*"],
              message: "Web must use @starter/api-client and public contracts.",
            },
            {
              group: ["@starter/database", "@starter/database/*"],
              message: "Web must use @starter/api-client and public contracts.",
            },
          ],
        },
      ],
      "dependency-boundaries/web-backend": "error",
      "dependency-boundaries/web-database": "error",
    },
  },
  {
    files: ["packages/api-client/**/*.{ts,tsx}"],
    plugins: {
      "dependency-boundaries": dependencyBoundariesPlugin,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@starter/backend/app-type",
              allowTypeImports: true,
              message: "API client may import only PublicAppType as a type.",
            },
          ],
          patterns: [
            {
              regex: "^@starter/backend(?:$|/(?!app-type$).+)",
              message: "API client may import only PublicAppType as a type.",
            },
            {
              group: ["@starter/database", "@starter/database/*"],
              message: "API client must not import @starter/database.",
            },
          ],
        },
      ],
      "dependency-boundaries/api-client-backend-types": "error",
      "dependency-boundaries/api-client-database": "error",
    },
  },
  {
    files: ["packages/database/**/*.{ts,tsx}"],
    plugins: {
      "dependency-boundaries": dependencyBoundariesPlugin,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "hono",
                "hono/*",
                "react",
                "react/*",
                "react-router",
                "react-router/*",
                "@starter/api-client",
                "@starter/api-client/*",
              ],
              message:
                "Database must remain an adapter behind backend ports and types.",
            },
          ],
        },
      ],
      "dependency-boundaries/database-outward-dependencies": "error",
    },
  },
  // 統合テストは adapter を本物のユースケースから呼んで確かめるので backend を実行時に読む。
  // テストはランタイムの依存グラフに入らないため対象から外す。
  {
    files: ["packages/database/src/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts"],
    plugins: {
      "dependency-boundaries": dependencyBoundariesPlugin,
    },
    rules: {
      "dependency-boundaries/database-backend-types": "error",
    },
  },
  {
    files: ["packages/contracts/**/*.{ts,tsx}"],
    plugins: {
      "dependency-boundaries": dependencyBoundariesPlugin,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@starter/*", "hono", "hono/*", ...nodeBuiltinSpecifiers],
              message: "Contracts must remain browser-safe.",
            },
          ],
        },
      ],
      "dependency-boundaries/contracts-browser-safe": "error",
    },
  },
);
