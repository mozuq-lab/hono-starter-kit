import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const bootstrapRoot = "infra/terraform/bootstrap";
const devRoot = "infra/terraform/environments/dev";

function listTerraformPaths() {
  return execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "infra/terraform",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();
}

async function readTerraformSources() {
  const paths = listTerraformPaths().filter((candidate) =>
    candidate.endsWith(".tf"),
  );

  assert.notEqual(paths.length, 0, "expected repository Terraform sources");

  const entries = await Promise.all(
    paths.map(async (relativePath): Promise<[string, string]> => [
      relativePath,
      await readFile(path.join(repositoryRoot, relativePath), "utf8"),
    ]),
  );
  return new Map(entries);
}

async function readDirectTerraformSources(directoryPath: string) {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tf"))
    .map((entry) => entry.name)
    .sort();
  const sources = await Promise.all(
    names.map(async (name): Promise<[string, string]> => [
      name,
      await readFile(path.join(directoryPath, name), "utf8"),
    ]),
  );
  return new Map(sources);
}

async function readBootstrapTerraformSources(
  directoryPath = path.join(repositoryRoot, bootstrapRoot),
) {
  const sources = await readDirectTerraformSources(directoryPath);
  return new Map(
    [...sources].map(([name, source]): [string, string] => [
      path.join(bootstrapRoot, name),
      source,
    ]),
  );
}

