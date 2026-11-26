import { readFile } from "node:fs/promises";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

// R5-NEW-11 ⑧ (fifth review, 2026-11-25): Node 26 no longer has --experimental-transform-types, and Node 26's
// stripTypeScriptTypes only accepts mode: "strip", which rejects TypeScript parameter properties. Prefer Node's native
// transform mode when available, otherwise lower constructor parameter properties and strip types.
const NATIVE_TRANSFORM = process.features?.typescript === "transform";

function skipQuotedOrComment(source, index) {
  const ch = source[index];
  const next = source[index + 1];
  if (ch === "/" && next === "/") {
    const end = source.indexOf("\n", index + 2);
    return end === -1 ? source.length : end + 1;
  }
  if (ch === "/" && next === "*") {
    const end = source.indexOf("*/", index + 2);
    return end === -1 ? source.length : end + 2;
  }
  if (ch === "'" || ch === '"' || ch === "`") {
    let i = index + 1;
    while (i < source.length) {
      if (source[i] === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`" && source[i] === "$" && source[i + 1] === "{") {
        i = findMatchingDelimiter(source, i + 1, "{", "}") + 1;
        continue;
      }
      if (source[i] === ch) return i + 1;
      i += 1;
    }
    return source.length;
  }
  return index;
}

function findMatchingDelimiter(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const skipped = skipQuotedOrComment(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (source[i] === openChar) depth += 1;
    else if (source[i] === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function splitTopLevelParams(paramSlice) {
  const ranges = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let angle = 0;
  let i = 0;
  while (i < paramSlice.length) {
    const skipped = skipQuotedOrComment(paramSlice, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = paramSlice[i];
    if (ch === "(") paren += 1;
    else if (ch === ")" && paren > 0) paren -= 1;
    else if (ch === "[") bracket += 1;
    else if (ch === "]" && bracket > 0) bracket -= 1;
    else if (ch === "{") brace += 1;
    else if (ch === "}" && brace > 0) brace -= 1;
    else if (ch === "<") angle += 1;
    else if (ch === ">" && paramSlice[i - 1] !== "=" && angle > 0) angle -= 1;
    else if (ch === "," && paren === 0 && bracket === 0 && brace === 0 && angle === 0) {
      ranges.push([start, i]);
      start = i + 1;
    }
    i += 1;
  }
  ranges.push([start, paramSlice.length]);
  return ranges;
}

function findSuperInsertOffset(bodySlice) {
  let i = 1;
  const end = bodySlice.length - 1;
  while (i < end) {
    const skipped = skipQuotedOrComment(bodySlice, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (
      bodySlice.startsWith("super", i) &&
      !/[\w$]/.test(bodySlice[i - 1] ?? "") &&
      !/[\w$]/.test(bodySlice[i + 5] ?? "")
    ) {
      let j = i + 5;
      while (j < end) {
        const s2 = skipQuotedOrComment(bodySlice, j);
        if (s2 !== j) {
          j = s2;
          continue;
        }
        if (/\s/.test(bodySlice[j])) {
          j += 1;
          continue;
        }
        break;
      }
      if (bodySlice[j] === "(") {
        const closeParen = findMatchingDelimiter(bodySlice, j, "(", ")");
        if (closeParen !== -1) {
          let after = closeParen + 1;
          while (after < end && /[ \t]/.test(bodySlice[after])) after += 1;
          if (bodySlice[after] === ";") return after + 1;
          return closeParen + 1;
        }
      }
    }
    i += 1;
  }
  return 1;
}

function lowerParameterProperties(source) {
  if (!/\bconstructor\b/.test(source)) return source;
  let result = "";
  let cursor = 0;
  let i = 0;
  while (i < source.length) {
    const skipped = skipQuotedOrComment(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (
      source.startsWith("constructor", i) &&
      !/[\w$.]/.test(source[i - 1] ?? "") &&
      !/[\w$]/.test(source[i + 11] ?? "")
    ) {
      let j = i + 11;
      while (j < source.length) {
        const s2 = skipQuotedOrComment(source, j);
        if (s2 !== j) {
          j = s2;
          continue;
        }
        if (/\s/.test(source[j])) {
          j += 1;
          continue;
        }
        break;
      }
      if (source[j] === "(") {
        const closeParen = findMatchingDelimiter(source, j, "(", ")");
        if (closeParen !== -1) {
          let bodyOpen = closeParen + 1;
          while (bodyOpen < source.length) {
            const s3 = skipQuotedOrComment(source, bodyOpen);
            if (s3 !== bodyOpen) {
              bodyOpen = s3;
              continue;
            }
            if (/\s/.test(source[bodyOpen])) {
              bodyOpen += 1;
              continue;
            }
            break;
          }
          if (source[bodyOpen] === "{") {
            const bodyClose = findMatchingDelimiter(source, bodyOpen, "{", "}");
            if (bodyClose !== -1) {
              const paramSlice = source.slice(j + 1, closeParen);
              const ranges = splitTopLevelParams(paramSlice);
              const props = [];
              let rewrittenParams = "";
              let paramCursor = 0;
              for (const [pStart, pEnd] of ranges) {
                const rawParam = paramSlice.slice(pStart, pEnd);
                const match = rawParam.match(
                  /^((?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*)((?:(?:public|private|protected|readonly|override)\s+)+)([A-Za-z_$][\w$]*)/,
                );
                rewrittenParams += paramSlice.slice(paramCursor, pStart);
                if (match) {
                  props.push(match[3]);
                  const blankedModifiers = match[2].replace(/[^\n]/g, " ");
                  rewrittenParams += match[1] + blankedModifiers + rawParam.slice(match[1].length + match[2].length);
                } else {
                  rewrittenParams += rawParam;
                }
                paramCursor = pEnd;
              }
              rewrittenParams += paramSlice.slice(paramCursor);
              if (props.length > 0) {
                const bodySlice = source.slice(bodyOpen, bodyClose + 1);
                const insertAt = findSuperInsertOffset(bodySlice);
                const prefix = insertAt > 1 && bodySlice[insertAt - 1] !== ";" ? ";" : "";
                const assignments = prefix + props.map((name) => `this.${name}=${name};`).join("");
                const rewrittenBody = bodySlice.slice(0, insertAt) + assignments + bodySlice.slice(insertAt);
                result += source.slice(cursor, j + 1) + rewrittenParams + source.slice(closeParen, bodyOpen) + rewrittenBody;
                cursor = bodyClose + 1;
                i = cursor;
                continue;
              }
            }
          }
        }
      }
    }
    i += 1;
  }
  return cursor === 0 ? source : result + source.slice(cursor);
}

let supportsNativeTransformMode = false;

function createTypeTransformer() {
  if (typeof nodeModule.stripTypeScriptTypes !== "function") return null;
  try {
    nodeModule.stripTypeScriptTypes("", { mode: "transform" });
    supportsNativeTransformMode = true;
    return (source, url) => nodeModule.stripTypeScriptTypes(source, { mode: "transform", sourceUrl: url });
  } catch {
    return (source, url) =>
      nodeModule.stripTypeScriptTypes(lowerParameterProperties(source), { mode: "strip", sourceUrl: url });
  }
}

export function stripTypeScriptTypesCompat(source, options) {
  if (supportsNativeTransformMode || options?.mode !== "transform") {
    return nodeModule.stripTypeScriptTypes(source, options);
  }
  const { mode: _mode, ...rest } = options;
  return nodeModule.stripTypeScriptTypes(lowerParameterProperties(source), { ...rest, mode: "strip" });
}

const transformTypes = createTypeTransformer();
const SHIM_MODULE_URL = "pipi-node-module:shim";
const LOADER_URL = import.meta.url;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "scripting") {
    return {
      shortCircuit: true,
      url: new URL("../tests/scripting-module-stub.mjs", import.meta.url).href,
    };
  }
  if (
    !supportsNativeTransformMode &&
    (specifier === "node:module" || specifier === "module") &&
    context.parentURL &&
    context.parentURL !== LOADER_URL &&
    context.parentURL !== SHIM_MODULE_URL
  ) {
    return { shortCircuit: true, url: SHIM_MODULE_URL };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      (error?.code !== "ERR_MODULE_NOT_FOUND" &&
        error?.code !== "ERR_UNSUPPORTED_DIR_IMPORT") ||
      !specifier.startsWith(".") ||
      /\.[cm]?[jt]sx?$/.test(specifier)
    ) {
      throw error;
    }
    return nextResolve(`${specifier}.ts`, context);
  }
}

export async function load(url, context, nextLoad) {
  if (url === SHIM_MODULE_URL) {
    const exportsList = Object.keys(nodeModule).filter(
      (key) => key !== "default" && key !== "stripTypeScriptTypes",
    );
    const reexports = exportsList.length ? `export { ${exportsList.join(", ")} } from "node:module";\n` : "";
    return {
      format: "module",
      shortCircuit: true,
      source:
        `import rawModule from "node:module";\n` +
        `import { stripTypeScriptTypesCompat as stripTypeScriptTypes } from ${JSON.stringify(LOADER_URL)};\n` +
        reexports +
        `export { stripTypeScriptTypes };\n` +
        `export default rawModule;\n`,
    };
  }
  if (NATIVE_TRANSFORM || !transformTypes || !url.startsWith("file:") || !/\.[cm]?ts$/.test(new URL(url).pathname)) {
    return nextLoad(url, context);
  }
  const source = await readFile(fileURLToPath(url), "utf8");
  return { format: "module", source: transformTypes(source, url), shortCircuit: true };
}
