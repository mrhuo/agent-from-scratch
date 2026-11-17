import { z } from "zod";

/**
 * 把 Zod schema 转换成 OpenAI function-calling 用的 JSON Schema。
 *
 * 为什么不直接手写 JSON Schema？因为那样会有「两份真相」：一份给模型看的
 * parameters JSON Schema，一份运行时校验——两者极易漂移。用 Zod 定义一次，
 * 运行时校验和「喂给模型的描述」都由它生成，永远一致。
 *
 * 本转换器只覆盖本系列工具用到的子集：string / number / boolean / array /
 * enum / object / optional / default / union，足以覆盖后续所有真工具。
 * 若你的工具用到更复杂的 Zod 类型，直接换成社区库 `zod-to-json-schema` 即可，
 * 接口完全一致（都是 zodToJsonSchema(schema)）。
 */

export type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  return convert(schema);
}

function desc(s: unknown): string | undefined {
  const d = (s as { _def?: { description?: string }; description?: string })._def
    ?.description;
  if (typeof d === "string" && d.length > 0) return d;
  const d2 = (s as { description?: string }).description;
  if (typeof d2 === "string" && d2.length > 0) return d2;
  return undefined;
}

function withDesc(s: z.ZodTypeAny, o: JsonSchema): JsonSchema {
  const d = desc(s);
  if (d) o.description = d;
  return o;
}

function getShape(s: z.ZodObject<z.ZodRawShape>): z.ZodRawShape {
  // 公开 getter shape 在多数版本返回 shape 对象；部分版本把 _def.shape 存成函数，
  // 这里两种都兼容，最后兜底为空对象。
  const shape = (s as { shape?: unknown }).shape;
  if (shape && typeof shape === "object" && !Array.isArray(shape)) {
    return shape as z.ZodRawShape;
  }
  const defShape = (s._def as { shape?: unknown }).shape;
  if (typeof defShape === "function") return (defShape as () => z.ZodRawShape)();
  if (defShape && typeof defShape === "object" && !Array.isArray(defShape)) {
    return defShape as z.ZodRawShape;
  }
  return {};
}

function unwrapOptional(s: z.ZodTypeAny): { schema: z.ZodTypeAny; optional: boolean } {
  if (s instanceof z.ZodOptional) {
    return { schema: s._def.innerType as z.ZodTypeAny, optional: true };
  }
  if (s instanceof z.ZodDefault) {
    return { schema: s._def.innerType as z.ZodTypeAny, optional: true };
  }
  return { schema: s, optional: false };
}

function convert(s: z.ZodTypeAny): JsonSchema {
  if (s instanceof z.ZodString) return withDesc(s, { type: "string" });
  if (s instanceof z.ZodNumber) return withDesc(s, { type: "number" });
  if (s instanceof z.ZodBoolean) return withDesc(s, { type: "boolean" });

  if (s instanceof z.ZodEnum) {
    // _def.values 是允许的枚举值数组
    return withDesc(s, { type: "string", enum: [...s._def.values] });
  }

  if (s instanceof z.ZodLiteral) {
    return withDesc(s, { type: "string", enum: [String(s._def.value)] });
  }

  if (s instanceof z.ZodArray) {
    return withDesc(s, {
      type: "array",
      items: convert(s._def.type as z.ZodTypeAny),
    });
  }

  if (s instanceof z.ZodObject) {
    const shape = getShape(s);
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      const unwrapped = unwrapOptional(val as z.ZodTypeAny);
      // 用「原始」属性（保留 optional 包裹）去转换，这样外层写在 .optional() 之后的
      // .describe() 描述不会在剥离 optional 时丢失；unwrapped 只用于决定 required。
      properties[key] = convert(val as z.ZodTypeAny);
      if (!unwrapped.optional) required.push(key);
    }
    const o: JsonSchema = { type: "object", properties, required };
    return withDesc(s, o);
  }

  if (s instanceof z.ZodUnion) {
    // _def.options 是分支数组，转成 anyOf
    const options = (s._def.options as z.ZodTypeAny[]).map(convert);
    return withDesc(s, { anyOf: options });
  }

  if (s instanceof z.ZodOptional) {
    const inner = convert(s._def.innerType as z.ZodTypeAny);
    const d = desc(s);
    if (d) inner.description = d;
    return inner;
  }

  if (s instanceof z.ZodDefault) {
    const inner = convert(s._def.innerType as z.ZodTypeAny);
    const d = desc(s);
    if (d) inner.description = d;
    return inner;
  }

  // 兜底：未知类型当作自由字符串，保证生成的 schema 始终合法
  return withDesc(s, { type: "string" });
}