function listTrackedTerraformArtifactPaths(directory = repositoryRoot) {
  return execFileSync("git", ["ls-files", "-z", "--", "infra/terraform"], {
    cwd: directory,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function assertNoTerraformStateArtifacts(paths: readonly string[]) {
  for (const relativePath of paths) {
    assert.doesNotMatch(
      relativePath,
      /\.tfstate(?:\.|$)|\.tfplan(?:\.|$)/u,
      `Terraform state or plan artifacts must not be tracked: ${relativePath}`,
    );
  }
}

function assertEcsResourceOwnership(sources: ReadonlyMap<string, string>) {
  const declarations = [...sources].flatMap(([relativePath, source]) =>
    [...source.matchAll(/resource\s+"(aws_ecs_[^"]+)"\s+"([^"]+)"\s*\{/gu)].map(
      (match) => ({
        name: match[2],
        relativePath,
        type: match[1],
      }),
    ),
  );

  assert.notEqual(declarations.length, 0, "expected ECS workload resources");
  for (const declaration of declarations) {
    assert.match(
      declaration.relativePath,
      /^infra\/terraform\/modules\/workload\//u,
      `${declaration.type}.${declaration.name} must be declared by the workload module`,
    );
  }
}

function assertEcsServicePolicyDependencies(source: string) {
  assert.match(
    source,
    /resource\s+"aws_ecs_service"\s+"app"\s*\{[\s\S]*?depends_on\s*=\s*\[\s*aws_iam_role_policy\.task_execution,\s*aws_iam_role_policy\.runtime_task,\s*\]/u,
    "The ECS service must wait for both task IAM policies.",
  );
}

function maskHclCommentsAndHeredocs(source: string) {
  let result = "";
  let state = "normal";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "string") {
      result += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        state = "normal";
      }
      continue;
    }

    if (state === "line-comment") {
      if (character === "\n") {
        result += character;
        state = "normal";
      } else {
        result += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "normal";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (character === '"') {
      result += character;
      state = "string";
    } else if (character === "<" && next === "<") {
      const heredoc =
        /^<<(-?)([\p{ID_Start}_][\p{ID_Continue}_-]*)[ \t]*\r?\n/u.exec(
          source.slice(index),
        );
      if (heredoc === null) {
        result += character;
        continue;
      }

      const contentStart = index + heredoc[0].length;
      const escapedDelimiter = heredoc[2]!.replace(
        /[.*+?^${}()|[\]\\]/gu,
        "\\$&",
      );
      const terminator = new RegExp(
        `^${heredoc[1] === "-" ? "[\\t ]*" : ""}${escapedDelimiter}[\\t ]*(?:\\r?\\n|$)`,
        "mu",
      ).exec(source.slice(contentStart));
      const heredocEnd =
        terminator === null
          ? source.length
          : contentStart + terminator.index + terminator[0].length;
      result += heredoc[0];
      result += source
        .slice(contentStart, heredocEnd)
        .replace(/[^\r\n]/gu, " ");
      index = heredocEnd - 1;
    } else if (character === "#") {
      result += " ";
      state = "line-comment";
    } else if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line-comment";
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block-comment";
    } else {
      result += character;
    }
  }

  return result;
}

function maskHclStrings(source: string) {
  let result = "";
  let inString = false;
  let escaped = false;

  for (const character of source) {
    if (!inString) {
      if (character === '"') {
        result += " ";
        inString = true;
      } else {
        result += character;
      }
      continue;
    }

    result += character === "\n" ? "\n" : " ";
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      inString = false;
    }
  }

  return result;
}

function extractSimpleResourceBlocks(source: string, resourceType: string) {
  const structuralSource = maskHclCommentsAndHeredocs(source);
  const declarations = [
    ...structuralSource.matchAll(
      new RegExp(
        `^\\s*resource\\s+"${resourceType}"\\s+"([^"]+)"\\s*\\{`,
        "gmu",
      ),
    ),
  ];

  return declarations.map((match) => {
    const blockStart = match.index + match[0].lastIndexOf("{");
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = blockStart; index < structuralSource.length; index += 1) {
      const character = structuralSource[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      if (depth === 0) {
        return {
          body: structuralSource.slice(blockStart + 1, index),
          name: match[1],
        };
      }
    }

    assert.fail(`expected balanced ${resourceType}.${match[1]}`);
  });
}

function readSimpleAttribute(block: string, attribute: string) {
  const escapedAttribute = attribute.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return block
    .match(new RegExp(`^\\s*${escapedAttribute}\\s*=\\s*([^\\n#]+)`, "mu"))?.[1]
    ?.trim();
}

function extractSimpleModuleBlock(source: string, moduleName: string) {
  const structuralSource = maskHclCommentsAndHeredocs(source);
  const declaration = new RegExp(
    `^\\s*module\\s+"${moduleName}"\\s*\\{`,
    "mu",
  ).exec(structuralSource);
  assert.notEqual(declaration, null, `expected module.${moduleName}`);

  const blockStart = declaration!.index + declaration![0].lastIndexOf("{");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = blockStart; index < structuralSource.length; index += 1) {
    const character = structuralSource[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth === 0) return structuralSource.slice(blockStart + 1, index);
  }

  assert.fail(`expected balanced module.${moduleName}`);
}

function assertExactManagedPolicyAttachments(source: string) {
  const attachmentBlocks = extractSimpleResourceBlocks(
    source,
    "aws_iam_role_policy_attachment",
  ).sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""));
  const attachmentNames = attachmentBlocks.map(({ name }) => name);
  assert.deepEqual(attachmentNames, [
    "deploy_foundation_network",
    "deploy_foundation_read",
    "deploy_foundation_services",
    "deploy_workload_read",
    "plan_foundation_read",
    "plan_workload_read",
  ]);

  const attachments = attachmentBlocks.map(({ body, name }) => ({
    name,
    policyArn: readSimpleAttribute(body, "policy_arn"),
    role: readSimpleAttribute(body, "role"),
  }));

  assert.deepEqual(attachments, [
    {
      name: "deploy_foundation_network",
      policyArn: "aws_iam_policy.deploy_foundation_network[0].arn",
      role: "aws_iam_role.deploy[0].name",
    },
    {
      name: "deploy_foundation_read",
      policyArn: "aws_iam_policy.foundation_read[0].arn",
      role: "aws_iam_role.deploy[0].name",
    },
    {
      name: "deploy_foundation_services",
      policyArn: "aws_iam_policy.deploy_foundation_services[0].arn",
      role: "aws_iam_role.deploy[0].name",
    },
    {
      name: "deploy_workload_read",
      policyArn: "aws_iam_policy.workload_read[0].arn",
      role: "aws_iam_role.deploy[0].name",
    },
    {
      name: "plan_foundation_read",
      policyArn: "aws_iam_policy.foundation_read[0].arn",
      role: "aws_iam_role.plan[0].name",
    },
    {
      name: "plan_workload_read",
      policyArn: "aws_iam_policy.workload_read[0].arn",
      role: "aws_iam_role.plan[0].name",
    },
  ]);
}

function assertExactInlinePolicyAttachments(source: string) {
  const inlineAttachments = extractSimpleResourceBlocks(
    source,
    "aws_iam_role_policy",
  )
    .map(({ body, name }) => ({
      name,
      policy: readSimpleAttribute(body, "policy"),
      role: readSimpleAttribute(body, "role"),
    }))
    .sort((left, right) => (left.name ?? "").localeCompare(right.name ?? ""));

  assert.deepEqual(inlineAttachments, [
    {
      name: "deploy_foundation",
      policy: "local.deploy_foundation_deny_policy",
      role: "aws_iam_role.deploy[0].id",
    },
    {
      name: "deploy_state",
      policy: "local.deploy_state_access_policy",
      role: "aws_iam_role.deploy[0].id",
    },
    {
      name: "deploy_workload",
      policy: "local.deploy_workload_policy",
      role: "aws_iam_role.deploy[0].id",
    },
    {
      name: "plan_state",
      policy: "local.plan_state_access_policy",
      role: "aws_iam_role.plan[0].id",
    },
  ]);
}

