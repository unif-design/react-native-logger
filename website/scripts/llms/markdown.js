// 共用生成规则源：unif-design/.github/templates/llms。
'use strict';

const path = require('node:path');

const CLOSING_TO_OPENING = {
  ')': '(',
  ']': '[',
  '}': '{',
};

const DEMO_NAME_PATTERN = '(?:[A-Za-z_$][\\w$]*)?Demo';
const DEMO_NAME_REGEXP = new RegExp(`^${DEMO_NAME_PATTERN}$`, 'u');
const UNPROCESSED_DEMO_REGEXP = new RegExp(
  `<\\/?(${DEMO_NAME_PATTERN})\\b`,
  'u'
);
const EXPRESSION_PREFIX_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);
const EXPRESSION_PREFIX_PUNCTUATION = new Set([
  '[',
  '(',
  '{',
  '=',
  ',',
  ':',
  ';',
  '!',
  '?',
  '&',
  '|',
  '+',
  '-',
  '*',
  '%',
  '^',
  '~',
]);

function parseFrontmatter(content) {
  if (!content.startsWith('---')) {
    return { slug: null, title: null, description: null, body: content };
  }

  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    return { slug: null, title: null, description: null, body: content };
  }

  const block = content.slice(3, end);
  const body = content.slice(end + 4).replace(/^\n/u, '');
  const slugMatch = block.match(/^\s*slug:\s*(.+)\s*$/mu);
  const titleMatch = block.match(/^\s*title:\s*(.+)\s*$/mu);
  const descriptionMatch = block.match(/^\s*description:\s*(.+)\s*$/mu);
  const unquote = (value) => value && value.trim().replace(/^['"]|['"]$/gu, '');

  return {
    slug: unquote(slugMatch && slugMatch[1]),
    title: unquote(titleMatch && titleMatch[1]),
    description: unquote(descriptionMatch && descriptionMatch[1]),
    body,
  };
}

function isDemoName(name) {
  return DEMO_NAME_REGEXP.test(name);
}

function lineAt(source, start) {
  const newline = source.indexOf('\n', start);
  const end = newline === -1 ? source.length : newline;
  const raw = source.slice(start, end);
  return {
    text: raw.endsWith('\r') ? raw.slice(0, -1) : raw,
    end,
    next: newline === -1 ? source.length : newline + 1,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isEscapedAt(source, index) {
  let backslashes = 0;
  for (let cursor = index - 1; source[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function protectCode(source) {
  const protectedRanges = [];
  const fenceRanges = [];
  let namespaceIndex = 0;
  let tokenPrefix = `\u0000LLMS_PROTECTED_${namespaceIndex}_`;
  while (source.includes(tokenPrefix)) {
    namespaceIndex += 1;
    tokenPrefix = `\u0000LLMS_PROTECTED_${namespaceIndex}_`;
  }
  const tokenPattern = new RegExp(
    `${escapeRegExp(tokenPrefix)}(\\d+)\\u0000`,
    'gu'
  );

  for (
    let index = 0;
    index < source.length /* Advance by the parsed token below. */;
  ) {
    const line = lineAt(source, index);
    const opener = line.text.match(/^ {0,3}(`{3,}|~{3,})/u);
    if (!opener) {
      index = line.next;
      continue;
    }

    const run = opener[1];
    const closerPattern = new RegExp(
      `^ {0,3}${escapeRegExp(run)}[\\t ]*$`,
      'u'
    );
    let end = source.length;
    let cursor = line.next;
    while (cursor < source.length) {
      const candidate = lineAt(source, cursor);
      if (closerPattern.test(candidate.text)) {
        // 留下 closing line 后的换行，避免被 sentinel 与下一条顶层声明粘在一起。
        end = candidate.end;
        break;
      }
      cursor = candidate.next;
    }
    fenceRanges.push({ start: index, end });
    index = end === source.length ? source.length : lineAt(source, end).next;
  }

  const addProtected = (value) => {
    const protectedIndex = protectedRanges.push(value) - 1;
    return `${tokenPrefix}${protectedIndex}\u0000`;
  };

  let maskedSource = '';
  let cursor = 0;
  for (const range of fenceRanges) {
    maskedSource += source.slice(cursor, range.start);
    maskedSource += addProtected(source.slice(range.start, range.end));
    cursor = range.end;
  }
  maskedSource += source.slice(cursor);

  let commentMasked = '';
  cursor = 0;
  while (cursor < maskedSource.length) {
    let terminator = null;
    let terminatorLength = 0;
    if (maskedSource.startsWith('<!--', cursor)) {
      terminator = '-->';
      terminatorLength = terminator.length;
    } else if (maskedSource.startsWith('{/*', cursor)) {
      terminator = '*/}';
      terminatorLength = terminator.length;
    }

    if (terminator === null) {
      commentMasked += maskedSource[cursor];
      cursor += 1;
      continue;
    }

    const closeStart = maskedSource.indexOf(terminator, cursor + 3);
    const end =
      closeStart === -1 ? maskedSource.length : closeStart + terminatorLength;
    commentMasked += addProtected(maskedSource.slice(cursor, end));
    cursor = end;
  }

  let inlineMasked = '';
  cursor = 0;
  while (cursor < commentMasked.length) {
    if (commentMasked[cursor] !== '`' || isEscapedAt(commentMasked, cursor)) {
      inlineMasked += commentMasked[cursor];
      cursor += 1;
      continue;
    }

    let openerEnd = cursor;
    while (commentMasked[openerEnd] === '`') openerEnd += 1;
    const runLength = openerEnd - cursor;
    let search = openerEnd;
    let closeStart = -1;

    while (search < commentMasked.length) {
      const candidate = commentMasked.indexOf('`', search);
      if (candidate === -1) break;
      let candidateEnd = candidate;
      while (commentMasked[candidateEnd] === '`') candidateEnd += 1;
      if (isEscapedAt(commentMasked, candidate)) {
        search = candidateEnd;
        continue;
      }
      if (candidateEnd - candidate === runLength) {
        closeStart = candidate;
        break;
      }
      search = candidateEnd;
    }

    if (closeStart === -1) {
      inlineMasked += commentMasked.slice(cursor, openerEnd);
      cursor = openerEnd;
      continue;
    }

    const end = closeStart + runLength;
    inlineMasked += addProtected(commentMasked.slice(cursor, end));
    cursor = end;
  }

  return {
    source: inlineMasked,
    restore(value) {
      const expandedRanges = new Map();
      const expanding = new Set();
      const expand = (index) => {
        if (expandedRanges.has(index)) return expandedRanges.get(index);
        if (
          !Number.isSafeInteger(index) ||
          protectedRanges[index] === undefined
        ) {
          throw new Error(`invalid protected token ${index}`);
        }
        if (expanding.has(index)) {
          throw new Error(`cyclic protected token ${index}`);
        }

        expanding.add(index);
        const expanded = protectedRanges[index].replace(
          tokenPattern,
          (_match, nestedIndex) => expand(Number(nestedIndex))
        );
        expanding.delete(index);
        expandedRanges.set(index, expanded);
        return expanded;
      };

      const restored = value.replace(tokenPattern, (_match, index) =>
        expand(Number(index))
      );
      tokenPattern.lastIndex = 0;
      if (tokenPattern.test(restored)) {
        tokenPattern.lastIndex = 0;
        throw new Error('unrestored protected token');
      }
      tokenPattern.lastIndex = 0;
      return restored;
    },
  };
}

function previousCodeToken(source, index) {
  let end = index - 1;
  while (end >= 0 && /\s/u.test(source[end])) end -= 1;
  if (end < 0) return null;

  const character = source[end];
  if (
    (character === '+' || character === '-') &&
    source[end - 1] === character
  ) {
    return character + character;
  }
  if (character === '>' && source[end - 1] === '=') return '=>';
  if (!/[\w$]/u.test(character)) return character;

  let start = end;
  while (start >= 0 && /[\w$]/u.test(source[start])) start -= 1;
  return source.slice(start + 1, end + 1);
}

function canStartExpressionAt(source, index) {
  const previousToken = previousCodeToken(source, index);
  if (previousToken === null) return true;
  if (previousToken === '++' || previousToken === '--') return false;
  if (previousToken === '=>') return true;
  return (
    EXPRESSION_PREFIX_PUNCTUATION.has(previousToken) ||
    EXPRESSION_PREFIX_KEYWORDS.has(previousToken)
  );
}

function isJsxOpeningAt(source, index) {
  if (source[index] !== '<' || !canStartExpressionAt(source, index)) {
    return false;
  }
  const next = source[index + 1];
  return next === '>' || /[A-Za-z_$]/u.test(next || '');
}

function readJsxTag(source, start, sourceName) {
  if (source[start] !== '<') return null;
  if (source.startsWith('<>', start)) {
    return {
      closing: false,
      end: start + 2,
      name: '',
      selfClosing: false,
    };
  }
  if (source.startsWith('</>', start)) {
    return {
      closing: true,
      end: start + 3,
      name: '',
      selfClosing: false,
    };
  }

  const closing = source[start + 1] === '/';
  const nameStart = start + (closing ? 2 : 1);
  const nameMatch = source
    .slice(nameStart)
    .match(/^[A-Za-z_$][\w$-]*(?:[.:-][A-Za-z_$][\w$-]*)*/u);
  if (!nameMatch) return null;

  const end = findTagEnd(source, nameStart + nameMatch[0].length, sourceName);
  return {
    closing,
    end,
    name: nameMatch[0],
    selfClosing: !closing && /\/[\t ]*>$/u.test(source.slice(start, end)),
  };
}

function findJsxElementEnd(source, start, sourceName = '<export declaration>') {
  const opening = readJsxTag(source, start, sourceName);
  if (opening === null || opening.closing) {
    throw new Error(`malformed JSX opening tag at ${start}`);
  }
  if (opening.selfClosing) return opening.end;

  const elementStack = [opening.name];
  for (
    let index = opening.end;
    index < source.length /* Advance by the parsed token below. */;
  ) {
    if (source[index] === '{') {
      index = findCodeExpressionEnd(source, index, sourceName);
      continue;
    }
    if (source[index] !== '<') {
      index += 1;
      continue;
    }

    const tag = readJsxTag(source, index, sourceName);
    if (tag === null) {
      throw new Error(`malformed JSX tag at ${index}`);
    }
    if (tag.closing) {
      const expected = elementStack.pop();
      if (tag.name !== expected) {
        throw new Error(`mismatched JSX closing tag at ${index}`);
      }
      if (elementStack.length === 0) return tag.end;
    } else if (!tag.selfClosing) {
      elementStack.push(tag.name);
    }
    index = tag.end;
  }

  if (elementStack.includes('LiveDemo')) {
    throw new Error('unclosed LiveDemo');
  }
  throw new Error(`unclosed JSX element at ${start}`);
}

function findRegexLiteralEnd(source, start) {
  let inCharacterClass = false;
  for (
    let index = start + 1;
    index < source.length /* Advance by the parsed token below. */;
  ) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '\n' || character === '\r') {
      throw new Error(`unclosed regex literal at ${start}`);
    }
    if (character === '[') {
      inCharacterClass = true;
      index += 1;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      index += 1;
      continue;
    }
    if (character === '/' && !inCharacterClass) {
      index += 1;
      while (/[A-Za-z]/u.test(source[index] || '')) index += 1;
      return index;
    }
    index += 1;
  }
  throw new Error(`unclosed regex literal at ${start}`);
}

function findExpressionLexemeEnd(source, index, sourceName, includeJsx = true) {
  if (source[index] === '/' && canStartExpressionAt(source, index)) {
    return findRegexLiteralEnd(source, index);
  }
  if (includeJsx && isJsxOpeningAt(source, index)) {
    return findJsxElementEnd(source, index, sourceName);
  }
  return null;
}

function findBalancedEnd(source, start) {
  const root = { kind: 'code', terminator: null, stack: [] };
  const contexts = [root];
  const isFunctionDeclaration = /^ {0,3}export\s+(?:async\s+)?function\b/u.test(
    source.slice(start)
  );
  let sawFunctionBody = false;

  for (
    let index = start;
    index < source.length /* Advance by the parsed token below. */;
  ) {
    const context = contexts.at(-1);
    const character = source[index];
    const next = source[index + 1];

    if (context.kind === 'line-comment') {
      if (character === '\n') contexts.pop();
      else index += 1;
      continue;
    }
    if (context.kind === 'block-comment') {
      if (character === '*' && next === '/') {
        contexts.pop();
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (context.kind === 'string') {
      if (character === '\\') index += 2;
      else if (character === context.quote) {
        contexts.pop();
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (context.kind === 'template') {
      if (character === '\\') {
        index += 2;
      } else if (character === '`') {
        contexts.pop();
        index += 1;
      } else if (character === '$' && next === '{') {
        contexts.push({ kind: 'code', terminator: '}', stack: [] });
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (character === '/' && next === '/') {
      contexts.push({ kind: 'line-comment' });
      index += 2;
      continue;
    }
    if (character === '/' && next === '*') {
      contexts.push({ kind: 'block-comment' });
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      contexts.push({ kind: 'string', quote: character });
      index += 1;
      continue;
    }
    if (character === '`') {
      contexts.push({ kind: 'template' });
      index += 1;
      continue;
    }
    const expressionEnd = findExpressionLexemeEnd(
      source,
      index,
      '<export declaration>'
    );
    if (expressionEnd !== null) {
      index = expressionEnd;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      if (
        context === root &&
        isFunctionDeclaration &&
        character === '{' &&
        context.stack.length === 0
      ) {
        sawFunctionBody = true;
      }
      context.stack.push(character);
      index += 1;
      continue;
    }
    if (Object.hasOwn(CLOSING_TO_OPENING, character)) {
      if (context.terminator === character && context.stack.length === 0) {
        contexts.pop();
        index += 1;
        continue;
      }
      const opening = context.stack.pop();
      if (opening !== CLOSING_TO_OPENING[character]) {
        throw new Error(`mismatched ${character} at ${index}`);
      }
      index += 1;
      if (
        context === root &&
        isFunctionDeclaration &&
        sawFunctionBody &&
        context.stack.length === 0 &&
        character === '}'
      ) {
        while (source[index] === ' ' || source[index] === '\t') index += 1;
        return source[index] === ';' ? index + 1 : index;
      }
      continue;
    }
    if (context === root && context.stack.length === 0 && character === ';') {
      return index + 1;
    }
    index += 1;
  }

  throw new Error(`unclosed export declaration at ${start}`);
}

function findTagEnd(source, start, sourceName) {
  const root = { kind: 'code', terminator: null, stack: [] };
  const contexts = [root];

  for (
    let index = start;
    index < source.length /* Advance by the parsed token below. */;
  ) {
    const context = contexts.at(-1);
    const character = source[index];
    const next = source[index + 1];

    if (context.kind === 'line-comment') {
      if (character === '\n') contexts.pop();
      else index += 1;
      continue;
    }
    if (context.kind === 'block-comment') {
      if (character === '*' && next === '/') {
        contexts.pop();
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (context.kind === 'string') {
      if (character === '\\') index += 2;
      else if (character === context.quote) {
        contexts.pop();
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (context.kind === 'template') {
      if (character === '\\') {
        index += 2;
      } else if (character === '`') {
        contexts.pop();
        index += 1;
      } else if (character === '$' && next === '{') {
        contexts.push({ kind: 'code', terminator: '}', stack: [] });
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (character === '/' && next === '/') {
      contexts.push({ kind: 'line-comment' });
      index += 2;
      continue;
    }
    if (character === '/' && next === '*') {
      contexts.push({ kind: 'block-comment' });
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      contexts.push({ kind: 'string', quote: character });
      index += 1;
      continue;
    }
    if (character === '`') {
      contexts.push({ kind: 'template' });
      index += 1;
      continue;
    }
    const expressionEnd = findExpressionLexemeEnd(source, index, sourceName);
    if (expressionEnd !== null) {
      index = expressionEnd;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      context.stack.push(character);
      index += 1;
      continue;
    }
    if (Object.hasOwn(CLOSING_TO_OPENING, character)) {
      if (context.terminator === character && context.stack.length === 0) {
        contexts.pop();
        index += 1;
        continue;
      }
      const opening = context.stack.pop();
      if (opening !== CLOSING_TO_OPENING[character]) {
        throw new Error(`${sourceName}: mismatched ${character} at ${index}`);
      }
      index += 1;
      continue;
    }
    if (context === root && context.stack.length === 0 && character === '>') {
      return index + 1;
    }
    index += 1;
  }

  throw new Error(`${sourceName}: unclosed JSX tag at ${start}`);
}

function findCodeExpressionEnd(source, start, sourceName) {
  const root = { kind: 'code', terminator: '}', stack: [] };
  const contexts = [root];

  for (
    let index = start + 1;
    index < source.length /* Advance by the parsed token below. */;
  ) {
    const context = contexts.at(-1);
    const character = source[index];
    const next = source[index + 1];

    if (context.kind === 'line-comment') {
      if (character === '\n') contexts.pop();
      else index += 1;
      continue;
    }
    if (context.kind === 'block-comment') {
      if (character === '*' && next === '/') {
        contexts.pop();
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (context.kind === 'string') {
      if (character === '\\') index += 2;
      else if (character === context.quote) {
        contexts.pop();
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (context.kind === 'template') {
      if (character === '\\') {
        index += 2;
      } else if (character === '`') {
        contexts.pop();
        index += 1;
      } else if (character === '$' && next === '{') {
        contexts.push({ kind: 'code', terminator: '}', stack: [] });
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (character === '/' && next === '/') {
      contexts.push({ kind: 'line-comment' });
      index += 2;
      continue;
    }
    if (character === '/' && next === '*') {
      contexts.push({ kind: 'block-comment' });
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      contexts.push({ kind: 'string', quote: character });
      index += 1;
      continue;
    }
    if (character === '`') {
      contexts.push({ kind: 'template' });
      index += 1;
      continue;
    }
    const expressionEnd = findExpressionLexemeEnd(source, index, sourceName);
    if (expressionEnd !== null) {
      index = expressionEnd;
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      context.stack.push(character);
      index += 1;
      continue;
    }
    if (Object.hasOwn(CLOSING_TO_OPENING, character)) {
      if (context.terminator === character && context.stack.length === 0) {
        contexts.pop();
        index += 1;
        if (contexts.length === 0) return index;
        continue;
      }
      const opening = context.stack.pop();
      if (opening !== CLOSING_TO_OPENING[character]) {
        throw new Error(`${sourceName}: mismatched ${character} at ${index}`);
      }
      index += 1;
      continue;
    }
    index += 1;
  }

  throw new Error(`${sourceName}: unclosed JSX expression at ${start}`);
}

function isLiveDemoOpeningAt(source, index) {
  return (
    source.startsWith('<LiveDemo', index) &&
    /[\s/>]/u.test(source[index + '<LiveDemo'.length] || '')
  );
}

function isLiveDemoClosingAt(source, index) {
  return (
    source.startsWith('</LiveDemo', index) &&
    /[\s>]/u.test(source[index + '</LiveDemo'.length] || '')
  );
}

function findNextLiveDemoTokenInJavaScript(source, start) {
  const contexts = [{ kind: 'code', terminator: null, stack: [] }];

  for (
    let index = start;
    index < source.length /* Advance by the parsed token below. */;
  ) {
    const context = contexts.at(-1);
    const character = source[index];
    const next = source[index + 1];

    if (context.kind === 'line-comment') {
      if (character === '\n') contexts.pop();
      else index += 1;
      continue;
    }
    if (context.kind === 'block-comment') {
      if (character === '*' && next === '/') {
        contexts.pop();
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (context.kind === 'string') {
      if (character === '\\') index += 2;
      else if (character === context.quote) {
        contexts.pop();
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }
    if (context.kind === 'template') {
      if (character === '\\') {
        index += 2;
      } else if (character === '`') {
        contexts.pop();
        index += 1;
      } else if (character === '$' && next === '{') {
        contexts.push({ kind: 'code', terminator: '}', stack: [] });
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }

    if (character === '/' && next === '/') {
      contexts.push({ kind: 'line-comment' });
      index += 2;
      continue;
    }
    if (character === '/' && next === '*') {
      contexts.push({ kind: 'block-comment' });
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      contexts.push({ kind: 'string', quote: character });
      index += 1;
      continue;
    }
    if (character === '`') {
      contexts.push({ kind: 'template' });
      index += 1;
      continue;
    }
    const expressionEnd = findExpressionLexemeEnd(
      source,
      index,
      '<Demo definition>',
      false
    );
    if (expressionEnd !== null) {
      index = expressionEnd;
      continue;
    }
    if (isLiveDemoOpeningAt(source, index)) {
      return { index, closing: false };
    }
    if (isLiveDemoClosingAt(source, index)) {
      return { index, closing: true };
    }
    if (character === '(' || character === '[' || character === '{') {
      context.stack.push(character);
      index += 1;
      continue;
    }
    if (Object.hasOwn(CLOSING_TO_OPENING, character)) {
      if (context.terminator === character && context.stack.length === 0) {
        contexts.pop();
        index += 1;
        continue;
      }
      context.stack.pop();
      index += 1;
      continue;
    }
    index += 1;
  }

  return null;
}

function findLiveDemoClose(source, start, sourceName) {
  for (
    let index = start;
    index < source.length /* Advance by the parsed token below. */;
  ) {
    if (source.startsWith('</LiveDemo', index)) {
      const closeMatch = source.slice(index).match(/^<\/LiveDemo[\t ]*>/u);
      if (!closeMatch) {
        throw new Error(`${sourceName}: malformed LiveDemo closing tag`);
      }
      return { start: index, end: index + closeMatch[0].length };
    }
    if (isLiveDemoOpeningAt(source, index)) {
      throw new Error(`${sourceName}: nested LiveDemo is not supported`);
    }
    if (source[index] === '{') {
      index = findCodeExpressionEnd(source, index, sourceName);
      continue;
    }
    if (source[index] === '<') {
      index = findTagEnd(source, index + 1, sourceName);
      continue;
    }
    index += 1;
  }

  throw new Error(`${sourceName}: unclosed LiveDemo`);
}

function findLiveDemoRanges(source, sourceName, javascript = false) {
  const ranges = [];
  let cursor = 0;

  while (cursor < source.length) {
    const token = javascript
      ? findNextLiveDemoTokenInJavaScript(source, cursor)
      : null;
    const openStart = javascript
      ? token && token.index
      : source.indexOf('<LiveDemo', cursor);
    if (openStart === -1 || openStart === null) break;
    if (javascript && token.closing) {
      throw new Error(`${sourceName}: unprocessed LiveDemo closing tag`);
    }
    if (!isLiveDemoOpeningAt(source, openStart)) {
      cursor = openStart + '<LiveDemo'.length;
      continue;
    }

    const openEnd = findTagEnd(
      source,
      openStart + '<LiveDemo'.length,
      sourceName
    );
    const opening = source.slice(openStart, openEnd);
    if (/\/[\t ]*>$/u.test(opening)) {
      throw new Error(`${sourceName}: self-closing LiveDemo is not supported`);
    }
    const close = findLiveDemoClose(source, openEnd, sourceName);
    ranges.push({
      start: openStart,
      openEnd,
      closeStart: close.start,
      end: close.end,
    });
    cursor = close.end;
  }

  return ranges;
}

function normalizeDemoDefinition(definition, sourceName) {
  const ranges = findLiveDemoRanges(definition, sourceName, true);
  let normalized = '';
  let cursor = 0;

  for (const range of ranges) {
    normalized += definition.slice(cursor, range.start);
    normalized += '<>';
    normalized += definition.slice(range.openEnd, range.closeStart);
    normalized += '</>';
    cursor = range.end;
  }
  normalized += definition.slice(cursor);

  if (findNextLiveDemoTokenInJavaScript(normalized, 0) !== null) {
    throw new Error(`${sourceName}: unprocessed LiveDemo in Demo definition`);
  }
  return normalized;
}

function blankRanges(source, ranges) {
  if (ranges.length === 0) return source;
  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    output += source.slice(cursor, range.start);
    output += source.slice(range.start, range.end).replace(/[^\n]/gu, '');
    cursor = range.end;
  }
  output += source.slice(cursor);
  return output;
}

function collectExportedDemos(source, sourceName = '<source>') {
  const declarationPattern =
    /^ {0,3}export\s+(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b|const\s+([A-Za-z_$][\w$]*)\s*=)/gmu;
  const declarations = [];
  const demos = new Map();
  const supportDefinitions = [];
  let coveredUntil = -1;

  for (const match of source.matchAll(declarationPattern)) {
    const start = match.index;
    if (start < coveredUntil) continue;

    let end;
    try {
      end = findBalancedEnd(source, start);
    } catch (error) {
      throw new Error(`${sourceName}: ${error.message}`, { cause: error });
    }

    const name = match[1] || match[2];
    const definition = source
      .slice(start, end)
      .replace(/^(\s{0,3})export\s+/u, '$1');
    declarations.push({ start, end });
    coveredUntil = end;

    if (isDemoName(name)) {
      if (demos.has(name)) {
        throw new Error(`${sourceName}: duplicate Demo ${name}`);
      }
      demos.set(name, normalizeDemoDefinition(definition, sourceName));
    } else {
      supportDefinitions.push(definition);
    }
  }

  return {
    source: blankRanges(source, declarations),
    demos,
    supportDefinitions,
  };
}

function removeImports(source, sourceName) {
  const ranges = [];
  let coveredUntil = -1;
  for (const match of source.matchAll(/^ {0,3}import\b/gmu)) {
    const start = match.index;
    if (start < coveredUntil) continue;
    let end;
    try {
      end = findBalancedEnd(source, start);
    } catch (error) {
      throw new Error(`${sourceName}: ${error.message}`, { cause: error });
    }
    ranges.push({ start, end });
    coveredUntil = end;
  }
  return blankRanges(source, ranges);
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function trimBlankEdges(value) {
  return value.replace(/^(?:\r?\n)+/u, '').replace(/(?:\r?\n)+[\t ]*$/u, '');
}

function maxBacktickRun(value) {
  let maximum = 0;
  for (const match of value.matchAll(/`+/gu)) {
    maximum = Math.max(maximum, match[0].length);
  }
  return maximum;
}

function makeTsxFence(value, restore) {
  const content = trimBlankEdges(value);
  const fenceLength = Math.max(3, maxBacktickRun(restore(content)) + 1);
  const fence = '`'.repeat(fenceLength);
  return `${fence}tsx\n${content}\n${fence}`;
}

function isInsideRange(index, ranges) {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function assembleMarkdown(parts) {
  const protectedSource = protectCode(parts.join('\n'));
  return protectedSource.restore(
    protectedSource.source.replace(/\n{3,}/gu, '\n\n')
  );
}

function collapseBlankLinesOutsideCode(source) {
  return assembleMarkdown([source]).replace(/^\n+/u, '');
}

function findMarkdownLabelEnd(source, start, limit = source.length) {
  let depth = 0;
  for (let cursor = start; cursor < limit; cursor += 1) {
    const character = source[cursor];
    if (character === '\\') {
      cursor += 1;
    } else if (character === '[') {
      depth += 1;
    } else if (character === ']') {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function isAsciiPunctuation(character) {
  const code = character?.charCodeAt(0);
  return (
    (code >= 0x21 && code <= 0x2f) ||
    (code >= 0x3a && code <= 0x40) ||
    (code >= 0x5b && code <= 0x60) ||
    (code >= 0x7b && code <= 0x7e)
  );
}

function unescapeAsciiPunctuation(value) {
  let output = '';
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    if (value[cursor] === '\\' && isAsciiPunctuation(value[cursor + 1])) {
      cursor += 1;
    }
    output += value[cursor];
  }
  return output;
}

function normalizeReferenceLabel(value) {
  return unescapeAsciiPunctuation(value)
    .trim()
    .replace(/[ \t\r\n]+/gu, ' ')
    .toLowerCase();
}

function skipMarkdownWhitespace(source, start, limit = source.length) {
  let cursor = start;
  while (cursor < limit && /[ \t\r\n]/u.test(source[cursor])) cursor += 1;
  return cursor;
}

function skipHorizontalWhitespace(source, start, limit) {
  let cursor = start;
  while (cursor < limit && /[ \t]/u.test(source[cursor])) cursor += 1;
  return cursor;
}

function scanDelimitedTitle(source, start, limit) {
  const opening = source[start];
  const closing = opening === '(' ? ')' : opening;
  if (opening !== '"' && opening !== "'" && opening !== '(') return -1;

  for (let cursor = start + 1; cursor < limit; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1;
    } else if (source[cursor] === closing) {
      return cursor + 1;
    }
  }
  return -1;
}

function scanInlineLinkDestination(source, openingParenthesis) {
  let cursor = skipMarkdownWhitespace(source, openingParenthesis + 1);
  let targetStart = cursor;
  let targetEnd = cursor;

  if (source[cursor] === '<') {
    targetStart = cursor + 1;
    cursor = targetStart;
    while (cursor < source.length) {
      if (source[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (source[cursor] === '\n' || source[cursor] === '\r') return null;
      if (source[cursor] === '>') break;
      cursor += 1;
    }
    if (source[cursor] !== '>') return null;
    targetEnd = cursor;
    cursor += 1;
  } else {
    let parenthesisDepth = 0;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === '\\') {
        cursor += 2;
        continue;
      }
      if (/[ \t\r\n]/u.test(character)) {
        if (parenthesisDepth !== 0) return null;
        targetEnd = cursor;
        break;
      }
      if (character === '(') {
        parenthesisDepth += 1;
      } else if (character === ')') {
        if (parenthesisDepth === 0) {
          return {
            end: cursor + 1,
            targetEnd: cursor,
            targetStart,
          };
        }
        parenthesisDepth -= 1;
      }
      cursor += 1;
    }
    if (cursor >= source.length) return null;
  }

  cursor = skipMarkdownWhitespace(source, cursor);
  if (source[cursor] === ')') {
    return { end: cursor + 1, targetEnd, targetStart };
  }

  const titleEnd = scanDelimitedTitle(source, cursor, source.length);
  if (titleEnd === -1) return null;
  cursor = skipMarkdownWhitespace(source, titleEnd);
  if (source[cursor] !== ')') return null;
  return { end: cursor + 1, targetEnd, targetStart };
}

function markdownLineRange(source, start) {
  const line = lineAt(source, start);
  return {
    end: start + line.text.length,
    hasLineEnding: line.end < source.length,
    next: line.next,
    start,
  };
}

function scanReferenceTarget(source, start, lineEnd) {
  let cursor = start;
  let targetStart = cursor;
  let targetEnd = cursor;
  if (source[cursor] === '<') {
    targetStart = cursor + 1;
    cursor = targetStart;
    while (cursor < lineEnd) {
      if (source[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (source[cursor] === '>') break;
      cursor += 1;
    }
    if (source[cursor] !== '>') return null;
    targetEnd = cursor;
    cursor += 1;
  } else {
    let parenthesisDepth = 0;
    while (cursor < lineEnd && !/[ \t]/u.test(source[cursor])) {
      if (source[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (source[cursor] === '(') {
        parenthesisDepth += 1;
      } else if (source[cursor] === ')') {
        if (parenthesisDepth === 0) return null;
        parenthesisDepth -= 1;
      }
      cursor += 1;
    }
    if (parenthesisDepth !== 0) return null;
    targetEnd = cursor;
  }
  if (targetStart === targetEnd) return null;
  return { cursor, targetEnd, targetStart };
}

function scanReferenceDefinition(source, lineStart) {
  const firstLine = markdownLineRange(source, lineStart);
  let cursor = lineStart;
  let indentation = 0;
  while (source[cursor] === ' ' && indentation < 4) {
    indentation += 1;
    cursor += 1;
  }
  if (indentation > 3 || source[cursor] !== '[' || source[cursor + 1] === '^') {
    return null;
  }

  const labelStart = cursor + 1;
  const labelEnd = findMarkdownLabelEnd(source, cursor, firstLine.end);
  if (labelEnd <= cursor + 1 || source[labelEnd + 1] !== ':') {
    return null;
  }

  let targetLine = firstLine;
  cursor = skipHorizontalWhitespace(source, labelEnd + 2, targetLine.end);
  if (cursor === targetLine.end) {
    if (!targetLine.hasLineEnding) return null;
    targetLine = markdownLineRange(source, targetLine.next);
    cursor = skipHorizontalWhitespace(source, targetLine.start, targetLine.end);
    if (cursor === targetLine.end) return null;
  }

  const target = scanReferenceTarget(source, cursor, targetLine.end);
  if (target === null) return null;
  cursor = skipHorizontalWhitespace(source, target.cursor, targetLine.end);
  let definitionEnd = targetLine.end;
  if (cursor !== targetLine.end) {
    const titleEnd = scanDelimitedTitle(source, cursor, targetLine.end);
    if (titleEnd === -1) return null;
    cursor = skipHorizontalWhitespace(source, titleEnd, targetLine.end);
    if (cursor !== targetLine.end) return null;
  } else if (targetLine.hasLineEnding) {
    const titleLine = markdownLineRange(source, targetLine.next);
    const titleStart = skipHorizontalWhitespace(
      source,
      titleLine.start,
      titleLine.end
    );
    const titleEnd = scanDelimitedTitle(source, titleStart, titleLine.end);
    if (
      titleEnd !== -1 &&
      skipHorizontalWhitespace(source, titleEnd, titleLine.end) ===
        titleLine.end
    ) {
      definitionEnd = titleLine.end;
    }
  }

  return {
    end: definitionEnd,
    label: normalizeReferenceLabel(source.slice(labelStart, labelEnd)),
    start: lineStart,
    targetEnd: target.targetEnd,
    targetStart: target.targetStart,
  };
}

function findReferenceDefinitionTargets(source) {
  const definitions = [];
  for (
    let lineStart = 0;
    lineStart <= source.length /* Advance by the parsed token below. */;
  ) {
    const newline = source.indexOf('\n', lineStart);
    const definition = scanReferenceDefinition(source, lineStart);
    if (definition !== null) definitions.push(definition);
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return definitions;
}

function recordReferenceUsage(usages, label, isImage) {
  if (label === '') return;
  const usage = usages.get(label) || { image: false, link: false };
  usage[isImage ? 'image' : 'link'] = true;
  usages.set(label, usage);
}

function findLinkTargetsAndReferenceUsages(
  source,
  excludedRanges,
  definitionLabels
) {
  const targets = [];
  const usages = new Map();
  let rangeIndex = 0;

  for (
    let cursor = 0;
    cursor < source.length /* Advance by the parsed token below. */;
  ) {
    while (
      rangeIndex < excludedRanges.length &&
      cursor >= excludedRanges[rangeIndex].end
    ) {
      rangeIndex += 1;
    }
    const excluded = excludedRanges[rangeIndex];
    if (excluded !== undefined && cursor >= excluded.start) {
      cursor = excluded.end;
      continue;
    }
    if (source[cursor] !== '[' || isEscapedAt(source, cursor)) {
      cursor += 1;
      continue;
    }

    const labelEnd = findMarkdownLabelEnd(source, cursor);
    if (labelEnd === -1) {
      cursor += 1;
      continue;
    }
    const isImage =
      cursor > 0 &&
      source[cursor - 1] === '!' &&
      !isEscapedAt(source, cursor - 1);
    const firstLabel = source.slice(cursor + 1, labelEnd);

    if (source[labelEnd + 1] === '(') {
      const link = scanInlineLinkDestination(source, labelEnd + 1);
      if (link === null) {
        cursor = labelEnd + 1;
        continue;
      }
      if (!isImage && link.targetStart !== link.targetEnd) {
        targets.push(link);
      }
      cursor = link.end;
      continue;
    }

    if (source[labelEnd + 1] === '[') {
      const referenceEnd = findMarkdownLabelEnd(source, labelEnd + 1);
      if (referenceEnd !== -1) {
        const explicitLabel = source.slice(labelEnd + 2, referenceEnd);
        const label = normalizeReferenceLabel(
          explicitLabel === '' ? firstLabel : explicitLabel
        );
        if (definitionLabels.has(label)) {
          recordReferenceUsage(usages, label, isImage);
        }
        cursor = referenceEnd + 1;
        continue;
      }
    }

    const shortcutLabel = normalizeReferenceLabel(firstLabel);
    if (definitionLabels.has(shortcutLabel)) {
      recordReferenceUsage(usages, shortcutLabel, isImage);
    }
    cursor = labelEnd + 1;
  }
  return { targets, usages };
}

function rewriteLinkTarget(target, document, routeMap) {
  const semanticTarget = unescapeAsciiPunctuation(target);
  if (
    /^(?:https?:|mailto:)/iu.test(semanticTarget) ||
    semanticTarget.startsWith('#')
  ) {
    return target;
  }

  const fragmentStart = semanticTarget.indexOf('#');
  const targetPath =
    fragmentStart === -1
      ? semanticTarget
      : semanticTarget.slice(0, fragmentStart);
  const fragment =
    fragmentStart === -1 ? '' : semanticTarget.slice(fragmentStart);
  const extensionlessPath = targetPath.replace(/\.mdx?$/iu, '');
  const sourceDirectory = path.posix.dirname(document.sourceRoute);
  const route = extensionlessPath.startsWith('/docs/')
    ? path.posix.normalize(extensionlessPath)
    : path.posix.resolve(sourceDirectory, extensionlessPath);
  const destination = routeMap.resolve(route);
  if (destination === null) {
    throw new Error(`${document.sourceName}: missing internal route ${target}`);
  }

  const outputDirectory = path.posix.dirname(document.outputPath);
  return `${path.posix.relative(
    outputDirectory,
    destination.outputPath
  )}${fragment}`;
}

function rewriteInternalLinks(markdown, document, routeMap) {
  const protectedSource = protectCode(markdown);
  const definitions = findReferenceDefinitionTargets(protectedSource.source);
  const activeDefinitions = new Map();
  for (const definition of definitions) {
    if (!activeDefinitions.has(definition.label)) {
      activeDefinitions.set(definition.label, definition);
    }
  }
  const definitionLabels = new Set(activeDefinitions.keys());
  const links = findLinkTargetsAndReferenceUsages(
    protectedSource.source,
    definitions,
    definitionLabels
  );
  const referencedDefinitions = [];
  for (const definition of activeDefinitions.values()) {
    const usage = links.usages.get(definition.label);
    if (usage?.link && usage.image) {
      throw new Error(
        `${document.sourceName}: reference label ${definition.label} is used by both link and image`
      );
    }
    if (usage?.link) referencedDefinitions.push(definition);
  }
  const targets = [...referencedDefinitions, ...links.targets].sort(
    (left, right) => left.targetStart - right.targetStart
  );

  let rewritten = '';
  let cursor = 0;
  for (const target of targets) {
    rewritten += protectedSource.source.slice(cursor, target.targetStart);
    const originalTarget = protectedSource.source.slice(
      target.targetStart,
      target.targetEnd
    );
    rewritten += rewriteLinkTarget(originalTarget, document, routeMap);
    cursor = target.targetEnd;
  }
  rewritten += protectedSource.source.slice(cursor);
  return protectedSource.restore(rewritten);
}

function convertMdxBody(source, sourceName) {
  const protectedSource = protectCode(source);
  const collected = collectExportedDemos(protectedSource.source, sourceName);
  let body = removeImports(collected.source, sourceName);

  const unsupportedExport = /^ {0,3}export\b/mu.exec(body);
  if (unsupportedExport) {
    const restoredPrefix = protectedSource.restore(
      body.slice(0, unsupportedExport.index)
    );
    throw new Error(
      `${sourceName}: unsupported export at ${lineNumberAt(
        restoredPrefix,
        restoredPrefix.length
      )}`
    );
  }

  const liveDemoRanges = findLiveDemoRanges(body, sourceName);
  const replacements = liveDemoRanges.map((range) => ({
    start: range.start,
    end: range.end,
    code: body.slice(range.openEnd, range.closeStart),
  }));

  const demoInvocationPattern = new RegExp(
    `<(${DEMO_NAME_PATTERN})\\s*/>`,
    'gu'
  );
  for (const match of body.matchAll(demoInvocationPattern)) {
    const start = match.index;
    if (isInsideRange(start, liveDemoRanges)) continue;
    const name = match[1];
    const definition = collected.demos.get(name);
    if (definition === undefined) {
      throw new Error(`${sourceName}: unknown Demo ${name}`);
    }
    replacements.push({
      start,
      end: start + match[0].length,
      code: definition,
    });
  }

  replacements.sort((left, right) => left.start - right.start);
  if (collected.supportDefinitions.length > 0 && replacements.length === 0) {
    throw new Error(`${sourceName}: orphan support definition`);
  }

  let output = '';
  let cursor = 0;
  let supportEmitted = false;
  for (const replacement of replacements) {
    output += body.slice(cursor, replacement.start);
    const sections = [];
    if (!supportEmitted && collected.supportDefinitions.length > 0) {
      sections.push(trimBlankEdges(collected.supportDefinitions.join('\n\n')));
      supportEmitted = true;
    }
    sections.push(trimBlankEdges(replacement.code));
    output += makeTsxFence(sections.join('\n\n'), protectedSource.restore);
    cursor = replacement.end;
  }
  output += body.slice(cursor);

  const restoredOutput = protectedSource.restore(output);
  const maskedOutput = protectCode(restoredOutput).source;
  if (/<\/?LiveDemo\b/u.test(maskedOutput)) {
    throw new Error(`${sourceName}: unprocessed LiveDemo`);
  }
  const remainingDemo = findUnprocessedDemo(restoredOutput);
  if (remainingDemo !== null) {
    if (!collected.demos.has(remainingDemo)) {
      throw new Error(`${sourceName}: unknown Demo ${remainingDemo}`);
    }
    throw new Error(`${sourceName}: unprocessed Demo ${remainingDemo}`);
  }

  return collapseBlankLinesOutsideCode(restoredOutput);
}

function findUnprocessedDemo(markdown) {
  const match = UNPROCESSED_DEMO_REGEXP.exec(protectCode(markdown).source);
  return match === null ? null : match[1];
}

module.exports = {
  assembleMarkdown,
  collectExportedDemos,
  convertMdxBody,
  findBalancedEnd,
  findUnprocessedDemo,
  normalizeDemoDefinition,
  parseFrontmatter,
  protectCode,
  rewriteInternalLinks,
};
