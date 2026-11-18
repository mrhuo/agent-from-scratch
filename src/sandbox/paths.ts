import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";

/**
 * 路径沙箱：限制工具能碰哪些文件。
 *
 * 第 4 篇的 readFile / searchFiles 各自写了一份「拼到根目录再判前缀」的检查。
 * 那份检查能挡住 `../.env` 这种朴素越权，但它是**写死在工具里的**：
 * 换一个工具就要重写一遍，且各工具的严格程度可能不一致。
 *
 * 本篇把它抽成可配置的沙箱对象，让「这个工具最多能碰哪些路径」成为
 * 一条独立于策略层的**硬边界**。这里的关键分工是：
 *
 *  - **沙箱（硬边界）**：写在工具里，规定这个工具**物理上**够不到哪些目录。
 *    策略层再怎么配置都放宽不了它。
 *  - **策略（软策略）**：在沙箱允许的范围内，决定某次具体调用放不放行。
 *
 * 换句话说：沙箱是围栏，策略是门禁。门禁可以给某些人开后门，
 * 但没法让人翻出围栏。
 */

export interface PathSandboxOptions {
  /** 允许访问的根目录（绝对路径或相对 cwd 的路径） */
  roots: string[];
  /**
   * 扩展名白名单（小写，不含点）。为空表示不限制扩展名。
   * 例如 [".txt", ".md", ".json"] 表示只允许读写这几类文件。
   */
  allowedExtensions?: string[];
  /** 扩展名黑名单，优先级高于白名单 */
  deniedExtensions?: string[];
  /** 允许的最大文件字节数；超限视为越界 */
  maxBytes?: number;
  /**
   * 是否解析符号链接（真实路径）。默认 true。
   * 不解析的话，一个指向 /etc 的软链就能绕过前缀检查。
   */
  followSymlinks?: boolean;
}

export type PathCheck =
  | { ok: true; absolute: string; relativeToRoot: string }
  | { ok: false; reason: string };

export class PathSandbox {
  private readonly roots: string[];
  private readonly allowedExtensions?: string[];
  private readonly deniedExtensions?: string[];
  private readonly maxBytes?: number;
  private readonly followSymlinks: boolean;

  constructor(options: PathSandboxOptions) {
    if (!options.roots || options.roots.length === 0) {
      throw new Error("PathSandbox 至少要配置一个 roots");
    }
    this.roots = options.roots.map((r) => resolve(r));
    this.allowedExtensions = options.allowedExtensions?.map((e) =>
      e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`,
    );
    this.deniedExtensions = options.deniedExtensions?.map((e) =>
      e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`,
    );
    this.maxBytes = options.maxBytes;
    this.followSymlinks = options.followSymlinks ?? true;
  }

  /**
   * 把输入路径解析成沙箱内的绝对路径。
   *
   * 依次做四件事：
   *  1. 解析成绝对路径——**相对路径以沙箱根目录为基准**（不是 cwd），
   *     这样「沙箱里放什么、工具能访问什么」用的是同一套相对路径语义；
   *  2. 解析符号链接（如果开启且路径存在）——防软链逃逸；
   *  3. 判断是否落在某个根目录内；
   *  4. 判断扩展名是否被允许。
   *
   * 注意第 3 步用 `relative(root, target)` 判断而不是 `target.startsWith(root)`：
   * 后者会把 `/data-secret` 误判成 `/data` 的子目录（前缀相同但不是子目录）。
   */
  check(inputPath: string, baseDir?: string): PathCheck {
    if (typeof inputPath !== "string" || inputPath.trim() === "") {
      return { ok: false, reason: "路径为空" };
    }
    const base = baseDir ?? this.roots[0]!;
    let target = isAbsolute(inputPath) ? resolve(inputPath) : resolve(base, inputPath);

    if (this.followSymlinks) {
      target = this.resolveSymlinks(target);
    }

    const root = this.findRoot(target);
    if (!root) {
      return {
        ok: false,
        reason: `路径越界：只允许访问 ${this.roots
          .map((r) => this.display(r))
          .join("、")}，收到 "${inputPath}"`,
      };
    }

    const ext = extname(target).toLowerCase();
    if (this.deniedExtensions?.includes(ext)) {
      return { ok: false, reason: `扩展名 ${ext} 在禁止清单里` };
    }
    if (this.allowedExtensions && this.allowedExtensions.length > 0) {
      if (!this.allowedExtensions.includes(ext)) {
        return {
          ok: false,
          reason: `扩展名 ${ext || "(无)"} 不在白名单 [${this.allowedExtensions.join(", ")}] 里`,
        };
      }
    }

    if (this.maxBytes !== undefined) {
      try {
        const st = statSync(target);
        if (st.isFile() && st.size > this.maxBytes) {
          return {
            ok: false,
            reason: `文件大小 ${st.size} 字节超过上限 ${this.maxBytes} 字节`,
          };
        }
      } catch {
        // 文件不存在：交由后续的写入流程处理，这里不越权判错
      }
    }

    return { ok: true, absolute: target, relativeToRoot: relative(root, target) };
  }

  /**
   * 判断某个路径是否在沙箱允许范围内（不检查扩展名与大小）。
   * 相对路径同样以沙箱根目录为基准解析。
   */
  contains(inputPath: string, baseDir?: string): boolean {
    const r = this.check(inputPath, baseDir);
    return r.ok;
  }

  /**
   * 解析符号链接：逐级向上找到第一个存在的祖先，取其真实路径，再把剩余段拼回去。
   *
   * 直接对目标调用 realpath 会在「文件还不存在」（写入场景）时抛错，
   * 所以这里用「向上找最近的存在祖先」的办法，既能解析软链，
   * 又能对尚未创建的新文件给出正确的沙箱判定。
   */
  private resolveSymlinks(target: string): string {
    let current = target;
    const tail: string[] = [];
    for (let i = 0; i < 64; i++) {
      try {
        const real = realpathSync(current);
        return tail.length ? resolve(real, ...tail) : real;
      } catch {
        const parent = resolve(current, "..");
        if (parent === current) return target; // 到了盘符根，放弃解析
        tail.unshift(current.slice(parent.length + 1));
        current = parent;
      }
    }
    return target;
  }

  /**
   * 找出包含 target 的根目录；不在任何根目录内则返回 null。
   *
   * 只用 `relative()` 判断：Node 的 win32.relative 在比较公共前缀时是
   * 大小写不敏感的，所以 Windows 上 `C:\Data` 与 `c:\data` 会被正确视为同一目录；
   * 而在 Linux/macOS 上路径本来就是大小写敏感的，不需要额外处理。
   */
  private findRoot(target: string): string | null {
    for (const root of this.roots) {
      const rel = relative(root, target);
      if (rel === "") return root;
      if (rel.startsWith("..")) continue;
      if (isAbsolute(rel)) continue;
      return root;
    }
    return null;
  }

  private display(p: string): string {
    const rel = relative(process.cwd(), p);
    return rel && !rel.startsWith("..") ? rel : p;
  }
}
