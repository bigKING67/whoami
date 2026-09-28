import { Lunar } from "lunar-typescript";
import { Temporal } from "@js-temporal/polyfill";
import type { Chart } from "./chart.js";

type Bazi = Chart["candidates"][number]["bazi"];
type Located = { position: string; stem: string; branch: string };
export type BranchRelation = { kind: string; positions: string[]; branches: string };

const BRANCH_PAIRS = [
  ["冲", "子午 丑未 寅申 卯酉 辰戌 巳亥"],
  ["六合", "子丑 寅亥 卯戌 辰酉 巳申 午未"],
  ["害", "子未 丑午 寅巳 卯辰 申亥 酉戌"],
] as const;
const BRANCH_GROUPS = [
  ["三合", "申子辰 亥卯未 寅午戌 巳酉丑"],
  ["三刑", "寅巳申 丑戌未"],
] as const;
// 三会只用于岁运：本命 relations 属冻结的 v1 口径，未收录三会。
const SEASONAL_GROUPS = [["三会", "寅卯辰 巳午未 申酉戌 亥子丑"]] as const;
const STEM_PAIRS = [
  ["五合", "甲己 乙庚 丙辛 丁壬 戊癸"],
  ["冲", "甲庚 乙辛 丙壬 丁癸"],
] as const;

const STEM_CLASH = STEM_PAIRS[1][1];
const BRANCH_CLASH = BRANCH_PAIRS[0][1];
const inPair = (table: string, a: string, b: string) =>
  a !== b && table.split(" ").some((pair) => pair.includes(a) && pair.includes(b));

/** 两个地支之间的成对关系；本命与岁运共用同一张表，保证口径一致。 */
export function pairBranchRelations(
  a: { position: string; branch: string },
  b: { position: string; branch: string },
): BranchRelation[] {
  const out: BranchRelation[] = [];
  const at = { positions: [a.position, b.position], branches: a.branch + b.branch };
  for (const [kind, table] of BRANCH_PAIRS)
    if (inPair(table, a.branch, b.branch)) out.push({ kind, ...at });
  if (a.branch === b.branch && "辰午酉亥".includes(a.branch))
    out.push({ kind: "自刑", ...at });
  if (inPair("子卯", a.branch, b.branch)) out.push({ kind: "刑", ...at });
  return out;
}

/** 全部成员都已出现的三合、三刑等组；required 中的每个位置都必须是补齐该组所必需的（去掉它就不完整）。 */
export function completeBranchGroups(
  members: { position: string; branch: string }[],
  required: string[] = [],
  tables: readonly (readonly [string, string])[] = BRANCH_GROUPS,
): BranchRelation[] {
  const out: BranchRelation[] = [];
  for (const [kind, groups] of tables)
    for (const group of groups.split(" ")) {
      const complete = (ms: typeof members) =>
        [...group].every((b) => ms.some((m) => m.branch === b));
      if (!complete(members)) continue;
      if (required.some((r) => complete(members.filter((m) => m.position !== r)))) continue;
      const used = members.filter((m) => group.includes(m.branch));
      out.push({ kind, positions: used.map((m) => m.position), branches: group });
    }
  return out;
}

type CycleRelation = {
  layer: "流年-本命" | "大运-本命" | "流年-大运" | "大运-本命组合" | "流年参与组合";
  scope: "stem" | "branch" | "pillar";
  kind: string;
  positions: string[];
  value: string;
};

function pillarRelations(op: Located, other: Located, layer: CycleRelation["layer"]) {
  const out: CycleRelation[] = [];
  const positions = [op.position, other.position];
  for (const [kind, table] of STEM_PAIRS)
    if (inPair(table, op.stem, other.stem))
      out.push({ layer, scope: "stem", kind, positions, value: op.stem + other.stem });
  for (const r of pairBranchRelations(op, other))
    out.push({ layer, scope: "branch", kind: r.kind, positions, value: r.branches });
  const pillar = op.stem + op.branch + other.stem + other.branch;
  if (op.stem === other.stem && op.branch === other.branch)
    out.push({ layer, scope: "pillar", kind: "伏吟", positions, value: pillar });
  if (inPair(STEM_CLASH, op.stem, other.stem) && inPair(BRANCH_CLASH, op.branch, other.branch))
    out.push({ layer, scope: "pillar", kind: "反吟", positions, value: pillar });
  return out;
}

const lichunCache = new Map<number, number>();
const lichun = (lunarYear: number) => {
  let ms = lichunCache.get(lunarYear);
  if (ms === undefined) {
    ms = Temporal.Instant.from(
      `${Lunar.fromYmd(lunarYear, 1, 1).getJieQiTable()["立春"]!.toYmdHms().replace(" ", "T")}+08:00`,
    ).epochMilliseconds;
    lichunCache.set(lunarYear, ms);
  }
  return ms;
};