function assertNoAlternateRolePolicyAttachments(source: string) {
  for (const resourceType of [
    "aws_iam_policy_attachment",
    "aws_iam_role_policy_attachments_exclusive",
    "aws_iam_role_policies_exclusive",
  ]) {
    assert.deepEqual(
      extractSimpleResourceBlocks(source, resourceType),
      [],
      `alternate IAM attachment mechanism ${resourceType} is prohibited`,
    );
  }

  for (const role of extractSimpleResourceBlocks(source, "aws_iam_role")) {
    const structuralBody = maskHclStrings(role.body);
    assert.doesNotMatch(
      structuralBody,
      /\bdynamic\s+\{/u,
      `alternate IAM attachment mechanism dynamic inline policy is prohibited on aws_iam_role.${role.name}`,
    );
    assert.doesNotMatch(
      structuralBody,
      /\binline_policy\s*\{/u,
      `alternate IAM attachment mechanism inline_policy is prohibited on aws_iam_role.${role.name}`,
    );
    assert.doesNotMatch(
      structuralBody,
      /\bmanaged_policy_arns\s*=/u,
      `alternate IAM attachment mechanism managed_policy_arns is prohibited on aws_iam_role.${role.name}`,
    );
  }
}

function assertExactBootstrapRoleAttachments(source: string) {
  assertNoAlternateRolePolicyAttachments(source);
  assertExactManagedPolicyAttachments(source);
  assertExactInlinePolicyAttachments(source);
}

function extractLocalJsonObject(source: string, localName: string) {
  const escapedName = localName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `\\b${escapedName}\\s*=\\s*jsonencode\\s*\\(\\s*\\{`,
    "u",
  ).exec(source);
  assert.notEqual(match, null, `expected local.${localName}`);

  const objectStart = source.indexOf("{", match!.index);
  let depth = 0;
  for (let index = objectStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(objectStart, index + 1);
  }

  assert.fail(`expected balanced local.${localName}`);
}

function readActionRhs(source: string, startIndex: number) {
  if (source[startIndex] !== "[") {
    return source.slice(startIndex, source.indexOf("\n", startIndex)).trim();
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') inString = true;
    if (character === "[") depth += 1;
    if (character === "]") depth -= 1;
    if (depth === 0) return source.slice(startIndex, index + 1).trim();
  }

  return source.slice(startIndex).trim();
}

function parseLiteralActions(rhs: string) {
  const literalStrings = [...rhs.matchAll(/"((?:[^"\\]|\\.)*)"/gu)];
  const remainder = rhs
    .replace(/"(?:[^"\\]|\\.)*"/gu, "")
    .replace(/[\s,[\]]/gu, "");
  const isLiteralString = /^"(?:[^"\\]|\\.)*"$/u.test(rhs);
  const isLiteralList =
    rhs.startsWith("[") && rhs.endsWith("]") && remainder === "";
  assert.ok(
    isLiteralString || isLiteralList,
    `workload IAM Action must use a literal string or list: ${rhs}`,
  );

  // 一致していれば捕捉グループは必ずある。
  const actions = literalStrings.map((match) => match[1]!);
  assert.notEqual(actions.length, 0, "expected literal Action entries");
  return actions;
}

function assertWorkloadPolicyActionsAreLiteralAndWildcardFree(source: string) {
  for (const localName of ["workload_read_policy", "deploy_workload_policy"]) {
    const policySource = extractLocalJsonObject(source, localName);
    const actionAssignments = [
      ...policySource.matchAll(/\bAction\s*=\s*/gu),
    ].map((match) =>
      readActionRhs(policySource, match.index + match[0].length),
    );
    assert.notEqual(
      actionAssignments.length,
      0,
      `expected Action entries in local.${localName}`,
    );

    for (const rhs of actionAssignments) {
      for (const action of parseLiteralActions(rhs)) {
        assert.doesNotMatch(
          action,
          /\*/u,
          `workload IAM Action must be wildcard-free: ${action}`,
        );
      }
    }
  }
}

