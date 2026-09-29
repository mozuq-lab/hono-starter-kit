import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const maximumDiagnosticLength = 8_000;
const credentialEnvironmentPattern =
  /^AWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|SECURITY_TOKEN|PROFILE|DEFAULT_PROFILE|SHARED_CREDENTIALS_FILE|CONFIG_FILE|SDK_LOAD_CONFIG|WEB_IDENTITY_TOKEN_FILE|ROLE_ARN|ROLE_SESSION_NAME|CONTAINER_CREDENTIALS_.+|CREDENTIAL_.+)$/u;

// `terraform test -json` が 1 行ずつ出すイベントのうち、この検査が読む部分。
type TerraformTestEvent = {
  type?: unknown;
  test_plan?: unknown;
  test_summary?: unknown;
  "@testrun"?: unknown;
};

// 計画 JSON のうち、この検査が歩く部分。after と after_unknown はリソースごとに形が
// 違うので unknown のまま持ち、readPath で辿ってから表明する。
type PlannedResource = {
  address: string;
  change: { actions: unknown; after: unknown; after_unknown: unknown };
};
type RootPlan = { resource_changes: PlannedResource[] };

// タスク定義の container_definitions は JSON 文字列として計画に載る。
type TaskContainer = {
  name: string;
  image: string;
  environment: { name: string; value: string }[];
  secrets: { name: string; valueFrom: string }[];
};

const appendDiagnostic = (current: string, chunk: string) =>
  `${current}${chunk}`.slice(-maximumDiagnosticLength);

const makeTerraformEnvironment = () => {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (credentialEnvironmentPattern.test(name)) delete environment[name];
  }
  delete environment.STARTER_TERRAFORM_TEST;
  delete environment.STARTER_TERRAFORM_TEST_PROJECT_NAME;
  environment.AWS_EC2_METADATA_DISABLED = "true";
  return environment;
};

const runDevRootPlan = (signal: AbortSignal) =>
  new Promise<RootPlan>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["terraform", "--", "--root", "dev", "test", "-json", "-verbose"],
      {
        cwd: repositoryRoot,
        env: makeTerraformEnvironment(),
        shell: false,
        signal,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let bufferedStdout = "";
    let diagnostic = "";
    const plans: { plan: unknown; run: unknown }[] = [];
    const summaries: unknown[] = [];
    let invalidJson: unknown;
    let settled = false;

    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      complete();
    };

    const consumeLine = (line: string) => {
      if (!line.startsWith("{")) {
        diagnostic = appendDiagnostic(diagnostic, `${line}\n`);
        return;
      }

      let event: TerraformTestEvent;
      try {
        event = JSON.parse(line) as TerraformTestEvent;
      } catch (error) {
        invalidJson ??= error;
        diagnostic = appendDiagnostic(diagnostic, `${line}\n`);
        return;
      }
      if (event.type === "test_plan") {
        plans.push({ plan: event.test_plan, run: event["@testrun"] });
      }
      if (event.type === "test_summary") summaries.push(event.test_summary);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bufferedStdout += chunk;
      let newlineIndex = bufferedStdout.indexOf("\n");
      while (newlineIndex !== -1) {
        consumeLine(bufferedStdout.slice(0, newlineIndex));
        bufferedStdout = bufferedStdout.slice(newlineIndex + 1);
        newlineIndex = bufferedStdout.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      diagnostic = appendDiagnostic(diagnostic, chunk);
    });

    child.once("error", (error) => settle(() => reject(error)));
    child.once("close", (exitCode, signal) => {
      if (bufferedStdout.length > 0) consumeLine(bufferedStdout);
      if (exitCode !== 0 || signal !== null) {
        settle(() =>
          reject(
            new Error(
              `Terraform root plan failed with ${
                signal === null ? `exit code ${exitCode}` : `signal ${signal}`
              }.\n${diagnostic}`,
            ),
          ),
        );
        return;
      }
      if (invalidJson !== undefined) {
        settle(() =>
          reject(
            new Error(
              `Terraform emitted an invalid JSON event.\n${diagnostic}`,
            ),
          ),
        );
        return;
      }
      try {
        assert.equal(
          summaries.length,
          1,
          "expected exactly one Terraform test summary",
        );
        const summary = summaries[0] as Record<string, unknown>;
        assert.equal(summary.status, "pass");
        assert.equal(summary.failed, 0);
        assert.equal(summary.errored, 0);
        assert.equal(summary.skipped, 0);
        const defaultPlan = plans.filter(
          ({ run }) => run === "default_dev_foundation_contract",
        );
        assert.equal(
          defaultPlan.length,
          1,
          "expected one default dev foundation test plan",
        );
        // 上で 1 件だけであることを表明済み。中身は下の resource_changes の検査が確かめる。
        const plan = defaultPlan[0]!.plan as RootPlan;
        assert.ok(Array.isArray(plan.resource_changes));
        settle(() => resolve(plan));
        return;
      } catch (error) {
        // 表明の失敗をそのまま伝える。ここで包み直すと、どの表明が落ちたのかが
        // 呼び出し側のレポートから消える。
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        settle(() => reject(error));
        return;
      }
    });
  });

