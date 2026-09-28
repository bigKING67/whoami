import { InputError } from "./input.js";
import type { ziweiAt } from "./chart.js";
import type { Evidence } from "./evidence.js";

type Ziwei = ReturnType<typeof ziweiAt>;
type Palace = Ziwei["palaces"][number];
type Yearly = Ziwei["yearly"];
export type ZiweiScope = { palaces: Palace[]; yearly: Yearly };

export const isZiweiPalaceFactId = (id: string) => /\.ziwei\.palace-\d+$/u.test(id);

/**
 * 为一段文本选定宫位核对所用的候选：单候选命盘直接使用该候选；多候选时仅当文本线索指向唯一候选。
 * 返回 undefined 表示无法确定归属，调用方须把本项标为未核对，而不是当作通过。
 */
export function scopeForText(
  scopes: Map<string, ZiweiScope>,
  candidateHints: Iterable<string> = [],
) {
  if (scopes.size === 1) return [...scopes.values()][0];
  const hinted = new Set(candidateHints);
  return hinted.size === 1 ? scopes.get([...hinted][0]!) : undefined;
}

/** 按候选汇总本命十二宫与流年宫职，供宫位集合核对复用。 */
export function ziweiScopes(evidence: Evidence) {
  const scopes = new Map<string, ZiweiScope>();
  for (const candidate of evidence.candidateIds) {
    const cycles = evidence.facts.find((f) => f.id === `${candidate}.ziwei.cycles`)
      ?.value as { yearly: Yearly } | undefined;
    scopes.set(candidate, {
      palaces: evidence.facts
        .filter((f) => f.candidate === candidate && isZiweiPalaceFactId(f.id))
        .map((f) => f.value as Palace),
      yearly: cycles?.yearly ?? [],
    });
  }
  return scopes;
}

const PALACE_NAMES = [
  "命宫", "兄弟", "夫妻", "子女", "财帛", "疾厄",
  "迁移", "仆役", "官禄", "田宅", "福德", "父母",
];
// 容许“2026 年的流年官禄宫落在本命命宫（午）”等常见变体。
const HEADER = new RegExp(
  `(\\d{4})\\s*年?(?:的)?流年(官禄|财帛|夫妻)宫?落(?:在|于)?本命(${PALACE_NAMES.join("|")})宫?[（(]?([子丑寅卯辰巳午未申酉戌亥])?`,
  "gu",
);
// 同一分句内显式声明另引集合外背景时放行，见 references/report.md 前提一致性一节。
const OUTSIDE_MARKER = /(三方四正|联宫)之外|不属(于)?(本题|该主题|本主题|该年)/u;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** 本命宫引用：宫名后接地支（其后须为标点、括号或文本结尾，避免“财帛未见”“夫妻子女”），或接本宫星曜（允许中间有“宫”或括号）。 */
function palaceReference(p: Palace) {
  const stars = [...p.majorStars, ...p.minorStars].map((s) => escape(s.name));
  const alternatives = [
    `${p.branch}(?=[（(，、。；：:\\s]|$)`,
    `宫?[（(]${p.branch}(?:宫)?[）)]`,
    `宫(?:位)?(?:位于|在)${p.branch}`,
  ];
  if (stars.length) alternatives.push(`宫?[（(]?(?:${stars.join("|")})`);
  return new RegExp(`${escape(p.name)}(?:${alternatives.join("|")})`, "u");
}

/**
 * 逐段核对“YYYY(年)流年<主题宫>落本命<宫>”之后的解释：段首落宫须与命盘一致，段内写出的本命宫
 * 须属于该年该主题的物理宫集合。只覆盖这一固定写法，不理解缩写或其他语义。
 */
export function assertZiweiPalaceScope(text: string, scope: ZiweiScope, label: string) {
  const { palaces, yearly } = scope;
  const headers = [...text.matchAll(HEADER)];
  headers.forEach((header, i) => {
    const [whole, rawYear, role, statedName, statedBranch] = header;
    const year = yearly.find((y) => y.year === Number(rawYear));
    if (!year) return; // 年份是否在 evidence 内由时间门禁负责
    const anchor = palaces.find((p) => year.palaceNames[p.index] === role);
    if (!anchor) return;
    if (
      anchor.name !== statedName ||
      (statedBranch !== undefined && anchor.branch !== statedBranch)
    )
      throw new InputError(
        "PALACE_SCOPE_MISMATCH",
        `${label} 写“${whole}”，但当前命盘 ${rawYear} 年流年${role}落本命${anchor.name}${anchor.branch}`,
      );
    const start = header.index! + whole.length;
    const nextHeader = headers[i + 1]?.index ?? text.length;
    const paragraphEnd = text.indexOf("\n\n", start);
    const segment = text.slice(
      start,
      paragraphEnd === -1 ? nextHeader : Math.min(nextHeader, paragraphEnd),
    );
    const outside = palaces
      .filter((p) => !anchor.surroundedIndices.includes(p.index))
      .map((p) => ({ p, pattern: palaceReference(p) }));
    for (const clause of segment.split(/[。；！？，\n]/u)) {
      if (OUTSIDE_MARKER.test(clause)) continue;
      for (const { p, pattern } of outside) {
        const hit = clause.match(pattern);
        if (hit)
          throw new InputError(
            "PALACE_SCOPE_MISMATCH",
            `${label} 的 ${rawYear} 年${role}段落引用了本命${p.name}${p.branch}（“${hit[0]}”），不属于该年流年${role}的三方四正；如需引用集合外背景，须在同一分句写明“三方四正之外”或“不属本题”`,
          );
      }
    }
  });
}
