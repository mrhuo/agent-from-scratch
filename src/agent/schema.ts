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