function assertTaskDefinitionUsesDedicatedWorkloadRoles(source: string) {
  const roleAssignments = [
    ...source.matchAll(
      /^\s*(execution_role_arn|task_role_arn)\s*=\s*([^\n#]+)/gmu,
    ),
  ].map((match) => ({ attribute: match[1], expression: match[2]!.trim() }));

  assert.deepEqual(roleAssignments, [
    {
      attribute: "execution_role_arn",
      expression: "aws_iam_role.task_execution.arn",
    },
    {
      attribute: "task_role_arn",
      expression: "aws_iam_role.runtime_task.arn",
    },
  ]);
  assert.notEqual(
    roleAssignments[0]!.expression,
    roleAssignments[1]!.expression,
  );
  for (const { expression } of roleAssignments) {
    assert.doesNotMatch(expression, /aws_iam_role\.(?:plan|deploy)|github/iu);
  }
}

function concatenateTerraformSources(sources: ReadonlyMap<string, string>) {
  return [...sources.values()].join("\n");
}

test("API 作成の Cognito client に既定 Managed Login branding を結び付ける", async () => {
  const sources = await readTerraformSources();
  const identitySource = sources.get(
    "infra/terraform/modules/identity/main.tf",
  );
  assert.ok(identitySource);
  const branding = extractSimpleResourceBlocks(
    identitySource,
    "aws_cognito_managed_login_branding",
  );
  assert.equal(branding.length, 1, "Managed Login branding が必要");
  assert.equal(
    readSimpleAttribute(branding[0]!.body, "user_pool_id"),
    "aws_cognito_user_pool.app.id",
  );
  assert.equal(
    readSimpleAttribute(branding[0]!.body, "client_id"),
    "aws_cognito_user_pool_client.app.id",
  );
  assert.equal(
    readSimpleAttribute(branding[0]!.body, "use_cognito_provided_values"),
    "true",
  );
});

test("deploy role は RDS 管理 secret の作成と Cognito branding の lifecycle を許可する", async () => {
  const source = maskHclCommentsAndHeredocs(
    concatenateTerraformSources(await readBootstrapTerraformSources()),
  );
  const deployPolicy = extractLocalJsonObject(
    source,
    "deploy_foundation_policy",
  );
  for (const action of [
    "secretsmanager:CreateSecret",
    "secretsmanager:TagResource",
    "kms:DescribeKey",
  ]) {
    assert.ok(
      deployPolicy.includes(`"${action}"`),
      `RDS 管理 secret に必要な ${action} が欠落`,
    );
  }
  for (const action of [
    "CreateManagedLoginBranding",
    "UpdateManagedLoginBranding",
    "DeleteManagedLoginBranding",
    "DescribeManagedLoginBranding",
    "DescribeManagedLoginBrandingByClient",
    "ListUserPoolClients",
  ]) {
    assert.ok(
      source.includes(`"cognito-idp:${action}"`),
      `branding lifecycle に必要な ${action} が欠落`,
    );
  }
  assert.doesNotMatch(
    deployPolicy,
    /"secretsmanager:(?:GetSecretValue|PutSecretValue|DeleteSecret)"/u,
  );
});

function prependToResourceBody(
  source: string,
  resourceType: string,
  resourceName: string,
  fragment: string,
) {
  const declaration = `resource "${resourceType}" "${resourceName}" {`;
  const declarationIndex = source.indexOf(declaration);
  assert.notEqual(
    declarationIndex,
    -1,
    `expected ${resourceType}.${resourceName}`,
  );
  const insertionIndex = declarationIndex + declaration.length;
  return `${source.slice(0, insertionIndex)}\n${fragment}${source.slice(insertionIndex)}`;
}

test("only the workload module owns ECS resources and secretless task configuration", async () => {
  const sources = await readTerraformSources();
  const source = [...sources.values()].join("\n");
  const workloadSource = sources.get(
    "infra/terraform/modules/workload/main.tf",
  );
  assert.notEqual(workloadSource, undefined);

  assertEcsResourceOwnership(sources);
  assertEcsServicePolicyDependencies(workloadSource!);

  const missingRuntimePolicyDependency = workloadSource!.replace(
    "    aws_iam_role_policy.runtime_task,\n",
    "",
  );
  assert.throws(
    () => assertEcsServicePolicyDependencies(missingRuntimePolicyDependency),
    /must wait for both task IAM policies/u,
  );

  const escapedEcsResource = new Map(sources);
  escapedEcsResource.set(
    "infra/terraform/modules/network/main.tf",
    `${escapedEcsResource.get("infra/terraform/modules/network/main.tf")}\nresource "aws_ecs_service" "bypass" {}\n`,
  );
  assert.throws(
    () => assertEcsResourceOwnership(escapedEcsResource),
    /must be declared by the workload module/u,
  );

  assert.doesNotMatch(source, /data\s+"aws_secretsmanager_secret_version"/u);
  assert.doesNotMatch(source, /output\s+"[^"]*password/iu);
  assert.doesNotMatch(
    source,
    /(?:name\s*=\s*"DATABASE_URL"|\bDATABASE_URL\s*=)/u,
  );
  assert.doesNotMatch(source, /dynamodb_table\s*=/u);
  const terraformArtifactPaths = listTrackedTerraformArtifactPaths();
  assertNoTerraformStateArtifacts(terraformArtifactPaths);
  assert.throws(
    () =>
      assertNoTerraformStateArtifacts([
        ...terraformArtifactPaths,
        "infra/terraform/modules/workload/ignored.tfstate.local",
      ]),
    /state or plan artifacts must not be tracked/u,
  );
});

test("ローカルの plan は許可し、Git に追加した plan は拒否する", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "terraform-plan-policy-"),
  );
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    await mkdir(path.join(directory, "infra/terraform"), { recursive: true });
    await writeFile(
      path.join(directory, "infra/terraform/plan.tfplan"),
      "synthetic plan\n",
    );
    assert.doesNotThrow(() =>
      assertNoTerraformStateArtifacts(
        listTrackedTerraformArtifactPaths(directory),
      ),
    );
    execFileSync("git", ["add", "infra/terraform/plan.tfplan"], {
      cwd: directory,
    });
    assert.throws(
      () =>
        assertNoTerraformStateArtifacts(
          listTrackedTerraformArtifactPaths(directory),
        ),
      /must not be tracked/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrap IAM rejects workload permission and role-separation bypasses", async () => {
  const sources = await readTerraformSources();
  const bootstrapSources = await readBootstrapTerraformSources();
  const bootstrapSource = concatenateTerraformSources(bootstrapSources);
  const workloadSource = sources.get(
    "infra/terraform/modules/workload/main.tf",
  );
  assert.notEqual(bootstrapSources.size, 0);
  assert.notEqual(workloadSource, undefined);

  assertExactBootstrapRoleAttachments(bootstrapSource);
  assertWorkloadPolicyActionsAreLiteralAndWildcardFree(bootstrapSource);
  assertTaskDefinitionUsesDedicatedWorkloadRoles(workloadSource!);

  const indirectAttachment = bootstrapSource.replace(
    "policy_arn = aws_iam_policy.workload_read[0].arn",
    "policy_arn = local.managed_read_policy_arn",
  );
  assert.throws(
    () => assertExactManagedPolicyAttachments(indirectAttachment),
    /Expected values to be strictly deep-equal/u,
  );

  const extraManagedSources = new Map(bootstrapSources);
  extraManagedSources.set(
    "infra/terraform/bootstrap/review-extra.tf",
    'resource "aws_iam_role_policy_attachment" "bypass" {\n  role       = aws_iam_role.plan.name\n  policy_arn = aws_iam_policy.workload_read.arn\n}\n',
  );
  assert.throws(
    () =>
      assertExactManagedPolicyAttachments(
        concatenateTerraformSources(extraManagedSources),
      ),
    /Expected values to be strictly deep-equal/u,
  );

  const planAdminSources = new Map(bootstrapSources);
  planAdminSources.set(
    "infra/terraform/bootstrap/review-plan-admin.tf",
    'resource "aws_iam_role_policy" "plan_admin" {\n  role   = aws_iam_role.plan.id\n  policy = local.mutation_alias\n}\n',
  );
  assert.throws(
    () =>
      assertExactInlinePolicyAttachments(
        concatenateTerraformSources(planAdminSources),
      ),
    /Expected values to be strictly deep-equal/u,
  );

  const misdirectedPlanState = bootstrapSource.replace(
    "role   = aws_iam_role.plan[0].id",
    "role   = aws_iam_role.deploy[0].id",
  );
  assert.notEqual(misdirectedPlanState, bootstrapSource);
  assert.throws(
    () => assertExactInlinePolicyAttachments(misdirectedPlanState),
    /Expected values to be strictly deep-equal/u,
  );

  const wildcardAction = bootstrapSource.replace(
    '"ecs:DescribeClusters"',
    '"ecs:Describe*"',
  );
  assert.notEqual(wildcardAction, bootstrapSource);
  assert.throws(
    () => assertWorkloadPolicyActionsAreLiteralAndWildcardFree(wildcardAction),
    /must be wildcard-free/u,
  );

  const indirectAction = bootstrapSource.replace(
    'Action   = ["ecs:ListTaskDefinitions"]',
    "Action   = local.some_actions",
  );
  assert.notEqual(indirectAction, bootstrapSource);
  assert.throws(
    () => assertWorkloadPolicyActionsAreLiteralAndWildcardFree(indirectAction),
    /literal string or list/u,
  );

  const githubExecutionRole = workloadSource!.replace(
    "execution_role_arn       = aws_iam_role.task_execution.arn",
    "execution_role_arn       = aws_iam_role.plan.arn",
  );
  assert.notEqual(githubExecutionRole, workloadSource);
  assert.throws(
    () => assertTaskDefinitionUsesDedicatedWorkloadRoles(githubExecutionRole),
    /Expected values to be strictly deep-equal/u,
  );

  const unrelatedReferences = `${bootstrapSource}\nlocals {\n  service_linked_role_policy_arn = "arn:aws:iam::aws:policy/aws-service-role/ExampleServiceRolePolicy"\n  intentional_transport_deny    = "s3:*"\n}\n`;
  assert.doesNotThrow(() =>
    assertExactManagedPolicyAttachments(unrelatedReferences),
  );

  const unrelatedComments = `${bootstrapSource}\n# aws_iam_policy_attachment, inline_policy, and managed_policy_arns are intentionally prohibited attachment mechanisms.\n`;
  assert.doesNotThrow(() =>
    assertExactBootstrapRoleAttachments(unrelatedComments),
  );
  const roleBodyComments = prependToResourceBody(
    bootstrapSource,
    "aws_iam_role",
    "plan",
    "  # inline_policy { policy = local.comment_only }\n  # managed_policy_arns = local.comment_only\n",
  );
  assert.doesNotThrow(() =>
    assertExactBootstrapRoleAttachments(roleBodyComments),
  );

  assert.doesNotMatch(bootstrapSource, /"s3:(?:Get|List)\*"/u);
});

