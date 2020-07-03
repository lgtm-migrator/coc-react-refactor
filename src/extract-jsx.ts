import traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { workspace } from 'coc.nvim';
import LinesAndColumns from 'lines-and-columns';
import { Position, Range, TextEdit } from 'vscode-languageserver-protocol';
import {
  codeFromNode,
  codeToAst,
  findComponentMemberReferences,
  isFunctionBinding,
  isJSX,
  isPathInRange,
  isPathRemoved,
  jsxToAst,
} from './ast';
import { askForName, generateClassComponent, generatePureComponent } from './utils';
import pickBy = require('lodash.pickby');

/**
 * Extract code to function action
 */
export const extractToFunction = async () => {
  try {
    await extractAndReplaceSelection();
    // TODO format
  } catch (error) {
    console.error('Extract JSX to function:', error);
    workspace.showMessage('Extract JSX to function failed', 'error');
  }
};

/**
 * Extract code to file action
 */
// export const extractToFile = async () => {
//   try {
//     const result = await extractAndReplaceSelection(true);
//     const document = editor.document;
//     const doc = await workspace.document;

//     const documentDir = path.dirname(editor.document.fileName);
//     const watcher = workspace.createFileSystemWatcher(path.join(documentDir, '*.{js,jsx,ts,tsx}'));

//     const disposable = watcher.onDidCreate(async (uri) => {
//       disposable.dispose();
//       // TODO
//       await commands.executeCommand('editor.action.formatDocument');
//       await workspace.jumpTo(uri.toString());
//       await commands.executeCommand('editor.action.formatDocument');

//       ensureReactIsImported(vscode.window.activeTextEditor);
//     });

//     const insertPos = document.positionAt(result.insertAt);
//     const cmpLines = result.componentCode.split(/\n/).length;

//     const start = new vscode.Position(insertPos.line, 0);
//     const end = new vscode.Position(insertPos.line + cmpLines, 0);
//     const selection = new vscode.Selection(start, end);

//     await executeMoveToNewFileCodeAction(editor.document, selection);
//   } catch (error) {
//     vscode.window.showErrorMessage(error);
//   }
// };

/**
 * Check if code action is available
 *
 * @param code
 */
export const isCodeActionAvailable = (code: string): boolean => {
  return isJSX(code);
};

/**
 * Extract selected JSX to a new React component
 *
 * @param editor
 * @param produceClass
 */
const extractAndReplaceSelection = async (produceClass = false): Promise<RefactorResult | undefined> => {
  const name = await askForName();
  if (!name) return;

  const doc = await workspace.document;
  const mode = await workspace.nvim.call('visualmode');
  const range = await workspace.getSelectedRange(mode, doc);
  if (!range) return;

  const documentText = doc.textDocument.getText();

  const [start, end] = getIndexesForSelection(documentText, range);
  const result = executeCodeAction(name, documentText, start, end, produceClass);

  const edits: TextEdit[] = [
    TextEdit.replace(range, result.replaceJSXCode),
    TextEdit.insert(Position.create(result.insertAt, 0), result.componentCode + '\n\n'),
  ];

  await doc.applyEdits(edits);

  return result;
};

/**
 * Execute otb code action provided by TypeScript language server
 *
 * @param document
 * @param rangeOrSelection
 */
// const executeMoveToNewFileCodeAction = (document: TextDocument, rangeOrSelection: vscode.Range | vscode.Selection) => {
//   const codeAction = 'Move to a new file';
//   return vscode.commands.executeCommand(
//     '_typescript.applyRefactoring',
//     document,
//     document.fileName,
//     codeAction,
//     codeAction,
//     rangeOrSelection
//   );
// };

/**
 * Get start and end index of selection or range
 *
 * @param documentText
 * @param selectionOrRange
 */
const getIndexesForSelection = (documentText: string, selectionOrRange: Range): number[] => {
  const lines = new LinesAndColumns(documentText);
  const { start, end } = selectionOrRange;
  const startIndex = lines.indexForLocation({
    line: start.line,
    column: start.character,
  });
  const endIndex = lines.indexForLocation({
    line: end.line,
    column: end.character,
  });
  return [startIndex!, endIndex!];
};

/**
 * Check is React imported to document and if not import
 *
 * @param editor
 */
// const ensureReactIsImported = (editor: vscode.TextEditor) => {
//   const ast = codeToAst(editor.document.getText());
//   let matched;
//   traverse(ast, {
//     ImportDeclaration(path) {
//       if (path.node.source.value === 'react') {
//         matched = true;
//         path.stop();
//       }
//     },
//   });
//   if (!matched) {
//     editor.edit((edit) => {
//       edit.insert(new vscode.Position(0, 0), 'import React from "react";\n');
//     });
//   }
// };

/**
 * Extraction Result Type
 */
type RefactorResult = {
  replaceJSXCode: string;
  componentCode: string;
  insertAt: number;
};

/**
 * Execute code action
 *
 * @param name
 * @param code
 * @param start
 * @param end
 * @param produceClass
 */