const findPlannedResource = (plan: RootPlan, address: string) => {
  const matches = plan.resource_changes.filter(
    (resource) => resource.address === address,
  );
  assert.equal(
    matches.length,
    1,
    `expected one planned resource at ${address}`,
  );
  const [resource] = matches as [PlannedResource];
  assert.deepEqual(resource.change.actions, ["create"]);
  assert.notEqual(
    resource.change.after,
    null,
    `${address} must have after data`,
  );
  return resource;
};

// 計画の値は表明する場所で初めて形が分かる。並べ替えたい場面は配列であることが
// 前提なので、その前提をここで一度だけ書く。
const sorted = (values: unknown) => [...(values as readonly unknown[])].sort();

const readPath = (
  value: unknown,
  path: readonly (string | number)[],
): unknown =>
  path.reduce<unknown>(
    (current, segment) =>
      current === undefined || current === null
        ? undefined
        : (current as Record<string | number, unknown>)[segment],
    value,
  );

const assertNotUnknown = (unknown: unknown, label: string) => {
  if (unknown === undefined || unknown === false) return;
  if (Array.isArray(unknown)) {
    for (const value of unknown) assertNotUnknown(value, label);
    return;
  }
  if (unknown !== null && typeof unknown === "object") {
    for (const value of Object.values(unknown)) assertNotUnknown(value, label);
    return;
  }
  assert.fail(`${label} must be known in the root plan`);
};

const plannedValue = (
  resource: PlannedResource,
  path: readonly (string | number)[],
) => {
  const label = `${resource.address}.${path.join(".")}`;
  const value = readPath(resource.change.after, path);
  assert.notEqual(value, undefined, `${label} must exist in the root plan`);
  assertNotUnknown(readPath(resource.change.after_unknown, path), label);
  return value;
};

const taskDefinitionContainer = (
  taskDefinition: PlannedResource,
  name: string,
) => {
  const containers = JSON.parse(
    plannedValue(taskDefinition, ["container_definitions"]) as string,
  ) as TaskContainer[];
  const matches = containers.filter((container) => container.name === name);
  assert.equal(matches.length, 1, `expected one ${name} task container`);
  return matches[0]!;
};

const taskContainerEnvironmentValue = (
  container: TaskContainer,
  name: string,
) => {
  const matches = container.environment.filter((entry) => entry.name === name);
  assert.equal(
    matches.length,
    1,
    `expected one ${name} environment value in ${container.name}`,
  );
  return matches[0]!.value;
};

