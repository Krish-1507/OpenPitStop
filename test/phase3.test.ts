import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeInfrastructure } from "../src/security/infrastructure.js";
import { analyzeAdvancedSecurity } from "../src/security/advanced.js";
import { analyzeSecurity } from "../src/analyzers/security.js";
import { assessRisk } from "../src/security/risk.js";
import { analyzeDependencyHygiene } from "../src/security/dependencies.js";
import type { ScanIssue } from "../src/analyzers/types.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(repo: string, file: string, content: string): void {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function categories(repo: string): Set<string> {
  return new Set(analyzeInfrastructure(repo).map((issue) => issue.category ?? ""));
}

test("infrastructure: Docker and Compose risks are line-anchored", () => {
  const repo = tempDir("pitstop-phase3-docker-");
  try {
    write(repo, "Dockerfile", [
      "FROM node:latest",
      "USER root",
      "ENV DB_PASSWORD=supersecret",
      "EXPOSE 5432",
      "ADD https://example.com/tool.tgz /tmp/tool.tgz",
    ].join("\n"));
    write(repo, "docker-compose.yml", [
      "services:",
      "  db:",
      "    image: postgres:latest",
      "    privileged: true",
      "    network_mode: host",
      "    user: root",
      "    volumes:",
      "      - /var/run/docker.sock:/var/run/docker.sock",
      "    ports:",
      "      - \"5432:5432\"",
    ].join("\n"));
    const found = categories(repo);
    for (const category of [
      "container-base-latest", "container-root-user", "container-secret-env",
      "container-exposed-sensitive-port", "container-remote-add",
      "container-privileged", "container-host-network", "container-docker-socket",
      "container-published-data-port",
    ]) {
      assert.ok(found.has(category), `${category} missing: ${[...found].join(", ")}`);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("infrastructure: Kubernetes, Terraform, CI, SQL and config findings", () => {
  const repo = tempDir("pitstop-phase3-infra-");
  try {
    write(repo, "k8s/deploy.yaml", [
      "apiVersion: apps/v1",
      "kind: Deployment",
      "spec:",
      "  template:",
      "    spec:",
      "      containers:",
      "        - image: app:latest",
      "          securityContext:",
      "            privileged: true",
      "            allowPrivilegeEscalation: true",
      "            runAsUser: 0",
      "      volumes:",
      "        - hostPath:",
      "            path: /var/run",
      "          env:",
      "            DB_PASSWORD: supersecret",
    ].join("\n"));
    write(repo, "infra/main.tf", [
      'resource "aws_s3_bucket" "public" {',
      '  acl = "public-read"',
      "}",
      'resource "aws_db_instance" "db" {',
      "  publicly_accessible = true",
      "  encrypted = false",
      "}",
      'resource "aws_security_group_rule" "ssh" {',
      '  cidr_blocks = ["0.0.0.0/0"]',
      "  from_port = 22",
      "}",
      'resource "aws_iam_policy" "wide" {',
      '  policy = jsonencode({ Action = "*" })',
      "}",
    ].join("\n"));
    write(repo, ".github/workflows/ci.yml", [
      "on: pull_request_target",
      "permissions: write-all",
      "jobs:",
      "  test:",
      "    steps:",
      "      - uses: actions/checkout@main",
      '      - run: echo "${{ github.event.pull_request.title }}"',
      '      - run: echo "${{ secrets.TOKEN }}"',
    ].join("\n"));
    write(repo, "db/init.sql", "GRANT ALL ON users TO app;\nCREATE USER app PASSWORD 'literal';\n");
    write(repo, "config/prod.yaml", "password: supersecret\n");
    write(repo, "config/example.yaml", "password: ${DB_PASSWORD}\npassword_example: changeme\n");

    const found = categories(repo);
    for (const category of [
      "kubernetes-privileged", "kubernetes-host-path", "kubernetes-root-user",
      "kubernetes-privilege-escalation", "kubernetes-unpinned-image", "kubernetes-literal-secret",
      "terraform-public-acl", "terraform-publicly-accessible", "terraform-open-ingress",
      "terraform-unencrypted", "terraform-wildcard-action",
      "ci-write-all", "ci-pull-request-target", "ci-untrusted-interpolation",
      "ci-secret-echo", "ci-unpinned-action", "sql-grant-all", "sql-literal-password",
      "config-literal-secret",
    ]) {
      assert.ok(found.has(category), `${category} missing: ${[...found].join(", ")}`);
    }
    const secrets = analyzeInfrastructure(repo).filter((issue) => issue.category === "config-literal-secret");
    assert.equal(secrets.length, 1, "placeholders and environment-expanded values are not secrets");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("dependency hygiene: floating, insecure, unpinned and unlocked dependencies", () => {
  const repo = tempDir("pitstop-phase3-deps-");
  try {
    write(repo, "package.json", JSON.stringify({
      name: "deps",
      dependencies: {
        floating: "*",
        insecure: "http://example.com/pkg.tgz",
        unpinned: "github:user/repo#main",
      },
    }, null, 2));
    const categories = analyzeDependencyHygiene(repo).map((issue) => issue.category);
    for (const category of ["dependency-floating-version", "dependency-insecure-source", "dependency-unpinned-git", "dependency-lockfile-missing"]) {
      assert.ok(categories.includes(category), `${category} missing: ${categories.join(", ")}`);
    }

    write(repo, "package-lock.json", "{}\n");
    write(repo, "package.json", JSON.stringify({ name: "deps", dependencies: { pinned: "^1.2.3" } }, null, 2));
    assert.deepEqual(analyzeDependencyHygiene(repo), []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("advanced security: IDOR, price tampering and JWT are surfaced by scan", async () => {
  const repo = tempDir("pitstop-phase3-advanced-");
  try {
    write(repo, "server.js", [
      "const express = require('express');",
      "const jwt = require('jsonwebtoken');",
      "const app = express();",
      "app.get('/api/orders/:id', (req, res) => {",
      "  const row = db.findById(req.params.id);",
      "  res.json(row);",
      "});",
      "app.post('/api/checkout', (req, res) => {",
      "  const amount = req.body.amount;",
      "  order.total = amount;",
      "  res.json(order);",
      "});",
      "jwt.verify(token, 'short');",
    ].join("\n"));
    const advanced = analyzeAdvancedSecurity(repo).map((issue) => issue.category);
    assert.ok(advanced.includes("idor"), advanced.join(", "));
    assert.ok(advanced.includes("price-tampering"), advanced.join(", "));
    assert.ok(advanced.includes("jwt-weak-secret"), advanced.join(", "));

    const result = await analyzeSecurity(repo);
    const securityCategories = result.issues.map((issue) => issue.category ?? issue.type);
    assert.ok(securityCategories.includes("idor"));
    assert.ok(securityCategories.includes("price-tampering"));
    const reachable = result.issues.find((issue) => issue.category === "idor");
    assert.equal(reachable?.reachability, "reachable");
    assert.ok(reachable?.risk);
    assert.ok(reachable!.risk!.score >= 70);
    assert.ok(reachable!.risk!.reasons.some((reason) => reason.includes("HTTP route")));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("risk: severity, confidence and route context produce deterministic triage", () => {
  const repo = tempDir("pitstop-phase3-risk-");
  try {
    const issues: ScanIssue[] = [
      { type: "code", category: "sql-injection", severity: "critical", confidence: "indicated" as const, description: "sql", file: "src/db.js", line: 1 },
      { type: "code", category: "unused-export", severity: "low", confidence: "heuristic" as const, description: "unused", file: "src/util.js", line: 1 },
      { type: "code", category: "authentication", severity: "medium", confidence: "indicated" as const, description: "auth", file: undefined, line: undefined },
    ];
    assessRisk(repo, issues);
    assert.equal(issues[0].reachability, "unknown", "no route inventory means no reachability claim");
    assert.equal(issues[0].risk?.level, "critical");
    assert.ok((issues[0].risk?.score ?? 0) > (issues[2].risk?.score ?? 0));
    assert.equal(issues[1].risk?.level, "info");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
