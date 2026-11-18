import type { Decision, PermissionRequest, PermissionRule } from "./types.js";
import type { PathSandbox } from "./paths.js";

/**
 * 参数级规则 DSL。
 *
 * 第 8 篇的角色白名单是**工具名级**的：给不给某个工具。
 * 但真实世界的权限几乎都是参数级的：
 *  - readFile 允许，但只允许读 data/ 下的文本文件；
 *  - webFetch 允许，但只允许访问 example.com；
 *  - writeFile 允许写 data/，但写 .ts 源码要人工确认。
 *
 * 所以规则要能表达「工具名 + 参数值 → 决策」。
 * 本模块提供一组构造器，把这个表达写成可读、可组合、可单测的形式。
 *
 * 匹配器（matcher）统一签名：(req) => boolean。
 * 它们是纯函数，不做 I/O、不抛异常（抛异常会被策略引擎当作「未命中」处理）。
 */

/**
 * 按路径从参数里取值。
 *
 * 支持点号与数组下标：`a.b`、`a[0].b`、`a.b[2]`。
 * 路径不存在时返回 undefined（而不是抛错）——参数级规则经常要处理可选参数。
 */
export function getArg(args: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  const segments: string[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    segments.push(m[1] ?? m[2] ?? "");
  }
  let cur: unknown = args;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** 工具名精确匹配 */
export function toolIs(name: string): (req: PermissionRequest) => boolean {
  return (req) => req.tool === name;
}

/** 工具名前缀匹配（例如所有 mcp__ 开头的外部工具） */
export function toolStartsWith(prefix: string): (req: PermissionRequest) => boolean {
  return (req) => req.tool.startsWith(prefix);
}

/** 参数存在（哪怕是 undefined 键也算存在） */
export function argExists(path: string): (req: PermissionRequest) => boolean {
  return (req) => getArg(req.args, path) !== undefined;
}

/** 参数等于某个值 */
export function argEquals(path: string, value: unknown): (req: PermissionRequest) => boolean {
  return (req) => getArg(req.args, path) === value;
}

/** 参数属于某个集合 */
export function argIn(path: string, values: readonly unknown[]): (req: PermissionRequest) => boolean {
  return (req) => values.includes(getArg(req.args, path));
}

/** 参数匹配正则 */
export function argMatches(path: string, re: RegExp): (req: PermissionRequest) => boolean {
  return (req) => {
    const v = getArg(req.args, path);
    return typeof v === "string" && re.test(v);
  };
}

/** 参数以指定前缀开头 */
export function argStartsWith(
  path: string,
  prefix: string,
): (req: PermissionRequest) => boolean {
  return (req) => {
    const v = getArg(req.args, path);
    return typeof v === "string" && v.startsWith(prefix);
  };
}

/** 参数是某个 URL，且主机名在白名单内 */
export function argUrlHostIn(
  path: string,
  hosts: readonly string[],
): (req: PermissionRequest) => boolean {
  return (req) => {
    const v = getArg(req.args, path);
    if (typeof v !== "string") return false;
    try {
      const u = new URL(v);
      return hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    } catch {
      return false;
    }
  };
}

/** 参数是一个落在沙箱内的路径 */
export function argPathWithin(
  path: string,
  sandbox: PathSandbox,
  baseDir?: string,
): (req: PermissionRequest) => boolean {
  return (req) => {
    const v = getArg(req.args, path);
    if (typeof v !== "string") return false;
    return sandbox.check(v, baseDir).ok;
  };
}

/** 与（全部满足） */
export function allOf(
  ...matchers: Array<(req: PermissionRequest) => boolean>
): (req: PermissionRequest) => boolean {
  return (req) => matchers.every((m) => safeMatch(m, req));
}

/** 或（任一满足） */
export function anyOf(
  ...matchers: Array<(req: PermissionRequest) => boolean>
): (req: PermissionRequest) => boolean {
  return (req) => matchers.some((m) => safeMatch(m, req));
}

/** 非 */
export function not(
  matcher: (req: PermissionRequest) => boolean,
): (req: PermissionRequest) => boolean {
  return (req) => !safeMatch(matcher, req);
}

/**
 * 安全地调用匹配器：匹配器抛异常时视为「未命中」。
 *
 * 这一层很重要：规则求值必须永远不炸。某条规则写错了（比如正则非法），
 * 正确行为是「这条规则不生效」，而不是「整个授权流程崩溃」。
 * 真要崩溃了，攻击者只要构造一个能触发规则异常的参数就能拿到执行权。
 */
function safeMatch(
  matcher: (req: PermissionRequest) => boolean,
  req: PermissionRequest,
): boolean {
  try {
    return matcher(req);
  } catch {
    return false;
  }
}

export interface RuleOptions {
  id: string;
  description: string;
  decision: Decision;
  when: (req: PermissionRequest) => boolean;
  reason?: string;
}

/** 构造一条规则 */
export function rule(options: RuleOptions): PermissionRule {
  return {
    id: options.id,
    description: options.description,
    decision: options.decision,
    when: options.when,
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
  };
}

/** 构造一条「命中即放行」的规则 */
export function allowRule(
  id: string,
  description: string,
  when: (req: PermissionRequest) => boolean,
  reason?: string,
): PermissionRule {
  return rule({ id, description, decision: "allow", when, reason });
}

/** 构造一条「命中即拒绝」的规则 */
export function denyRule(
  id: string,
  description: string,
  when: (req: PermissionRequest) => boolean,
  reason?: string,
): PermissionRule {
  return rule({ id, description, decision: "deny", when, reason });
}

/** 构造一条「命中即转人工」的规则 */
export function askRule(
  id: string,
  description: string,
  when: (req: PermissionRequest) => boolean,
  reason?: string,
): PermissionRule {
  return rule({ id, description, decision: "ask", when, reason });
}