test("bootstrap rejects alternate managed policy attachment resources", async () => {
  const bootstrapSources = await readBootstrapTerraformSources();
  bootstrapSources.set(
    "infra/terraform/bootstrap/review-policy-attachment.tf",
    'resource "aws_iam_policy_attachment" "plan_admin" {\n  name       = "hidden"\n  roles      = [local.plan_role_alias]\n  policy_arn = local.managed_policy_alias\n}\n',
  );

  assert.throws(
    () =>
      assertExactBootstrapRoleAttachments(
        concatenateTerraformSources(bootstrapSources),
      ),
    /alternate IAM attachment mechanism/u,
  );
});

test("bootstrap rejects exclusive managed policy attachment resources", async () => {
  const bootstrapSources = await readBootstrapTerraformSources();
  bootstrapSources.set(
    "infra/terraform/bootstrap/review-exclusive-managed.tf",
    'resource "aws_iam_role_policy_attachments_exclusive" "plan_admin" {\n  role_name   = local.plan_role_alias\n  policy_arns = [local.managed_policy_alias]\n}\n',
  );

  assert.throws(
    () =>
      assertExactBootstrapRoleAttachments(
        concatenateTerraformSources(bootstrapSources),
      ),
    /alternate IAM attachment mechanism/u,
  );
});

