import { parse } from "@babel/parser";
import type {
  JsCall,
  JsCatch,
  JsFileIndex,
  JsFunction,
  JsImport,
  JsImportBinding,
  JsLoop,
  JsRegex,
  JsRoute,
  JsTest,
} from "./indexTypes.js";

/**
 * audit/jsParser.ts — one Babel pass per JS/TS file.
 *
 * The pass records facts, not verdicts: every function's size, complexity,
 * calls and loops; every import/export; every regex and type escape. Rules in
 * rules.ts decide what (if anything) those facts mean.
 *
 * Nested functions get their own record and do not inherit the parent's call
 * or complexity counts.
 */

const MAX_TOKENS = 400;

const KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "default", "return", "await",
  "async", "function", "const", "let", "var", "class", "new", "try", "catch", "finally",
  "throw", "typeof", "instanceof", "in", "of", "break", "continue", "yield",
]);

const DECISION = new Set(["IfStatement", "CatchClause", "ConditionalExpression", "SwitchCase"]);

const LOOP = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);

const CONTROL = new Set([
  "IfStatement", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement",
  "DoWhileStatement", "SwitchStatement", "TryStatement", "CatchClause",
]);

const ASSERT_CALLS = /^(expect|assert|should|chai|assertThat|assertEqual|assertThrows|assertRejects|deepEqual|equal|ok|throws|rejects)$/i;

