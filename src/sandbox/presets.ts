import type { PermissionRequest, PermissionRule } from "./types.js";
import { PolicyEngine } from "./policy.js";
import {
  allOf,
  allowRule,
  anyOf,
  argStartsWith,
  argUrlHostIn,
  askRule,
  denyRule,
  toolIs,
} from "./rules.js";
import { PathSandbox } from "./paths.js";
import { defaultFileSandbox } from "./defaults.js";

/**
 * 预设策略：一套能直接用的默认权限配置。
 *
 * 策略的本质是「谁、在什么条件下、能做什么」。把默认配置写成代码而不是
 * YAML/JSON，有三个好处：类型检查能过、规则之间可以复用匹配器、
 * 复杂条件（组合、路径沙箱）不需要自己发明一套表达式语言。
 *
 * 默认策略的取舍：
 *  - 只读本地资料 → 放行；
 *  - 读疑似凭据的文件 → 直接拒绝，不问人（问了也没用，不该读）；
 *  - 写文件、删文件、执行命令 → 问人；
 *  - 抓网页：白名单域名放行，其他域名问人；
 *  - 其他工具 → 拒绝（默认拒绝兜底）。
 */

export interface SandboxPresetOptions {
  /** 文件类工具的路径沙箱，默认限制在 data/ 目录内 */
  fileSandbox?: PathSandbox;
  /** webFetch 免审批的域名白名单 */
  allowedFetchHosts?: string[];
  /** 敏感文件名模式（命中即拒绝读取） */
  secretPatterns?: RegExp[];
}

/** 默认的敏感文件模式：密钥、证书、环境变量 */
const DEFAULT_SECRET_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])id_(rsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|keystore)$/i,
  /(^|[\\/])credentials?(\.json|\.ini)?$/i,
];

/**
 * 判断路径参数是否指向疑似敏感文件。
 *
 * 这里做的是「路径字符串匹配」而不是「读文件看内容」——
 * 权限判定必须在读文件之前完成，否则「读」这个动作本身就已经越权了。
 */
function isSecretPath(pathValue: unknown, patterns: RegExp[]): boolean {
  if (typeof pathValue !== "string") return false;
  const normalized = pathValue.replace(/\\/g, "/");
  return patterns.some((p) => p.test(normalized));
}

export function defaultSandboxRules(options: SandboxPresetOptions = {}): PermissionRule[] {
  const sandbox = options.fileSandbox ?? defaultFileSandbox();
  const hosts = options.allowedFetchHosts ?? ["example.com"];
  const secrets = options.secretPatterns ?? DEFAULT_SECRET_PATTERNS;

  /** readFile 用 path 参数，searchFiles 用 root 参数，两个都算「路径参数」 */
  const pathParamOf = (req: PermissionRequest): unknown => req.args.path ?? req.args.root;

  const isReadTool = anyOf(toolIs("readFile"), toolIs("searchFiles"));
  const isFileTool = anyOf(
    toolIs("readFile"),
    toolIs("searchFiles"),
    toolIs("writeFile"),
    toolIs("deleteFile"),
  );

  const looksSecret = (req: PermissionRequest): boolean =>
    isSecretPath(pathParamOf(req), secrets);

  const insideSandbox = (req: PermissionRequest): boolean => {
    const v = pathParamOf(req);
    return typeof v === "string" && sandbox.check(v).ok;
  };

  const outsideSandbox = (req: PermissionRequest): boolean => {
    const v = pathParamOf(req);
    return typeof v === "string" && !sandbox.check(v).ok;
  };

  return [
    // ① 疑似凭据文件：直接拒绝，连问都不问
    denyRule(
      "deny-secret-file",
      "读取疑似凭据/密钥的文件一律拒绝",
      allOf(isReadTool, looksSecret),
      "该路径疑似包含密钥或凭据，禁止读取",
    ),

    // ② 路径越出沙箱：拒绝
    denyRule(
      "deny-outside-sandbox",
      "访问沙箱目录之外的文件一律拒绝",
      allOf(isFileTool, outsideSandbox),
      "路径超出沙箱允许范围",
    ),

    // ③ 沙箱内的只读检索：放行
    allowRule(
      "allow-read-in-sandbox",
      "允许在沙箱目录内检索与读取文件",
      allOf(isReadTool, insideSandbox),
      "只读操作且路径在沙箱内",
    ),

    // ④ 纯计算：放行
    allowRule("allow-calculator", "允许算术计算", toolIs("calculator"), "无副作用"),

    // ⑤ 已知域名抓取：放行
    allowRule(
      "allow-fetch-known-host",
      "允许抓取白名单域名",
      allOf(toolIs("webFetch"), argUrlHostIn("url", hosts)),
      `域名在白名单 [${hosts.join(", ")}] 内`,
    ),

    // ⑥ 未知域名抓取：问人
    askRule(
      "ask-fetch-unknown-host",
      "抓取非白名单域名需要人工确认",
      toolIs("webFetch"),
      "抓取外部网站会向第三方发起请求，请人工确认目标域名是否可信",
    ),

    // ⑦ 写文件：问人
    askRule(
      "ask-write-file",
      "写文件需要人工确认",
      toolIs("writeFile"),
      "写文件会产生副作用，请人工确认写入内容与路径",
    ),

    // ⑧ 删文件：问人
    askRule(
      "ask-delete-file",
      "删除文件需要人工确认",
      toolIs("deleteFile"),
      "删除文件不可逆，请人工确认路径",
    ),

    // ⑨ 执行命令：问人
    askRule(
      "ask-run-command",
      "执行外部命令需要人工确认",
      toolIs("runCommand"),
      "执行外部命令风险最高，请人工确认命令内容",
    ),

    // ⑩ 写代码类文件：即使在沙箱内也要问人
    askRule(
      "ask-write-source-code",
      "写入代码类文件需要人工确认",
      allOf(toolIs("writeFile"), argStartsWith("path", "src/")),
      "改动源码影响面更大，请人工确认",
    ),
  ];
}

/** 用预设规则构造一个策略引擎 */
export function defaultSandboxPolicy(options: SandboxPresetOptions = {}): PolicyEngine {
  return new PolicyEngine(defaultSandboxRules(options), {
    name: "default-sandbox",
    defaultDecision: "deny",
    defaultReason: "默认策略中没有允许该操作的规则，按拒绝处理",
  });
}