/**
 * 用原生 JSON Schema 校验一组参数。
 *
 * 为什么需要它：第 3 篇确立了「参数用 Zod 定义一次，校验与喂给模型的 schema 同源」。
 * 但第 9 篇接的 MCP 工具，参数 schema 是**外部服务给定的**，我们既不能改写它，
 * 也不该把它转成 Zod（转换本身就是一层可能出错的翻译）。于是对这类工具，
 * 校验直接按它自带的 JSON Schema 走——这正是 JSON Schema 的本职。
 *
 * 覆盖 MCP inputSchema 的常用子集：object / string / number / integer / boolean /
 * array / object / enum / required / additionalProperties。
 */
export interface JsonSchemaCheck {
  ok: boolean;
  errors: string[];
}

export function validateAgainstJsonSchema(schema: JsonSchema, args: unknown): JsonSchemaCheck {
  const errors: string[] = [];

  // 顶层按对象处理（MCP 工具的参数一律是对象）
  if (schema.type === "object" || schema.properties) {
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return { ok: false, errors: ["(root): 参数必须是 JSON 对象"] };
    }
    const obj = args as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

    for (const key of required) {
      if (!(key in obj) || obj[key] === undefined) {
        errors.push(`${key}: 缺少必填参数`);
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      const sub = properties[key];
      if (!sub) {
        if (schema.additionalProperties === false) {
          errors.push(`${key}: 不允许的额外参数`);
        }
        continue;
      }
      errors.push(...checkValue(sub, value, key));
    }
    return { ok: errors.length === 0, errors };
  }

  // 非对象类型的顶层 schema：只做一次类型检查
  errors.push(...checkValue(schema, args, "(root)"));
  return { ok: errors.length === 0, errors };
}

/** 按单个属性的 JSON Schema 检查一个值 */
function checkValue(schema: JsonSchema, value: unknown, path: string): string[] {
  const errors: string[] = [];

  const types = Array.isArray(schema.type)
    ? (schema.type as string[])
    : schema.type
      ? [schema.type as string]
      : [];

  if (types.length > 0) {
    const matched = types.some((t) => matchesType(t, value));
    if (!matched) {
      errors.push(`${path}: 类型应为 ${types.join(" 或 ")}，实际是 ${typeName(value)}`);
      return errors; // 类型都不对，后面的约束检查没有意义
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    errors.push(`${path}: 取值必须是 ${JSON.stringify(schema.enum)} 之一`);
  }

  if (Array.isArray(value)) {
    const items = schema.items as JsonSchema | undefined;
    if (items) {
      value.forEach((item, idx) => {
        errors.push(...checkValue(items, item, `${path}[${idx}]`));
      });
    }
  }

  if (schema.type === "object" && isPlainObject(value)) {
    const obj = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in obj) || obj[key] === undefined) {
        errors.push(`${path}.${key}: 缺少必填参数`);
      }
    }
    for (const [key, v] of Object.entries(obj)) {
      const sub = properties[key];
      if (sub) errors.push(...checkValue(sub, v, `${path}.${key}`));
    }
  }

  return errors;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      return true; // 未知类型不做限制，避免误杀
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