export function tokenizeSnippet(source: string): string[] {
  const re = /[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|===|!==|==|!=|<=|>=|&&|\|\||\?\?|=>|[+\-*/%<>=!?:]/g;
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null && tokens.length < MAX_TOKENS) {
    const token = match[0];
    if (/^[A-Za-z_$]/.test(token)) tokens.push(KEYWORDS.has(token) ? token : "I");
    else if (/^\d/.test(token)) tokens.push("N");
    else if (/^['"]/.test(token)) tokens.push("S");
    else tokens.push(token);
  }
  return tokens;
}

function nameOf(node: any): string {
  if (!node) return "";
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral") return String(node.value);
  if (node.type === "PrivateName") return node.id?.name ?? "";
  return "";
}

function calleeOf(node: any): { name: string; object?: string } {
  if (!node) return { name: "<unknown>" };
  if (node.type === "Identifier") return { name: node.name };
  if (node.type === "MemberExpression") {
    const property = node.property;
    const name = node.computed && property?.type === "StringLiteral" ? String(property.value) : nameOf(property);
    const object =
      node.object?.type === "Identifier"
        ? node.object.name
        : node.object?.type === "ThisExpression"
          ? "this"
          : undefined;
    return { name: name || "<computed>", ...(object ? { object } : {}) };
  }
  return { name: "<computed>" };
}

function walkAst(node: any, visit: (node: any) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walkAst(child, visit);
    else if (value && typeof value === "object" && typeof value.type === "string") walkAst(value, visit);
  }
}

function isImportBinding(parent: any): boolean {
  return Boolean(
    parent &&
      (parent.type === "ImportSpecifier" ||
        parent.type === "ImportDefaultSpecifier" ||
        parent.type === "ImportNamespaceSpecifier"),
  );
}

function isDeclarationName(node: any, parent: any): boolean {
  if (!parent) return false;
  if (parent.type === "VariableDeclarator" && parent.id === node) return true;
  if (parent.type === "CatchClause" && parent.param === node) return true;
  if (parent.type === "ClassDeclaration" && parent.id === node) return true;
  return false;
}

function isPropertyKey(node: any, parent: any): boolean {
  if (!parent) return false;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return true;
  if (parent.type === "ObjectProperty" && parent.key === node && !parent.computed && !parent.shorthand) return true;
  if (parent.type === "ClassProperty" && parent.key === node && !parent.computed) return true;
  if (parent.type === "ClassMethod" && parent.key === node && !parent.computed) return true;
  if (parent.type === "ObjectMethod" && parent.key === node && !parent.computed) return true;
  if (parent.type === "TSPropertySignature" && parent.key === node && !parent.computed) return true;
  return false;
}

function isLabel(parent: any): boolean {
  if (!parent) return false;
  return parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement";
}

interface WalkContext {
  fn: JsFunction | null;
  depth: number;
  loops: JsLoop[];
}

export function parseJsFile(relative: string, content: string): JsFileIndex {
  const index: JsFileIndex = {
    file: relative,
    parseOk: false,
    lines: content.split(/\r?\n/).length,
    functions: [],
    imports: [],
    exports: [],
    calls: [],
    routes: [],
    tests: [],
    catches: [],
    strings: [],
    numbers: [],
    regexes: [],
    anyCount: 0,
    anyLines: [],
    nonNullCount: 0,
    nonNullLines: [],
    typeIgnoreLines: [],
    looseEquality: [],
    usedNames: [],
  };

  const used = new Set<string>();
  content.split(/\r?\n/).forEach((line, i) => {
    if (/@ts-(?:ignore|expect-error|nocheck)/.test(line)) index.typeIgnoreLines.push(i + 1);
  });

  let ast: any;
  try {
    ast = parse(content, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: ["typescript", "jsx", "decorators-legacy", "classProperties", "importAttributes"],
    });
  } catch (error) {
    index.error = (error as Error).message.slice(0, 240);
    return index;
  }

  // Function parameters and return types are walked separately below, which
  // used to skip the type identifiers inside them. A type-only import then
  // looked unused even though it was referenced. Collect type references
  // first; this also covers interfaces, generics and `implements` clauses.
  const noteTypeName = (node: any): void => {
    if (!node) return;
    if (node.type === "Identifier") used.add(node.name);
    else if (node.type === "TSQualifiedName") noteTypeName(node.left);
    else if (node.type === "TSInstantiationExpression") noteTypeName(node.expression);
  };
  walkAst(ast.program, (node) => {
    if (node.type === "TSTypeReference") noteTypeName(node.typeName);
    else if (node.type === "TSTypeQuery") noteTypeName(node.exprName);
    else if (node.type === "TSExpressionWithTypeArguments") noteTypeName(node.expression);
  });

  const exportedNodes = new Set<any>();
  for (const statement of ast.program.body) {
    if (statement.type === "ExportNamedDeclaration" && statement.declaration) exportedNodes.add(statement.declaration);
    if (statement.type === "ExportDefaultDeclaration" && statement.declaration) exportedNodes.add(statement.declaration);
  }

  const nameForFunction = (node: any, parent: any): string => {
    if (node.id?.name) return node.id.name;
    if (parent?.type === "VariableDeclarator" && parent.id?.type === "Identifier") return parent.id.name;
    if (parent?.type === "ObjectProperty" || parent?.type === "ClassProperty") return nameOf(parent.key);
    if (parent?.type === "AssignmentExpression") return nameOf(parent.left);
    if (parent?.type === "ExportDefaultDeclaration") return "default";
    if (parent?.type === "CallExpression") {
      const callee = calleeOf(parent.callee);
      if (parent.arguments?.includes(node) && /^(get|post|put|patch|delete|all|use|route)$/i.test(callee.name)) {
        return "<handler:" + (node.loc?.start?.line ?? 1) + ">";
      }
      if (parent.arguments?.includes(node) && /^(test|it|describe)$/i.test(callee.name)) {
        return "<test:" + (node.loc?.start?.line ?? 1) + ">";
      }
      return "<callback:" + (node.loc?.start?.line ?? 1) + ">";
    }
    return "<anonymous:" + (node.loc?.start?.line ?? 1) + ">";
  };

  const assertionIn = (node: any): boolean => {
    let found = false;
    walkAst(node, (child) => {
      if (found || child.type !== "CallExpression") return;
      const callee = calleeOf(child.callee);
      if (ASSERT_CALLS.test(callee.name) || (callee.object !== undefined && ASSERT_CALLS.test(callee.object))) found = true;
    });
    return found;
  };

  const testCallInfo = (
    callee: { name: string; object?: string },
    bareIdentifier: boolean,
  ): { name: string; skipped: boolean } | null => {
    // A bare test()/it()/describe() is a test declaration. `value.test(...)`
    // and `/regex/.test(...)` are calls on an object and must never be counted
    // as tests, even though the method name is "test".
    if (bareIdentifier && /^(test|it|describe)$/i.test(callee.name)) {
      return { name: callee.name, skipped: false };
    }
    if (
      (callee.name === "skip" || callee.name === "todo") &&
      callee.object !== undefined &&
      /^(test|it|describe)$/i.test(callee.object)
    ) {
      return { name: callee.object, skipped: true };
    }
    return null;
  };

  const walkChildren = (node: any, ctx: WalkContext): void => {
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child === "object" && typeof child.type === "string") walk(child, node, ctx);
        }
      } else if (value && typeof value === "object" && typeof value.type === "string") {
        walk(value, node, ctx);
      }
    }
  };

  const enterFunction = (node: any, parent: any, parentCtx: WalkContext): void => {
    const name = nameForFunction(node, parent);
    const body = node.body;
    const startLine = node.loc?.start?.line ?? 1;
    const endLine = node.loc?.end?.line ?? startLine;
    const fn: JsFunction = {
      name,
      kind:
        node.type === "ClassMethod" || node.type === "ObjectMethod" || node.type === "ClassPrivateMethod"
          ? "method"
          : node.type === "ArrowFunctionExpression"
            ? "arrow"
            : "function",
      line: startLine,
      endLine,
      loc: Math.max(1, endLine - startLine + 1),
      params: [],
      async: Boolean(node.async),
      exported: exportedNodes.has(node) || (parent?.type === "ExportNamedDeclaration" && parent.declaration === node),
      cyclomatic: 1,
      maxDepth: 0,
      awaits: 0,
      calls: [],
      loops: [],
      tokens: node.start !== undefined && node.end !== undefined ? tokenizeSnippet(content.slice(node.start, node.end)) : [],
      ...(parentCtx.fn ? { parent: parentCtx.fn.name } : {}),
    };
    for (const param of node.params ?? []) {
      walkAst(param, (child) => {
        if (child.type === "Identifier" && child.name && !fn.params.includes(child.name)) fn.params.push(child.name);
        if (child.type === "TSAnyKeyword") {
          index.anyCount += 1;
          index.anyLines.push(child.loc?.start?.line ?? startLine);
        }
      });
    }
    if (node.returnType) {
      walkAst(node.returnType, (child) => {
        if (child.type === "TSAnyKeyword") {
          index.anyCount += 1;
          index.anyLines.push(child.loc?.start?.line ?? startLine);
        }
      });
    }
    index.functions.push(fn);
    if (body && typeof body === "object") {
      walk(body, node, { fn, depth: 0, loops: [] });
    }
  };

  const walk = (node: any, parent: any, ctx: WalkContext): void => {
    if (!node || typeof node !== "object") return;

    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassMethod" ||
      node.type === "ObjectMethod" ||
      node.type === "ClassPrivateMethod"
    ) {
      enterFunction(node, parent, ctx);
      return;
    }

    switch (node.type) {
      case "ImportDeclaration": {
        const bindings: JsImportBinding[] = [];
        for (const spec of node.specifiers ?? []) {
          const local = spec.local?.name ?? "";
          const imported =
            spec.type === "ImportDefaultSpecifier"
              ? "default"
              : spec.type === "ImportNamespaceSpecifier"
                ? "*"
                : nameOf(spec.imported) || local;
          if (local) bindings.push({ local, imported, typeOnly: node.importKind === "type" || spec.importKind === "type" });
        }
        const entry: JsImport = {
          specifier: String(node.source?.value ?? ""),
          line: node.loc?.start?.line ?? 1,
          start: node.start ?? 0,
          end: node.end ?? 0,
          bindings,
          sideEffect: bindings.length === 0,
        };
        index.imports.push(entry);
        return;
      }
      case "ExportNamedDeclaration": {
        if (node.declaration) {
          const declaration = node.declaration;
          if (declaration.id?.name) {
            index.exports.push({ name: declaration.id.name, line: node.loc?.start?.line ?? 1, isDefault: false });
          }
          for (const declarator of declaration.declarations ?? []) {
            if (declarator.id?.type === "Identifier") {
              index.exports.push({ name: declarator.id.name, line: node.loc?.start?.line ?? 1, isDefault: false });
            }
          }
        }
        for (const spec of node.specifiers ?? []) {
          const name = nameOf(spec.exported) || nameOf(spec.local);
          if (name) index.exports.push({ name, line: node.loc?.start?.line ?? 1, isDefault: false });
        }
        if (!node.source) {
          // `import { Foo } ...; export { Foo }` is a real use of Foo. The
          // switch returns before walking specifiers, so record it here.
          for (const spec of node.specifiers ?? []) {
            const local = nameOf(spec.local);
            if (local) used.add(local);
          }
        }
        if (node.source) {
          const namespaceOnly = (node.specifiers ?? []).some(
            (spec: any) => spec.type === "ExportNamespaceSpecifier",
          );
          const bindings: JsImportBinding[] = namespaceOnly
            ? []
            : (node.specifiers ?? []).map((spec: any) => ({
                local: nameOf(spec.local) || nameOf(spec.exported),
                imported: nameOf(spec.local) || nameOf(spec.exported),
                typeOnly: node.exportKind === "type" || spec.exportKind === "type",
              }));
          index.imports.push({
            specifier: String(node.source.value ?? ""),
            line: node.loc?.start?.line ?? 1,
            start: node.start ?? 0,
            end: node.end ?? 0,
            bindings,
            sideEffect: false,
            reExport: namespaceOnly ? "star" : "named",
          });
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        index.exports.push({ name: "default", line: node.loc?.start?.line ?? 1, isDefault: true });
        break;
      }
      case "ExportAllDeclaration": {
        index.imports.push({
          specifier: String(node.source?.value ?? ""),
          line: node.loc?.start?.line ?? 1,
          start: node.start ?? 0,
          end: node.end ?? 0,
          bindings: [],
          sideEffect: false,
          reExport: "star",
        });
        break;
      }
      case "CallExpression": {
        const callee = calleeOf(node.callee);
        const line = node.loc?.start?.line ?? 1;
        const endLine = node.loc?.end?.line ?? line;
        const args = (node.arguments ?? []).map((arg: any) => {
          const raw = arg?.start !== undefined && arg?.end !== undefined ? content.slice(arg.start, arg.end) : "";
          return raw.replace(/\s+/g, " ").trim().slice(0, 80);
        });
        const awaited = parent?.type === "AwaitExpression";
        const statement = parent?.type === "ExpressionStatement";
        const call: JsCall = {
          name: callee.name,
          ...(callee.object ? { object: callee.object } : {}),
          line,
          endLine,
          args,
          awaited,
          statement,
          inLoop: ctx.loops.length > 0,
        };
        if (ctx.fn) {
          ctx.fn.calls.push(call);
          if (awaited) ctx.fn.awaits += 1;
          const loop = ctx.loops[ctx.loops.length - 1];
          if (loop) {
            loop.calls.push({ name: callee.name, ...(callee.object ? { object: callee.object } : {}), line });
            if (awaited) loop.awaits += 1;
          }
        } else {
          index.calls.push(call);
        }

        const testInfo = testCallInfo(callee, node.callee?.type === "Identifier");
        if (testInfo) {
          const nameArg = node.arguments?.[0];
          const name = nameArg?.type === "StringLiteral" ? String(nameArg.value) : "<dynamic>";
          const callback = node.arguments?.[node.arguments.length - 1];
          const test: JsTest = {
            name,
            line,
            endLine,
            hasAssertion: callback ? assertionIn(callback) : false,
            skipped: testInfo.skipped,
          };
          index.tests.push(test);
        }

        if (
          /^(get|post|put|patch|delete|all|use|route)$/i.test(callee.name) &&
          typeof callee.object === "string" &&
          /^(app|router|server|api|routes?)$/i.test(callee.object)
        ) {
          const pathArg = node.arguments?.[0];
          if (pathArg?.type === "StringLiteral" && String(pathArg.value).startsWith("/")) {
            const handler = node.arguments?.[1];
            const handlerName = handler
              ? handler.type === "Identifier"
                ? handler.name
                : nameForFunction(handler, node)
              : undefined;
            const route: JsRoute = {
              method: callee.name.toUpperCase(),
              routePath: String(pathArg.value),
              line,
              ...(handlerName ? { handlerName } : {}),
              ...(handler ? { handlerLine: handler.loc?.start?.line ?? line } : {}),
            };
            index.routes.push(route);
          }
        }
        break;
      }
      case "NewExpression": {
        if (node.callee?.name === "RegExp") {
          const arg = node.arguments?.[0];
          if (arg?.type !== "StringLiteral") {
            index.regexes.push({
              pattern: arg?.start !== undefined ? content.slice(arg.start, arg.end).slice(0, 120) : "<dynamic>",
              flags: "",
              line: node.loc?.start?.line ?? 1,
              dynamic: true,
            });
          }
        }
        break;
      }
      case "StringLiteral": {
        index.strings.push({ value: String(node.value), line: node.loc?.start?.line ?? 1, inFunction: Boolean(ctx.fn) });
        return;
      }
      case "TemplateLiteral": {
        if ((node.expressions ?? []).length === 0) {
          const value = (node.quasis ?? []).map((quasi: any) => String(quasi.value?.cooked ?? "")).join("");
          if (value) index.strings.push({ value, line: node.loc?.start?.line ?? 1, inFunction: Boolean(ctx.fn) });
        }
        break;
      }
      case "NumericLiteral": {
        index.numbers.push({ value: Number(node.value), line: node.loc?.start?.line ?? 1, inFunction: Boolean(ctx.fn) });
        return;
      }
      case "TSAnyKeyword": {
        index.anyCount += 1;
        index.anyLines.push(node.loc?.start?.line ?? 1);
        break;
      }
      case "TSNonNullExpression": {
        index.nonNullCount += 1;
        index.nonNullLines.push(node.loc?.start?.line ?? 1);
        break;
      }
      case "BinaryExpression": {
        if (node.operator === "==" || node.operator === "!=") {
          const nullish = (side: any) =>
            side?.type === "NullLiteral" || (side?.type === "Identifier" && side.name === "undefined");
          if (!nullish(node.left) && !nullish(node.right)) {
            index.looseEquality.push({ line: node.loc?.start?.line ?? 1, operator: node.operator });
          }
        }
        break;
      }
      case "LogicalExpression": {
        if (ctx.fn && (node.operator === "&&" || node.operator === "||" || node.operator === "??")) {
          ctx.fn.cyclomatic += 1;
        }
        break;
      }
      case "CatchClause": {
        const statements = node.body?.body ?? [];
        const onlyLogs =
          statements.length > 0 &&
          statements.every((statement: any) => {
            if (statement.type !== "ExpressionStatement" || statement.expression?.type !== "CallExpression") return false;
            return calleeOf(statement.expression.callee).object === "console";
          });
        const entry: JsCatch = {
          line: node.loc?.start?.line ?? 1,
          endLine: node.loc?.end?.line ?? 1,
          empty: statements.length === 0,
          onlyLogs,
        };
        index.catches.push(entry);
        break;
      }
      case "RegExpLiteral": {
        const pattern = String(node.pattern ?? "");
        if (pattern) {
          const regex: JsRegex = {
            pattern,
            flags: String(node.flags ?? ""),
            line: node.loc?.start?.line ?? 1,
            dynamic: false,
          };
          index.regexes.push(regex);
        }
        return;
      }
      case "Identifier": {
        if (isImportBinding(parent) || isDeclarationName(node, parent)) return;
        if (!isPropertyKey(node, parent) && !isLabel(parent)) used.add(node.name);
        return;
      }
      case "JSXIdentifier": {
        used.add(node.name);
        return;
      }
    }

    if (LOOP.has(node.type)) {
      const loop: JsLoop = {
        kind: node.type,
        line: node.loc?.start?.line ?? 1,
        endLine: node.loc?.end?.line ?? 1,
        awaits: 0,
        calls: [],
      };
      if (ctx.fn) {
        ctx.fn.cyclomatic += 1;
        ctx.fn.loops.push(loop);
      }
      ctx.loops.push(loop);
      walkChildren(node, ctx);
      ctx.loops.pop();
      return;
    }

    if (DECISION.has(node.type)) {
      if (ctx.fn) {
        ctx.fn.cyclomatic += 1;
        ctx.fn.maxDepth = Math.max(ctx.fn.maxDepth, ctx.depth + 1);
      }
    }

    if (CONTROL.has(node.type) && ctx.fn) {
      const depth = ctx.depth + 1;
      ctx.fn.maxDepth = Math.max(ctx.fn.maxDepth, depth);
      const saved = ctx.depth;
      ctx.depth = depth;
      walkChildren(node, ctx);
      ctx.depth = saved;
      return;
    }

    walkChildren(node, ctx);
  };

  walk(ast.program, null, { fn: null, depth: 0, loops: [] });
  index.usedNames = [...used].sort();
  index.parseOk = true;
  return index;
}