const civil = (ms: number) =>
  Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO("+08:00")
    .toString({ timeZoneName: "never" });

/**
 * 逐个请求年份列出流年、该流年（立春至次年立春）内的大运，以及三层干支关系。
 * 只列传统关系表中的组合，不判断化合成败、吉凶或现实事件。
 */
export function cycleRelations(bazi: Bazi) {
  const natal: Located[] = bazi.pillars.map((p) => ({
    position: p.position,
    stem: p.stem,
    branch: p.branch,
  }));
  const { cycles } = bazi;
  const representative = Temporal.Instant.from(cycles.startInstant);
  const shift = (edge: "earliest" | "latest") =>
    Temporal.Instant.from(cycles.uncertainty.startInstant[edge]).epochMilliseconds -
    representative.epochMilliseconds;
  const [minShift, maxShift] = [shift("earliest"), shift("latest")];
  const bounds = cycles.decades.map((d) => ({
    d,
    from: Temporal.ZonedDateTime.from(d.startCivil).epochMilliseconds,
    to: Temporal.ZonedDateTime.from(d.endExclusiveCivil).epochMilliseconds,
  }));
  const lastIndex = cycles.decades.at(-1)!.index;
  const firstStart = bounds[0]!.from;
  // 起运范围不确定且当年有非全年覆盖的大运时，换运是否落在当年取决于实际起运时刻，统一标 start-uncertain。
  const decadeStatus = (
    decades: { index: number; coverage: string }[],
    start: number,
    end: number,
  ) => {
    if (!decades.length) return start >= firstStart ? "after-last-decade" : "before-first-decade";
    if (decades.length === 1 && decades[0]!.coverage === "whole-year") return "single";
    if (cycles.uncertainty.status === "range") return "start-uncertain";
    if (decades.length === 1 && decades[0]!.index === 1 && firstStart > start) return "first-decade-starts-within-year";
    if (decades.length === 1 && decades[0]!.index === lastIndex && end > bounds.at(-1)!.to) return "last-decade-ends-within-year";
    return "switches-within-year";
  };
  return cycles.yearly.map((y) => {
    const start = lichun(y.year);
    const end = lichun(y.year + 1);
    const decades = bounds.flatMap(({ d, from, to }) => {
      // 起运范围内任一时刻都覆盖整年才算 whole-year；只在部分起运时刻下覆盖记为 possible。
      const always = from + maxShift <= start && to + minShift >= end;
      const sometimes = from + minShift < end && to + maxShift > start;
      const certainOverlap = from + maxShift < end && to + minShift > start;
      if (!sometimes) return [];
      return [{
        index: d.index,
        pillar: d.pillar,
        coverage: always ? "whole-year" : certainOverlap ? "part-year" : "possible-if-start-shifts",
      }];
    });
    const yearly: Located = { position: "yearly", stem: y.pillar[0]!, branch: y.pillar[1]! };
    const operators: Located[] = decades.map((d) => ({
      position: `decade-${d.index}`,
      stem: d.pillar[0]!,
      branch: d.pillar[1]!,
    }));
    const relations: CycleRelation[] = [
      ...natal.flatMap((n) => pillarRelations(yearly, n, "流年-本命")),
      ...operators.flatMap((op) => natal.flatMap((n) => pillarRelations(op, n, "大运-本命"))),
      ...operators.flatMap((op) => pillarRelations(yearly, op, "流年-大运")),
    ];
    // 三合、三刑、三会按“本命 + 每步可能生效的大运 (+ 流年)”分别检查，只保留须岁运补齐的完整组；
    // 不需要流年即成立的组记为“大运-本命组合”，避免把整步大运的组合误读为当年新触发。
    const seen = new Set<string>();
    const groupTables = [...BRANCH_GROUPS, ...SEASONAL_GROUPS];
    const pushGroups = (members: Located[], required: string[], layer: CycleRelation["layer"]) => {
      for (const g of completeBranchGroups(members, required, groupTables)) {
        const key = `${g.kind}:${g.positions.join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        relations.push({ layer, scope: "branch", kind: g.kind, positions: g.positions, value: g.branches });
      }
    };
    for (const op of operators) pushGroups([...natal, op], [op.position], "大运-本命组合");
    pushGroups([...natal, yearly], ["yearly"], "流年参与组合");
    for (const op of operators)
      pushGroups([...natal, yearly, op], ["yearly", op.position], "流年参与组合");
    return {
      year: y.year,
      pillar: y.pillar,
      // 与大运 startCivil 一致使用 +08:00 民用时间表示立春时刻。
      lichunStart: civil(start),
      lichunEndExclusive: civil(end),
      decadeStatus: decadeStatus(decades, start, end),
      decades,
      relations,
    };
  });
}
