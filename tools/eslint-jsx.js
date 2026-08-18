"use strict";
// A one-rule local plugin so ESLint's core rules understand JSX.
//
// eslint-plugin-react doesn't support ESLint 10 yet, and all we actually need from it is for
// `no-unused-vars` to count a component referenced in JSX as used — otherwise every imported
// component looks dead. Marking each JSX identifier as used is exactly what
// react/jsx-uses-vars does.
const jsxUsesVars = {
  meta: { type: "problem", docs: { description: "mark variables referenced in JSX as used" }, schema: [] },
  create(context) {
    return {
      JSXIdentifier(node) {
        // <Foo>, <Foo.Bar> and attribute names all arrive here; marking an unknown name is a
        // no-op, so there's no need to filter out lowercase tags or props.
        context.sourceCode.markVariableAsUsed(node.name, node);
      },
    };
  },
};

module.exports = { rules: { "jsx-uses-vars": jsxUsesVars } };