const executeCodeAction = (
  name: string,
  code: string,
  start: number,
  end: number,
  produceClass = false
): RefactorResult => {
  let selectionCode = code.substring(start, end);

  if (!isJSX(selectionCode)) {
    throw new Error('Invalid JSX selected;');
  }

  if (!jsxToAst(selectionCode)) {
    selectionCode = `<div>${selectionCode}</div>`;
    code = code.substring(0, start) + selectionCode + code.substring(end);
    end = start + selectionCode.length;
  }

  const ast = codeToAst(code);

  const selectedPath = findSelectedJSXElement(ast, start, end);
  if (!selectedPath) {
    throw new Error('Invalid JSX selected');
  }

  const parentPath = findParentComponent(selectedPath);
  const referencePaths = findComponentMemberReferences(parentPath, selectedPath);

  const paths = referencePaths.filter(isPathInRange(start, end));

  const passedProps = {};

  const keyAttribute = copyAndRemoveKeyAttribute(selectedPath);
  if (keyAttribute) {
    passedProps['key'] = keyAttribute;
  }

  const objects = getContainerObjects(paths);

  paths
    .filter((path) => !isPathRemoved(path))
    .forEach((path) => {
      const expression = codeFromNode(path.node);
      let name, container;

      if (path.isMemberExpression()) {
        if (isFunctionBinding(path)) {
          path = path.parentPath;
          name = path.node.callee.object.property.name;
        } else {
          name = path.node.property.name;
          container = objects.find((o) => expression.startsWith(o.object));
        }
      } else {
        name = path.node.name;
      }

      if (container) {
        name = matchRouteInObject(container, expression);
        if (!passedProps[container.property]) {
          passedProps[container.property] = t.identifier(container.object);
        }
      } else {
        name = ensurePropertyIsUnique(passedProps, name, expression);
        if (!passedProps[name]) {
          passedProps[name] = t.cloneDeep(path.node);
        }
      }

      path.replaceWith(createPropsExpression(produceClass, name));
    });

  const extractedJSX = codeFromNode(selectedPath.node);
  const createComponent = produceClass ? generateClassComponent : generatePureComponent;
  const replaceJSXCode = codeFromNode(createJSXElement(name, passedProps));
  const componentCode = createComponent(name, extractedJSX);
  const insertAt = getComponentStartAt(parentPath);

  return {
    replaceJSXCode,
    componentCode,
    insertAt,
  };
};

/**
 * Find parent component class or arrow function declarator
 *
 * @param path
 */
const findParentComponent = (path: NodePath) => {
  const parentPath = path.findParent(
    (path) => path.isClassDeclaration() || path.isVariableDeclarator() || path.isFunctionDeclaration()
  );
  if (!parentPath) {
    throw new Error('Invalid component');
  }
  return parentPath;
};

/**
 * Find the frist path in a range
 * @param ast
 * @param start
 * @param end
 */
const findSelectedJSXElement = (ast, start, end) => {
  let selectedPath;
  traverse(ast, {
    JSXElement(path) {
      if (path.node.start >= start && path.node.end <= end) {
        selectedPath = path;
        path.stop();
      }
    },
  });
  return selectedPath;
};

/**
 * Find common container objects from a list of member expressions
 * @param paths
 */
const getContainerObjects = (paths: NodePath[]): { object: string; property: string }[] => {
  let objectMap = {};
  paths
    .filter(
      (path) =>
        (t.isMemberExpression(path.node) && !t.isThisExpression(path.node.object)) || !t.isMemberExpression(path.node)
    )
    .forEach((path) => {
      const object = codeFromNode(t.isMemberExpression(path.node) ? path.node.object : path.node);
      objectMap[object] = objectMap[object] || 0;
      objectMap[object]++;
    });
  objectMap = pickBy(objectMap, (val, key) => val > 1 && !isPropsObject(key));
  objectMap = pickBy(objectMap, (_val, key) => !objectMap[key.slice(0, key.lastIndexOf('.'))]);
  return Object.keys(objectMap).map((object) => ({
    object,
    property: object.slice(object.lastIndexOf('.') + 1),
  }));
};

const getComponentStartAt = (path) => {
  if (path.node.leadingComments && path.node.leadingComments.length) {
    return path.node.leadingComments[0].start;
  }
  return path.node.start;
};

const ensurePropertyIsUnique = (propsMap: Record<string, any>, name: string, value: any) => {
  if (!propsMap[name] || codeFromNode(propsMap[name]) === value) {
    return name;
  }
  return ensurePropertyIsUnique(propsMap, `_${name}`, value);
};

const matchRouteInObject = (object: { object: string; property: string }, childObject) =>
  [object.property, childObject.slice(object.object.length + 1)].filter((o) => !!o).join('.');

const isPropsObject = (expressionCode: string) =>
  expressionCode === 'this.props' || expressionCode === 'this.state' || expressionCode === 'props';

const createPropsExpression = (produceClass, propertyName: string) =>
  produceClass
    ? t.memberExpression(t.memberExpression(t.thisExpression(), t.identifier('props')), t.identifier(propertyName))
    : t.memberExpression(t.identifier('props'), t.identifier(propertyName));

const createJSXElement = (name: string, attributes: Record<string, any>) => {
  const jsxElement = t.jsxElement(
    t.jsxOpeningElement(t.jsxIdentifier(name), []),
    t.jsxClosingElement(t.jsxIdentifier(name)),
    [],
    true
  );
  Object.keys(attributes).forEach((id) => {
    jsxElement.openingElement.attributes.push(
      t.jsxAttribute(t.jsxIdentifier(id), t.jsxExpressionContainer(attributes[id]))
    );
  });
  return jsxElement;
};

const copyAndRemoveKeyAttribute = (jsxElementPath: any) => {
  if (!jsxElementPath.isJSXElement()) {
    return;
  }
  const openingElement = jsxElementPath.node.openingElement;
  let keyAttributePath;
  jsxElementPath.traverse({
    JSXAttribute(path) {
      if (path.node.name.name === 'key' && path.parentPath.node === openingElement) {
        keyAttributePath = path;
      }
    },
  });
  if (keyAttributePath) {
    const value = t.cloneDeep(keyAttributePath.node.value.expression);
    keyAttributePath.remove();
    return value;
  }
};
