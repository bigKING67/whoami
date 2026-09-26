import { buildChart, digest, element, type Chart } from "./chart.js";
import { ziweiTransforms } from "./ziwei-transforms.js";
import { wealthReview } from "./wealth-review.js";
import { InputError } from "./input.js";

export type Fact = {
  id: string;
  candidate: string;
  system: "input" | "bazi" | "ziwei";
  label: string;
  value: unknown;
  source: string;
};
export type Rule = {
  id: string;
  candidate: string;
  label: string;
  factRefs: string[];
  guidance: string;
  source: string;
};
export function buildEvidence(chart: Chart) {
  if (chart.status === "needs-input")
    throw new InputError("MISSING_TIME", chart.questions[0]!);
  const facts: Fact[] = [],
    rules: Rule[] = [];
  const add = (
    candidate: string,
    system: Fact["system"],
    key: string,
    label: string,
    value: unknown,
    source: string,
  ) => {
    const id = `${candidate}.${system}.${key}`;
    facts.push({ id, candidate, system, label, value, source });
    return id;
  };
  for (const c of chart.candidates) {
    const id = c.id;
    const provenanceMissing = [
      "placeSource",
      "longitudeSource",
      "timeZoneSource",
    ].filter(
      (key) =>
        !chart.input.provenance?.[
          key as "placeSource" | "longitudeSource" | "timeZoneSource"
        ],
    );
    add(
      id,
      "input",
      "time",
      "代表性时间及校正",
      c.representativeTime,
      "NOAA + IANA tzdata",
    );
    add(
      id,
      "input",
      "provenance",
      "地点、经度与时区来源",
      {
        status:
          provenanceMissing.length === 3
            ? "unverified"
            : provenanceMissing.length
              ? "partial"
              : "provided",
        ...(chart.input.provenance ?? {}),
        ...(provenanceMissing.length ? { missing: provenanceMissing } : {}),
      },
      chart.input.provenance
        ? "用户提供的来源元数据；仅记录，不自动认定来源内容正确"
        : "未提供来源元数据",
    );
    const pillarRefs = c.bazi.pillars.map((p) =>
      add(
        id,
        "bazi",
        p.position,
        `${p.position} 柱`,
        p,
        "lunar-typescript + whoami 五鼠遁/十神关系",
      ),
    );
    const dm = add(
      id,
      "bazi",
      "dayMaster",
      "日主",
      c.bazi.dayMaster,
      "lunar-typescript; declared day boundary",
    );
    const month = c.bazi.pillars.find((p) => p.position === "month")!;
    const monthExposureRef = add(
      id,
      "bazi",
      "monthExposure",
      "月支藏干及年/月/时同干透出（不判成格）",
      {
        monthBranch: month.branch,
        dayMaster: c.bazi.dayMaster,
        hiddenStems: month.hiddenStems.map((hidden) => ({
          stem: hidden.stem,
          element: hidden.element,
          tenGod: hidden.tenGod,
          matchesDayMaster: hidden.stem === c.bazi.dayMaster,
          exposedAt: c.bazi.pillars
            .filter((p) => p.position !== "day" && p.stem === hidden.stem)
            .map((p) => p.position),
        })),
      },
      "whoami：既有月支藏干与年/月/时天干精确匹配；日干匹配单列，未算月令司权或格局",
    );
    const wealthRef = add(
      id, "bazi", "wealthReview", "月令财星透出的条件核对（非成败裁定）",
      wealthReview(c.bazi),
      "whoami 显干前提检测；传统条件见《子平真诠·论用神成败救应》原文转录",
    );
    const roots = c.bazi.pillars
      .filter((p) =>
        p.hiddenStems.some((s) => s.element === element(c.bazi.dayMaster)),
      )
      .map((p) => p.position);
    const rootRef = add(
      id,
      "bazi",
      "roots",
      "同五行藏干所在柱（仅通根线索）",
      roots,
      "传统藏干表；不计强弱权重",
    );
    const counts: Record<string, number> = {
      木: 0,
      火: 0,
      土: 0,
      金: 0,
      水: 0,
    };
    for (const p of c.bazi.pillars)
      counts[p.element] = (counts[p.element] ?? 0) + 1;
    const countRef = add(
      id,
      "bazi",
      "visibleElements",
      "四个天干五行出现数",
      counts,
      "unweighted descriptive counts",
    );
    const relationRefs: string[] = [];
    const pairs = [
      ["冲", "子午 丑未 寅申 卯酉 辰戌 巳亥"],
      ["六合", "子丑 寅亥 卯戌 辰酉 巳申 午未"],
      ["害", "子未 丑午 寅巳 卯辰 申亥 酉戌"],
    ] as const;
    const relations: { kind: string; positions: string[]; branches: string }[] =
      [];
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++) {
        const a = c.bazi.pillars[i]!,
          b = c.bazi.pillars[j]!;
        for (const [kind, table] of pairs)
          if (
            table
              .split(" ")
              .some(
                (pair) =>
                  pair.includes(a.branch) &&
                  pair.includes(b.branch) &&
                  a.branch !== b.branch,
              )
          )
            relations.push({
              kind,
              positions: [a.position, b.position],
              branches: a.branch + b.branch,
            });
        if (a.branch === b.branch && "辰午酉亥".includes(a.branch))
          relations.push({
            kind: "自刑",
            positions: [a.position, b.position],
            branches: a.branch + b.branch,
          });
        if (
          a.branch !== b.branch &&
          "子卯".includes(a.branch) &&
          "子卯".includes(b.branch)
        )
          relations.push({
            kind: "刑",
            positions: [a.position, b.position],
            branches: a.branch + b.branch,
          });
      }
    for (const [kind, groups] of [
      ["三合", "申子辰 亥卯未 寅午戌 巳酉丑"],
      ["三刑", "寅巳申 丑戌未"],
    ] as const) {
      for (const group of groups.split(" "))
        if ([...group].every((b) => c.bazi.pillars.some((p) => p.branch === b)))
          relations.push({
            kind,
            positions: c.bazi.pillars
              .filter((p) => group.includes(p.branch))
              .map((p) => p.position),
            branches: group,
          });
    }
    relationRefs.push(
      add(
        id,
        "bazi",
        "relations",
        "地支关系（不自动判化局或事件）",
        relations,
        "传统合冲刑害关系表；首版仅列全三合/全三刑与成对关系",
      ),
    );
    const rootDetailRef = add(
      id,
      "bazi",
      "rootDetails",
      "同五行藏干与直接六冲来源（不裁定根气有效性）",
      c.bazi.pillars.flatMap((p) =>
        p.hiddenStems
          .filter((s) => s.element === element(c.bazi.dayMaster))
          .map((s) => ({
            position: p.position,
            branch: p.branch,
            hiddenStem: s.stem,
            element: s.element,
            tenGod: s.tenGod,
            sameStemAsDayMaster: s.stem === c.bazi.dayMaster,
            clashSources: relations
              .filter((r) => r.kind === "冲" && r.positions.includes(p.position))
              .flatMap((r) => r.positions.filter((position) => position !== p.position))
              .map((position) => ({
                position,
                branch: c.bazi.pillars.find((other) => other.position === position)!.branch,
              })),
          })),
      ),
      "whoami：既有藏干事实与直接六冲关系联结；无旺衰、根气权重或冲毁裁定",
    );
    const cycleRef = add(
      id,
      "bazi",
      "cycles",
      "起运与大运流年",
      c.bazi.cycles,
      "lunar-typescript Yun sect=2; whoami absolute-time adapter",
    );
    rules.push({
      id: `${id}.R-bazi-structure`,
      candidate: id,
      label: "旺衰、格局与用神分开论证",
      factRefs: [dm, pillarRefs[1]!, monthExposureRef, rootRef, rootDetailRef, countRef, ...pillarRefs],
      guidance:
        "先结合月令、透干与藏干通根说明支持/反对理由。五行计数只是描述，不能据数量判旺衰或缺什么补什么。格局、调候与扶抑分列依据，存在冲突时说明适用条件；证据不足则不确定，不自动给唯一用神。",
      source: "references/analysis.md#八字",
    });
    rules.push({
      id: `${id}.R-bazi-wealth-review`,
      candidate: id,
      label: "财格候选分清出现、作用与成败",
      factRefs: [wealthRef, monthExposureRef, rootDetailRef, ...pillarRefs, ...relationRefs],
      guidance: "逐项说明已出现的显干前提与尚未裁定的旺衰、位置及制化条件。支持、风险和救应线索必须同时保留；not-observed 不等于无作用，outside-scope 不等于无格。不能从某个组合出现直接输出成格、破格或救应完成，最终仍需说明未决条件。",
      source: "references/analysis.md#财格候选复核",
    });
    rules.push({
      id: `${id}.R-bazi-month-exposure`,
      candidate: id,
      label: "月令藏干透出与格局成败分开核验",
      factRefs: [dm, monthExposureRef, ...pillarRefs, ...relationRefs],
      guidance:
        "先逐个核对月支藏干及年/月/时同一天干的透出位置；同五行不同干不算本项透出，日干同字单列。透干仅提供格局分析线索；多干同透全部保留，不按出现次数选唯一用神，未透也不等于无格。月令司权、会支变化、成败救应及制化有效性仍需另行论证。《子平真诠》的月令用神语境不得直接替代调候或扶抑用神。",
      source: "references/analysis.md#月令透干复核",
    });
    rules.push({
      id: `${id}.R-bazi-root-review`,
      candidate: id,
      label: "藏干存在与根气作用分开核对",
      factRefs: [dm, rootRef, rootDetailRef, ...relationRefs, ...pillarRefs],
      guidance:
        "先核对具体柱、地支和藏干，再讨论对日主的支持。同五行与同天干分别列出；直接受冲的根仍是盘面事实，不能直接删除，未列直接六冲也不等于根气有效或身强。结合月令、透干及其他关系提出支持、反证与待核条件；不把多条同源描述重复计为独立证据，不自动裁定旺衰、从格或用神。",
      source: "references/analysis.md#通根复核",
    });
    rules.push({
      id: `${id}.R-bazi-timing`,
      candidate: id,
      label: "本命与运年联读",
      factRefs: [cycleRef, ...relationRefs, ...pillarRefs],
      guidance:
        "将具体运年与本命柱联系，区分触发线索、替代解释及现实条件；冲不等于灾、合不等于吉，不从关系表直接推断具体人生事件。",
      source: "references/analysis.md#八字",
    });
    const base = add(
      id,
      "ziwei",
      "base",
      "命身宫与五行局",
      {
        soulPalace: c.ziwei.soulPalace,
        bodyPalace: c.ziwei.bodyPalace,
        soul: c.ziwei.soul,
        body: c.ziwei.body,
        fiveElementsClass: c.ziwei.fiveElementsClass,
        settings: c.ziwei.settings,
      },
      "iztro@2.6.1",
    );
    const palaceRefs = c.ziwei.palaces.map((p) =>
      add(id, "ziwei", `palace-${p.index}`, `${p.name}宫`, p, "iztro@2.6.1"),
    );
    const dynamic = add(
      id,
      "ziwei",
      "cycles",
      "大限与流年",
      { decadals: c.ziwei.decadals, yearly: c.ziwei.yearly },
      "iztro@2.6.1; lunar-new-year boundary",
    );
    const transformRef = add(
      id, "ziwei", "transformations", "生年、大限、流年四化落宫（分层）",
      ziweiTransforms(c.ziwei), "iztro@2.6.1 运限输出 + whoami 星名/本命宫位联结",
    );
    rules.push({
      id: `${id}.R-ziwei-transformations`, candidate: id,
      label: "四化分层与落宫核对",
      factRefs: [transformRef, base, dynamic, ...palaceRefs],
      guidance: "逐项核对四化来自生年、大限还是流年，以及星曜、本命落宫和已提供的流年宫职。大限年龄与年份均沿用虚岁/农历年口径，不当作生日或公历元旦切换。不能将大限命宫误作所有四化落宫；缺星、重名和未提供宫职保持未知，不用化忌直接断灾或化禄直接断财。",
      source: "references/analysis.md#四化落宫复核",
    });
    for (const [topic, names] of Object.entries({
      事业: ["命宫", "官禄", "财帛", "迁移"],
      财运: ["财帛", "官禄", "田宅", "福德"],
      关系: ["夫妻", "命宫", "福德", "迁移"],
    })) {
      const indices = new Set<number>();
      for (const p of c.ziwei.palaces.filter((p) => names.includes(p.name)))
        for (const index of p.surroundedIndices) indices.add(index);
      rules.push({
        id: `${id}.R-ziwei-${topic}`,
        candidate: id,
        label: `紫微${topic}联宫`,
        factRefs: [base, dynamic, transformRef, ...[...indices].map((i) => palaceRefs[i]!)],
        guidance:
          "从主题宫主辅星、四化、三方四正和命身宫形成条件性解释，再对照大限流年；不可仅凭单星下结论，空宫不能自行填入对宫星而不标明借星。",
        source: "https://iztro.com/learn/palace",
      });
    }
  }
  const evidenceId = digest({
    chartId: chart.chartId,
    years: chart.years,
    facts,
    rules,
  });
  return {
    schema: "whoami.evidence.v1" as const,
    chartId: chart.chartId,
    evidenceId,
    status: chart.status,
    input: chart.input,
    years: chart.years,
    warnings: chart.warnings,
    candidateIds: chart.candidates.map((c) => c.id),
    facts,
    rules,
    limits: [
      "确定性排盘不证明现实预测有效。",
      "不同命理体系的同向解读不是独立统计验证。",
      "规则依据仅支持传统解释，不构成医疗、投资或婚姻决策的事实证明。",
    ],
  };
}
export type Evidence = ReturnType<typeof buildEvidence>;
export function contextFor(raw: unknown, years?: number[]) {
  return buildEvidence(buildChart(raw, years));
}