test(
  "the dev root plan preserves every foundation dependency edge",
  { timeout: 120_000 },
  async (context) => {
    const plan = await runDevRootPlan(context.signal);

    const databaseSubnetGroup = findPlannedResource(
      plan,
      "module.data.aws_db_subnet_group.postgres",
    );
    const database = findPlannedResource(
      plan,
      "module.data.aws_db_instance.postgres",
    );
    assert.deepEqual(
      sorted(plannedValue(databaseSubnetGroup, ["subnet_ids"])),
      ["subnet-db-a", "subnet-db-c"],
    );
    assert.deepEqual(plannedValue(database, ["vpc_security_group_ids"]), [
      "sg-rds",
    ]);

    const loadBalancer = findPlannedResource(plan, "module.ingress.aws_lb.api");
    const targetGroup = findPlannedResource(
      plan,
      "module.ingress.aws_lb_target_group.api",
    );
    assert.deepEqual(sorted(plannedValue(loadBalancer, ["subnets"])), [
      "subnet-app-a",
      "subnet-app-c",
    ]);
    assert.deepEqual(plannedValue(loadBalancer, ["security_groups"]), [
      "sg-alb",
    ]);
    assert.equal(plannedValue(targetGroup, ["vpc_id"]), "vpc-dev");
    assert.equal(plannedValue(targetGroup, ["port"]), 3000);

    const vpcOrigin = findPlannedResource(
      plan,
      "module.edge.aws_cloudfront_vpc_origin.api",
    );
    const distribution = findPlannedResource(
      plan,
      "module.edge.aws_cloudfront_distribution.app",
    );
    assert.equal(
      plannedValue(vpcOrigin, ["vpc_origin_endpoint_config", 0, "arn"]),
      "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:loadbalancer/app/dev/1",
    );
    const origins = readPath(distribution.change.after, ["origin"]);
    assert.ok(Array.isArray(origins));
    const originIds = origins.map((_, index) =>
      plannedValue(distribution, ["origin", index, "origin_id"]),
    );
    const apiOriginIndex = originIds.indexOf("api");
    assert.equal(originIds.filter((originId) => originId === "api").length, 1);
    assert.equal(
      plannedValue(distribution, ["origin", apiOriginIndex, "domain_name"]),
      "internal-dev.ap-northeast-1.elb.amazonaws.com",
    );

    const oidcClient = findPlannedResource(
      plan,
      "module.identity.aws_cognito_user_pool_client.app",
    );
    assert.deepEqual(plannedValue(oidcClient, ["callback_urls"]), [
      "https://d111111abcdef8.cloudfront.net/auth/callback",
    ]);
    assert.deepEqual(plannedValue(oidcClient, ["logout_urls"]), [
      "https://d111111abcdef8.cloudfront.net/login",
    ]);

    const service = findPlannedResource(
      plan,
      "module.workload.aws_ecs_service.app",
    );
    assert.deepEqual(
      sorted(plannedValue(service, ["network_configuration", 0, "subnets"])),
      ["subnet-app-a", "subnet-app-c"],
    );
    assert.deepEqual(
      plannedValue(service, ["network_configuration", 0, "security_groups"]),
      ["sg-task"],
    );
    assert.equal(
      plannedValue(service, ["network_configuration", 0, "assign_public_ip"]),
      false,
    );
    assert.equal(
      plannedValue(service, ["load_balancer", 0, "target_group_arn"]),
      "arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:targetgroup/dev/1",
    );

    const taskDefinition = findPlannedResource(
      plan,
      "module.workload.aws_ecs_task_definition.app",
    );
    assert.equal(plannedValue(taskDefinition, ["cpu"]), "512");
    assert.equal(plannedValue(taskDefinition, ["memory"]), "1024");
    const api = taskDefinitionContainer(taskDefinition, "api");
    const adot = taskDefinitionContainer(taskDefinition, "adot");
    assert.equal(
      api.image,
      "123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/hono-starter-kit-dev-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.equal(
      adot.image,
      "public.ecr.aws/aws-observability/aws-otel-collector@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    assert.equal(
      taskContainerEnvironmentValue(api, "PGHOST"),
      "starter.cluster-example.ap-northeast-1.rds.amazonaws.com",
    );
    assert.equal(taskContainerEnvironmentValue(api, "PGPORT"), "5432");
    assert.equal(taskContainerEnvironmentValue(api, "PGDATABASE"), "starter");
    assert.equal(
      taskContainerEnvironmentValue(api, "PGPASSWORD_SECRET_ARN"),
      "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:rds-dev",
    );
    assert.equal(
      taskContainerEnvironmentValue(api, "AWS_REGION"),
      "ap-northeast-1",
    );
    assert.equal(
      api.secrets.some((secret) => secret.name === "PGPASSWORD"),
      false,
    );
    assert.deepEqual(api.secrets, [
      {
        name: "PGUSER",
        valueFrom:
          "arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:rds-dev:username::",
      },
    ]);
    assert.equal(
      taskContainerEnvironmentValue(api, "APP_ORIGIN"),
      "https://d111111abcdef8.cloudfront.net",
    );
    assert.equal(
      taskContainerEnvironmentValue(api, "OIDC_ISSUER"),
      "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_example",
    );
    assert.equal(
      taskContainerEnvironmentValue(api, "OIDC_CLIENT_ID"),
      "oidc-client-dev",
    );
    assert.equal(
      taskContainerEnvironmentValue(api, "OIDC_LOGOUT_ENDPOINT"),
      "https://hono-starter-kit-dev-example.auth.ap-northeast-1.amazoncognito.com/logout",
    );
  },
);