test("bootstrap rejects exclusive inline policy reconciliation resources", async () => {
  const bootstrapSources = await readBootstrapTerraformSources();
  bootstrapSources.set(
    "infra/terraform/bootstrap/review-exclusive-inline.tf",
    'resource "aws_iam_role_policies_exclusive" "plan_admin" {\n  role_name    = local.plan_role_alias\n  policy_names = [local.inline_policy_alias]\n}\n',
  );

  assert.throws(
    () =>
      assertExactBootstrapRoleAttachments(
        concatenateTerraformSources(bootstrapSources),
      ),
    /alternate IAM attachment mechanism/u,
  );
});

test("bootstrap rejects inline policies embedded in the plan role", async () => {
  const bootstrapSource = concatenateTerraformSources(
    await readBootstrapTerraformSources(),
  );
  const inlinePlanPolicy = prependToResourceBody(
    bootstrapSource,
    "aws_iam_role",
    "plan",
    '  inline_policy {\n    name   = "hidden"\n    policy = local.mutation_alias\n  }\n',
  );

  assert.throws(
    () => assertExactBootstrapRoleAttachments(inlinePlanPolicy),
    /alternate IAM attachment mechanism/u,
  );
});

test("bootstrap rejects managed policy ARNs embedded in the plan role", async () => {
  const bootstrapSource = concatenateTerraformSources(
    await readBootstrapTerraformSources(),
  );
  const managedPlanPolicy = prependToResourceBody(
    bootstrapSource,
    "aws_iam_role",
    "plan",
    "  managed_policy_arns = local.managed_policy_alias\n",
  );

  assert.throws(
    () => assertExactBootstrapRoleAttachments(managedPlanPolicy),
    /alternate IAM attachment mechanism/u,
  );
});

test("bootstrap rejects dynamic inline policies embedded in the plan role", async () => {
  const bootstrapSource = concatenateTerraformSources(
    await readBootstrapTerraformSources(),
  );
  const dynamicInlinePlanPolicy = prependToResourceBody(
    bootstrapSource,
    "aws_iam_role",
    "plan",
    '  dynamic "inline_policy" {\n    for_each = local.hidden_policies\n    content {\n      name   = each.key\n      policy = local.mutation_alias\n    }\n  }\n',
  );

  assert.throws(
    () => assertExactBootstrapRoleAttachments(dynamicInlinePlanPolicy),
    /alternate IAM attachment mechanism/u,
  );
});

test("bootstrap rejects inline policies hidden after heredoc braces", async () => {
  const bootstrapSource = concatenateTerraformSources(
    await readBootstrapTerraformSources(),
  );
  const heredocHiddenInlinePolicy = prependToResourceBody(
    bootstrapSource,
    "aws_iam_role",
    "plan",
    '  description = <<-ROLE_DETAILS\n    A closing brace in prose must not end the role scan.\n    }\n  ROLE_DETAILS\n  inline_policy {\n    name   = "hidden"\n    policy = local.mutation_alias\n  }\n',
  );

  assert.throws(
    () => assertExactBootstrapRoleAttachments(heredocHiddenInlinePolicy),
    /alternate IAM attachment mechanism/u,
  );
});

