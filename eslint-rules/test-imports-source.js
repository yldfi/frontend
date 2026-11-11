/**
 * ESLint rule: yld-tests/imports-source
 *
 * A unit test file must exercise real source code. This rule reports a test
 * file that imports, dynamically imports or mocks no source module, which is
 * the shape of a test that re-implements a function and asserts on the copy.
 *
 * A module string counts as source when it starts with "@/", "./" or "../".
 */

const SOURCE_PREFIXES = ["@/", "./", "../"];
const TEST_SUPPORT_PREFIX = "@/__tests__/";
const MOCK_FUNCTIONS = new Set(["mock", "doMock", "importActual"]);

function isSourceModuleString(value) {
  if (typeof value !== "string") return false;
  // Fixtures and test helpers live under src/__tests__/; they are not source.
  if (value.startsWith(TEST_SUPPORT_PREFIX)) return false;
  return SOURCE_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isSourceModule(node) {
  if (!node) return false;
  // Static imports: import x from "@/lib/x"
  if (node.type === "Literal") {
    return isSourceModuleString(node.value);
  }
  // Template literal with no expressions: import(`@/lib/x`)
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  ) {
    return isSourceModuleString(node.quasis[0].value.cooked);
  }
  return false;
}

function isTypeOnlyImport(node) {
  if (node.importKind === "type") return true;
  return (
    node.specifiers.length > 0 &&
    node.specifiers.every((specifier) => specifier.importKind === "type")
  );
}

function isViMockCall(node) {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type !== "MemberExpression") return false;
  if (callee.computed) {
    if (
      callee.object.type !== "Identifier" ||
      callee.object.name !== "vi" ||
      callee.property.type !== "Literal" ||
      typeof callee.property.value !== "string" ||
      !MOCK_FUNCTIONS.has(callee.property.value)
    ) {
      return false;
    }
  } else {
    if (
      callee.object.type !== "Identifier" ||
      callee.object.name !== "vi" ||
      callee.property.type !== "Identifier" ||
      !MOCK_FUNCTIONS.has(callee.property.name)
    ) {
      return false;
    }
  }
  return node.arguments.length > 0 && isSourceModule(node.arguments[0]);
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require unit test files to import or mock at least one source module",
    },
    schema: [],
    messages: {
      noSourceImport:
        "Test file imports no source module; test the real code, not a copy.",
    },
  },

  create(context) {
    let importsSource = false;

    return {
      ImportDeclaration(node) {
        if (isTypeOnlyImport(node)) return;
        if (isSourceModule(node.source)) importsSource = true;
      },
      ImportExpression(node) {
        if (isSourceModule(node.source)) importsSource = true;
      },
      CallExpression(node) {
        if (isViMockCall(node)) importsSource = true;
      },
      "Program:exit"(node) {
        if (importsSource) return;
        context.report({ node, messageId: "noSourceImport" });
      },
    };
  },
};
