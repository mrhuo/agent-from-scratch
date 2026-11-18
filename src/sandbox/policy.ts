import type { PermissionDecision, PermissionRequest, PermissionRule, Policy } from "./types.js";

/**
 * 策略引擎：把「一堆规则」变成「一个决策」。
 *
 * 三条设计原则：
 *
 *  1. **顺序求值，第一条命中即生效。** 规则表从上到下读，像一串 if。
 *     这让策略文件读起来就是一段可读的裁决逻辑：先写窄的例外，再写宽的通则。
 *
 *  2. **默认拒绝（fail-closed）。** 没有任何规则命中 → 拒绝。
 *     漏配一条规则的后果是「这个操作被挡住」，而不是「这个操作被放行」。
 *     安全系统的默认值必须倒向安全。
 *
 *  3. **规则异常 = 未命中。** 规则里的匹配器抛异常时跳过这条规则，
 *     继续往下匹配；但无论后面发生什么，最终都不会因为异常而放行。
 */

export interface PolicyEngineOptions {
  /** 规则名（写进审计日志，便于定位是哪套策略在裁决） */
  name?: string;
  /** 无规则命中时的默认决策，默认 deny */
  defaultDecision?: PermissionDecision["decision"];
  /** 无规则命中时的默认理由 */
  defaultReason?: string;
  /** 规则求值抛错时的回调（用于告警） */
  onRuleError?: (ruleId: string, error: unknown) => void;
}

export class PolicyEngine implements Policy {
  readonly name: string;
  private readonly rules: PermissionRule[];
  private readonly defaultDecision: PermissionDecision["decision"];
  private readonly defaultReason: string;
  private readonly onRuleError?: (ruleId: string, error: unknown) => void;

  constructor(rules: PermissionRule[], options: PolicyEngineOptions = {}) {
    this.rules = rules;
    this.name = options.name ?? "policy";
    this.defaultDecision = options.defaultDecision ?? "deny";
    this.defaultReason = options.defaultReason ?? "没有任何规则允许该操作";
    this.onRuleError = options.onRuleError;
  }

  /** 当前规则表（只读副本） */
  listRules(): PermissionRule[] {
    return [...this.rules];
  }

  evaluate(req: PermissionRequest): PermissionDecision {
    for (const r of this.rules) {
      let hit = false;
      try {
        hit = r.when(req);
      } catch (err) {
        // 规则本身有问题：跳过它，并把错误交给上层告警。
        // 关键点：绝不能因为异常而「当作命中」或「直接放行」。
        this.onRuleError?.(r.id, err);
        continue;
      }
      if (hit) {
        return {
          decision: r.decision,
          reason: r.reason ?? r.description,
          ruleId: r.id,
        };
      }
    }
    return {
      decision: this.defaultDecision,
      reason: this.defaultReason,
      ruleId: `${this.name}:default`,
    };
  }
}

/**
 * 合并多套策略，取最严格的那个决策。
 *
 * 优先级：deny > ask > allow。
 *
 * 典型用法：全局策略（组织级红线）+ 角色策略（当前角色的授权范围）。
 * 只要任何一层说不，两层合起来也是 deny——这正是「红线不可被局部策略覆盖」
 * 的实现方式。
 */
export function strictestOf(policies: Policy[], name = "strictest"): Policy {
  const rank: Record<PermissionDecision["decision"], number> = {
    allow: 0,
    ask: 1,
    deny: 2,
  };
  return {
    name,
    evaluate(req: PermissionRequest): PermissionDecision {
      let worst: PermissionDecision = {
        decision: "allow",
        reason: "所有策略都放行",
      };
      for (const p of policies) {
        let d: PermissionDecision;
        try {
          d = p.evaluate(req);
        } catch (err) {
          // 某一层策略崩了：整体视为 deny，不因为下游故障而放行
          d = { decision: "deny", reason: `策略 ${p.name} 求值异常，已按拒绝处理`, ruleId: p.name };
        }
        if (rank[d.decision] > rank[worst.decision]) {
          worst = d;
        }
      }
      return worst;
    },
  };
}

/** 一律拒绝的策略：给「不该持有任何工具的角色」用 */
export function denyAllPolicy(reason = "该角色不持有任何工具授权"): Policy {
  return {
    name: "deny-all",
    evaluate(): PermissionDecision {
      return { decision: "deny", reason, ruleId: "deny-all" };
    },
  };
}