test("bootstrap ignores HCL-looking heredoc content during attachment audit", async () => {
  const bootstrapSource = concatenateTerraformSources(
    await readBootstrapTerraformSources(),
  );
  const harmlessHeredoc = prependToResourceBody(
    bootstrapSource,
    "aws_iam_role",
    "plan",
    '  description = <<AUDIT_NOTES_2\nresource "aws_iam_policy_attachment" "documentation" {\n  inline_policy {\n  managed_policy_arns = local.documentation\n}\nAUDIT_NOTES_2\n',
  );

  assert.doesNotThrow(() =>
    assertExactBootstrapRoleAttachments(harmlessHeredoc),
  );
});

test("bootstrap ignores managed attachment examples inside heredocs", async () => {
  const bootstrapSource = concatenateTerraformSources(
    await readBootstrapTerraformSources(),
  );
  const harmlessManagedAttachmentExample = prependToResourceBody(
    bootstrapSource,
    "aws_iam_role",
    "plan",
    '  description = <<MANAGED_ATTACHMENT_EXAMPLE\nresource "aws_iam_role_policy_attachment" "documentation" {\n  role       = aws_iam_role.plan.name\n  policy_arn = aws_iam_policy.workload_read.arn\n}\nMANAGED_ATTACHMENT_EXAMPLE\n',
  );

  assert.doesNotThrow(() =>
    assertExactBootstrapRoleAttachments(harmlessManagedAttachmentExample),
  );
});

test("bootstrap attachment audit includes git-ignored direct Terraform sources", async () => {
  const fixtureDirectory = await mkdtemp(
    path.join(tmpdir(), "terraform-source-fixture-"),
  );

  try {
    execFileSync("git", ["init", "-q"], { cwd: fixtureDirectory });
    await Promise.all([
      writeFile(path.join(fixtureDirectory, ".gitignore"), "ignored.tf\n"),
      writeFile(
        path.join(fixtureDirectory, "ignored.tf"),
        'resource "aws_iam_policy_attachment" "ignored_bypass" {\n  name       = "hidden"\n  roles      = [local.plan_role_alias]\n  policy_arn = local.managed_policy_alias\n}\n',
      ),
      writeFile(
        path.join(fixtureDirectory, "visible.tf"),
        'locals { visible_fixture = "included" }\n',
      ),
    ]);

    assert.equal(
      execFileSync("git", ["check-ignore", "ignored.tf"], {
        cwd: fixtureDirectory,
        encoding: "utf8",
      }),
      "ignored.tf\n",
    );

    const sources = await readDirectTerraformSources(fixtureDirectory);
    assert.deepEqual([...sources.keys()], ["ignored.tf", "visible.tf"]);

    const auditedSources =
      await readBootstrapTerraformSources(fixtureDirectory);
    assert.throws(
      () =>
        assertExactBootstrapRoleAttachments(
          concatenateTerraformSources(auditedSources),
        ),
      /alternate IAM attachment mechanism/u,
    );
  } finally {
    await rm(fixtureDirectory, { force: true, recursive: true });
  }
});

test("the dev root composes exactly the six local foundation and workload modules", async () => {
  const sources = await readTerraformSources();
  const source = [...sources.values()].join("\n");
  const moduleSources = [
    ...source.matchAll(
      /module\s+"[^"]+"\s*\{[\s\S]*?source\s*=\s*"([^"]+)"[\s\S]*?\}/gu,
    ),
  ].map((match) => match[1]);

  for (const moduleSource of moduleSources) {
    assert.match(moduleSource!, /^\.\.\/\.\.\/modules\/[a-z0-9_-]+$/u);
  }

  assert.deepEqual(moduleSources.sort(), [
    "../../modules/data",
    "../../modules/edge",
    "../../modules/identity",
    "../../modules/ingress",
    "../../modules/network",
    "../../modules/workload",
  ]);
});

