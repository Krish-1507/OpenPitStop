import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectLanguage } from "../src/analyzers/util.js";
import { LANGUAGE_ADAPTERS, adapterFor } from "../src/languages/adapters.js";
import { analyzeLanguages } from "../src/languages/index.js";
import { buildAttackSurface } from "../src/languages/map.js";
import { treeSitterUsableFor } from "../src/languages/parsers/treeSitter.js";
import { renderLanguageAnalysis } from "../src/commands/languages.js";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(repo: string, file: string, content: string): void {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

test("language adapters: requested families have markers or source evidence", () => {
  const ids = new Set<string>(LANGUAGE_ADAPTERS.map((adapter) => adapter.id));
  for (const id of ["js", "python", "java", "go", "dotnet", "php", "ruby", "c", "cpp", "rust", "kotlin", "swift", "dart"]) {
    assert.ok(ids.has(id), `${id} adapter missing`);
  }
  assert.equal(adapterFor("dotnet")?.displayName, "C# / .NET");
  assert.equal(adapterFor("js")?.analysis.staticSecurity, true);
  assert.equal(adapterFor("go")?.analysis.dependencyGraph, false);
  assert.ok(adapterFor("cpp")?.extensions.includes(".hpp"));
});

test("language detection: manifests and source-only repositories", () => {
  const fixtures: Array<[string, string, string]> = [
    ["js", "package.json", "{\"name\":\"x\"}"],
    ["python", "requirements.txt", "flask\n"],
    ["go", "go.mod", "module x\n"],
    ["java", "pom.xml", "<project/>\n"],
    ["php", "composer.json", "{}"],
    ["ruby", "Gemfile", "source 'https://rubygems.org'\n"],
    ["rust", "Cargo.toml", "[package]\nname='x'\n"],
    ["kotlin", "src/main/kotlin/Main.kt", "fun main() {}\n"],
    ["swift", "Package.swift", "// swift-tools-version:5.9\n"],
    ["dart", "pubspec.yaml", "name: x\n"],
    ["cpp", "src/main.cpp", "int main(){return 0;}\n"],
    ["c", "src/main.c", "int main(void){return 0;}\n"],
  ];
  const repos = fixtures.map(([language, file, content]) => {
    const repo = tempDir(`pitstop-lang-${language}-`);
    write(repo, file, content);
    return { language, repo };
  });
  try {
    for (const { language, repo } of repos) assert.equal(detectLanguage(repo), language);
    const ambiguous = tempDir("pitstop-lang-header-");
    try {
      write(ambiguous, "src/header.h", "int f(void);\n");
      assert.equal(detectLanguage(ambiguous), "unknown", ".h alone cannot claim C or C++");
    } finally {
      fs.rmSync(ambiguous, { recursive: true, force: true });
    }
  } finally {
    for (const { repo } of repos) fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("language analysis: Babel structure, routes, support level and entry points", async () => {
  const repo = tempDir("pitstop-lang-js-analysis-");
  try {
    write(repo, "package.json", JSON.stringify({
      name: "demo",
      scripts: { test: "node --test", build: "tsc" },
      dependencies: { express: "^4.0.0" },
      main: "src/server.js",
    }));
    write(repo, "src/server.js", [
      "const express = require('express');",
      "const app = express();",
      "export function greet(name) { return 'hi ' + name; }",
      "app.get('/users', (req, res) => res.json([]));",
      "app.get('/admin/users', (req, res) => res.json([]));",
    ].join("\n"));
    write(repo, "src/auth.js", "export function login() { return true; }\n");
    write(repo, "src/db.js", "export function query() { return []; }\n");

    const analysis = await analyzeLanguages(repo);
    const support = analysis.support.find((item) => item.id === "js");
    assert.ok(support);
    assert.equal(support.level, "analyzed");
    assert.equal(support.parser.status, "available");
    assert.equal(support.parser.backend, "babel");
    assert.equal(support.verification.status, "unproven");
    assert.ok(support.tests.includes("npm test"));
    assert.ok(support.build.includes("npm run build"));
    assert.ok(support.frameworks.includes("Express"));
    assert.ok(support.entryPoints.includes("src/server.js"));

    const server = analysis.files.find((file) => file.file === "src/server.js");
    assert.ok(server);
    assert.equal(server.status, "parsed");
    assert.ok(server.symbols.some((symbol) => symbol.name === "greet"));
    assert.ok(server.routes.some((route) => route.method === "GET" && route.path === "/users"));
    assert.equal(analysis.limits.skippedFiles, 0);
    assert.equal(fs.existsSync(path.join(repo, ".pitstop")), false, "language analysis is read-only");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("language analysis: no tree-sitter grammar means heuristic, never parsed", async () => {
  const repo = tempDir("pitstop-lang-go-analysis-");
  try {
    write(repo, "go.mod", "module example.com/demo\n\ngo 1.22\n");
    write(repo, "main.go", "package main\n\nfunc main() {}\n\nfunc helper() {}\n");
    const analysis = await analyzeLanguages(repo);
    const support = analysis.support.find((item) => item.id === "go");
    assert.ok(support);
    const grammarInstalled = treeSitterUsableFor("go");
    if (grammarInstalled) {
      assert.equal(support.parser.status, "available");
      assert.equal(support.level, "analyzed");
    } else {
      assert.equal(support.parser.status, "not-run");
      assert.equal(support.level, "detected");
      assert.match(support.analysis.note, /heuristic/);
      const file = analysis.files.find((entry) => entry.file === "main.go");
      assert.equal(file?.status, "heuristic");
      assert.ok(file?.symbols.some((symbol) => symbol.name === "helper"));
    }
    assert.equal(support.verification.status, "unproven");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("language analysis: Python AST is used when a real interpreter exists", async () => {
  const repo = tempDir("pitstop-lang-py-analysis-");
  try {
    write(repo, "pyproject.toml", "[project]\nname='demo'\ndependencies=['flask']\n");
    write(repo, "app.py", [
      "from flask import Flask",
      "app = Flask(__name__)",
      "@app.get('/users')",
      "def users():",
      "    return []",
    ].join("\n"));
    const analysis = await analyzeLanguages(repo);
    const support = analysis.support.find((item) => item.id === "python");
    assert.ok(support);
    const file = analysis.files.find((entry) => entry.file === "app.py");
    assert.ok(file);
    if (file.status === "parsed") {
      assert.equal(file.backend, "python-ast");
      assert.ok(file.symbols.some((symbol) => symbol.name === "users"));
      assert.ok(file.routes.some((route) => route.path === "/users"));
      assert.equal(support.level, "analyzed");
    } else {
      assert.equal(file.status, "heuristic");
      assert.equal(support.level, "detected");
    }
    assert.ok(support.frameworks.includes("Flask"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("attack surface map: routes, auth/data evidence and explicit limits", async () => {
  const repo = tempDir("pitstop-map-");
  try {
    write(repo, "package.json", JSON.stringify({ name: "map-demo" }));
    write(repo, "src/server.js", [
      "const app = require('express')();",
      "app.get('/api/users', handler);",
      "app.post('/admin/delete', handler);",
    ].join("\n"));
    write(repo, "src/auth.js", "module.exports = {};\n");
    write(repo, "src/db.js", "module.exports = {};\n");
    const analysis = await analyzeLanguages(repo);
    const surface = buildAttackSurface(analysis);
    assert.ok(surface.routes.some((route) => route.path === "/api/users"));
    assert.ok(surface.routes.some((route) => route.path === "/admin/delete" && route.privileged));
    assert.ok(surface.authenticationFiles.includes("src/auth.js"));
    assert.ok(surface.dataAccessFiles.includes("src/db.js"));
    assert.ok(surface.limits.some((limit) => /not live endpoint proof/.test(limit)));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("languages report keeps support levels and verification honest", async () => {
  const repo = tempDir("pitstop-lang-report-");
  try {
    write(repo, "package.json", JSON.stringify({ name: "report-demo" }));
    write(repo, "index.js", "module.exports = 1;\n");
    const analysis = await analyzeLanguages(repo);
    const output = renderLanguageAnalysis(analysis);
    assert.match(output, /JavaScript \/ TypeScript/);
    assert.match(output, /verification: unproven/);
    assert.match(output, /Support levels are cumulative/);
    assert.match(output, /Detected or parsed is not analyzed/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
