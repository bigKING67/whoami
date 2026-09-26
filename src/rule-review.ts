import type { Chart } from "./chart.js";
import { buildEvidence, type Evidence } from "./evidence.js";
import type { wealthReview } from "./wealth-review.js";

const POSITIONS: Record<string, string> = { year: "年", month: "月", day: "日", hour: "时" };
const describe = (p: { position: string; stem: string; tenGod: string }) =>
  `${POSITIONS[p.position]}干${p.stem}（${p.tenGod}）`;

export function wealthReviewFacts(e: Evidence) {
  return e.candidateIds.map(candidate => {
    const factId = `${candidate}.bazi.wealthReview`;
    // 同进程 buildEvidence 生成，事实类型与生成器对应。
    const value = e.facts.find(f => f.id === factId)!.value as ReturnType<typeof wealthReview>;
    return { candidate, factId, ruleId: `${candidate}.R-bazi-wealth-review`, value };
  });
}

export function wealthReviewSummary(w: ReturnType<typeof wealthReview>): string[] {
  return [
    `财格入口：${w.status === "candidate-only" ? "满足当前模块的候选入口，尚未确认成格" : "不满足当前模块入口，不代表无财或无格"}。`,
    `财印位置：${w.sealPlacement.conclusion}`,
    ...w.sealPlacement.pairs.filter(p => p.adjacent).map(p =>
      `相邻依据：${describe(p.wealth)}与${describe(p.seal)}。`),
    `财旺生官：${w.officerBranch.conclusion}`,
    ...w.officerBranch.checks.filter(x => w.officerBranch.blockers.includes(x.id)).map(x =>
      `反例：${x.positions.map(describe).join("、")}；本分支要求${x.condition}。`),
  ];
}

/** Deterministic view of existing evidence; no new traditional judgments. */
export function renderRuleReview(chart: Chart): string {
  const e = buildEvidence(chart); // 缺时辰沿用既有拒绝行为，不生成空盘解读。
  const lines = [
    "# 八字规则复核：财格候选",
    "",
    "这是现有财格规则的确定性摘要，不是完整八字或紫微分析，不判整体吉凶，也不预测现实事件。",
    "",
    `命盘状态：${chart.status}；候选数：${chart.candidates.length}。所有候选分别保留，不择优选盘。`,
    `证据年份：${e.years.join("、")}。下列规则只检查本命，不据年份推断流年事件。`,
    "",
    ...chart.warnings.map(w => `- 注意：${w}`),
  ];
  for (const { candidate, factId, value: w } of wealthReviewFacts(e)) {
    const c = chart.candidates.find(c => c.id === candidate)!;
    lines.push("", `## 候选 ${c.id}`, "",
      `四柱：${c.bazi.pillars.map(p => `${POSITIONS[p.position]}柱${p.value}`).join("、")}。`,
      `财格入口：${w.status}。${w.scope}。`, "");
    if (w.candidates.length) {
      lines.push(...w.candidates.map(x => `- 月支${w.monthBranch}藏${x.stem}（${x.tenGod}），透于${x.exposedAt.map(p => POSITIONS[p]).join("、")}干。`));
      const observed = w.checks.filter(x => x.prerequisite === "observed");
      lines.push("", "已见的显干前提（不等于作用成立）：", "",
        ...(observed.length ? observed.map(x => `- ${x.label}：${x.groups.flatMap(g => g.positions.map(describe)).join("、")}。待核：${x.pending}。`) : ["- 八组额外显干前提均未见。"]),
        "", `未见显干前提：${w.checks.filter(x => x.prerequisite === "not-observed").map(x => x.label).join("、") || "无"}。未见不等于藏干无作用。`);
    } else {
      lines.push("入口未满足，不代表无财或无格；未透取用、会支变化等不在本模块内。");
    }
    lines.push("", `财印位置：${w.sealPlacement.status}。${w.sealPlacement.conclusion}`, "",
      ...w.sealPlacement.pairs.map(p => `- ${describe(p.wealth)}与${describe(p.seal)}：${p.adjacent ? "相邻" : `隔${p.between.map(x => POSITIONS[x]).join("、")}柱`}。`),
      "", `财旺生官分支：${w.officerBranch.status}。${w.officerBranch.conclusion}`, "",
      ...w.officerBranch.checks.filter(x => w.officerBranch.blockers.includes(x.id)).map(x =>
        `- 阻断依据：${x.condition}；反例为${x.positions.map(describe).join("、")}。`),
      "", "尚需论证：身强弱、财官实际作用、合化及救应、藏干影响。财印相邻或财官分支阻断不能直接推成整格失败；未见反例也不能推成成格。",
      "", `依据：\`${factId}\`；规则：\`${c.id}.R-bazi-wealth-review\`。`);
  }
  lines.push("", "## 核对与来源", "",
    `chartId：\`${e.chartId}\``, `evidenceId：\`${e.evidenceId}\``, "",
    "细项可用相同输入与年份运行 context，按上述事实 ID 核对。出生资料变化后必须重新计算。",
    "",
    "传统来源：[论用神成败救应](https://donglishuzhai.net/chapter/3722.html)、[论财](https://donglishuzhai.net/chapter/3746.html)。当前采用原文转录，未完成影印校勘；工程检查不证明传统理论或现实预测有效。",
    "");
  return lines.join("\n");
}