test("the dev root wires the workload only from explicit release inputs and sibling outputs", async () => {
  const sources = await readTerraformSources();
  const devMain = sources.get("infra/terraform/environments/dev/main.tf");
  assert.notEqual(devMain, undefined);
  const workload = extractSimpleModuleBlock(devMain!, "workload");

  assert.deepEqual(
    Object.fromEntries(
      [
        "source",
        "project",
        "environment",
        "aws_region",
        "private_app_subnet_ids",
        "task_security_group_id",
        "target_group_arn",
        "app_port",
        "api_image",
        "api_repository_arn",
        "adot_image",
        "database_endpoint",
        "database_port",
        "database_name",
        "database_secret_arn",
        "app_origin",
        "oidc_issuer",
        "oidc_client_id",
        "oidc_logout_endpoint",
        "task_cpu",
        "task_memory",
        "depends_on",
      ].map((attribute) => [
        attribute,
        readSimpleAttribute(workload, attribute),
      ]),
    ),
    {
      source: '"../../modules/workload"',
      project: "var.project",
      environment: "var.environment",
      aws_region: "var.aws_region",
      private_app_subnet_ids: "module.network.private_app_subnet_ids",
      task_security_group_id: "module.network.task_security_group_id",
      target_group_arn: "module.ingress.target_group_arn",
      app_port: "var.app_port",
      api_image: "var.api_image",
      api_repository_arn: "var.api_repository_arn",
      adot_image: "var.adot_image",
      database_endpoint: "module.data.database_endpoint",
      database_port: "module.data.database_port",
      database_name: "module.data.database_name",
      database_secret_arn: "module.data.database_secret_arn",
      app_origin: "module.edge.app_origin",
      oidc_issuer: "module.identity.oidc_issuer",
      oidc_client_id: "module.identity.oidc_client_id",
      oidc_logout_endpoint: "module.identity.oidc_logout_endpoint",
      task_cpu: "var.task_cpu",
      task_memory: "var.task_memory",
      depends_on: "[module.ingress]",
    },
  );
});

test("the dev root exposes only the native-lock S3 and delivery-slice contracts", async () => {
  const sources = await readTerraformSources();
  const devSource = [...sources]
    .filter(([relativePath]) => relativePath.startsWith(`${devRoot}/`))
    .map(([, source]) => source)
    .join("\n");
  const backendTypes = [...devSource.matchAll(/backend\s+"([^"]+)"/gu)].map(
    (match) => match[1],
  );
  const outputNames = [...devSource.matchAll(/output\s+"([^"]+)"\s*\{/gu)].map(
    (match) => match[1],
  );

  assert.deepEqual(backendTypes, ["s3"]);
  assert.match(devSource, /encrypt\s*=\s*true/u);
  assert.match(devSource, /use_lockfile\s*=\s*true/u);
  assert.deepEqual(outputNames.sort(), [
    "adot_log_group_name",
    "alb_dns_name",
    "api_log_group_name",
    "app_origin",
    "cluster_arn",
    "cluster_name",
    "database_endpoint",
    "database_name",
    "database_port",
    "database_secret_arn",
    "distribution_id",
    "migration_log_group_name",
    "oidc_authorization_endpoint",
    "oidc_client_id",
    "oidc_issuer",
    "oidc_logout_endpoint",
    "private_app_subnet_ids",
    "runtime_task_role_arn",
    "service_arn",
    "service_name",
    "target_group_arn",
    "task_definition_arn",
    "task_execution_role_arn",
    "task_security_group_id",
    "vpc_id",
    "web_bucket_name",
  ]);

  const secretOutput = devSource.match(
    /output\s+"database_secret_arn"\s*\{([\s\S]*?)\}/u,
  );
  assert.notEqual(secretOutput, null);
  assert.match(secretOutput![1]!, /sensitive\s*=\s*true/u);
});

test("GitHub OIDC role resources are gated by the role flags", async () => {
  const source = concatenateTerraformSources(
    await readBootstrapTerraformSources(),
  );
  const planCount = "var.create_github_plan_role ? 1 : 0";
  const deployCount = "var.create_github_deploy_role ? 1 : 0";
  const sharedCount = "local.create_github_roles ? 1 : 0";
  const expected: Record<string, Record<string, string>> = {
    aws_iam_role: { plan: planCount, deploy: deployCount },
    aws_iam_role_policy_attachment: {
      plan_foundation_read: planCount,
      plan_workload_read: planCount,
      deploy_foundation_read: deployCount,
      deploy_workload_read: deployCount,
      deploy_foundation_network: deployCount,
      deploy_foundation_services: deployCount,
    },
    aws_iam_role_policy: {
      plan_state: planCount,
      deploy_state: deployCount,
      deploy_foundation: deployCount,
      deploy_workload: deployCount,
    },
    aws_iam_policy: {
      foundation_read: sharedCount,
      workload_read: sharedCount,
      deploy_foundation_network: deployCount,
      deploy_foundation_services: deployCount,
    },
    aws_iam_openid_connect_provider: {
      github:
        "var.create_github_oidc_provider && local.create_github_roles ? 1 : 0",
    },
  };
  for (const [resourceType, counts] of Object.entries(expected)) {
    const actual: Record<string, string | undefined> = {};
    for (const { body, name } of extractSimpleResourceBlocks(
      source,
      resourceType,
    )) {
      actual[name ?? ""] = readSimpleAttribute(body, "count");
    }
    assert.deepEqual(actual, counts, `${resourceType} の count`);
  }
});
