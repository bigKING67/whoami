import iztro from "iztro";
import type { ziweiAt } from "./chart.js";

type Ziwei = ReturnType<typeof ziweiAt>;
const MUTAGENS = ["禄", "权", "科", "忌"] as const;

/**
 * 宫干飞化：每个本命宫以宫干按 iztro 同一张十干四化表化出四星，定位到星曜所在的本命宫。
 * kind=self 为化出落回本宫（自化，亦称离心自化）；kind=opposite 为化入对宫（对宫视角即向心自化）。
 * 只列落点，不判吉凶；庚、戊、壬等干的四化星各派有异，本表只代表 iztro 口径。
 */
export function ziweiFlyingTransforms(ziwei: Ziwei) {
  const byStar = new Map<string, number[]>();
  for (const p of ziwei.palaces)
    for (const s of [...p.majorStars, ...p.minorStars])
      byStar.set(s.name, [...(byStar.get(s.name) ?? []), p.index]);
  const name = (index: number) => ziwei.palaces.find((p) => p.index === index)!.name;
  const palaces = ziwei.palaces.map((p) => ({
    palaceIndex: p.index,
    palace: p.name,
    stem: p.stem,
    flights: iztro.util
      .getMutagensByHeavenlyStem(p.stem as Parameters<typeof iztro.util.getMutagensByHeavenlyStem>[0])
      .map((star, i) => {
        const targets = byStar.get(star) ?? [];
        return {
          mutagen: MUTAGENS[i]!,
          star,
          // 星曜不在本命盘（如辅星未排入）时保留缺口，不补猜落点。
          status: targets.length === 1 ? ("located" as const) : targets.length ? ("ambiguous" as const) : ("missing" as const),
          targets: targets.map((t) => ({
            palaceIndex: t,
            palace: name(t),
            kind: t === p.index ? ("self" as const) : t === (p.index + 6) % 12 ? ("opposite" as const) : ("other" as const),
          })),
        };
      }),
  }));
  return {
    convention: "iztro 十干四化表（庚干：太阳、武曲、太阴、天同）；其他流派的庚、戊、壬干四化星不同时须另行说明",
    palaces,
    selfTransforms: palaces.flatMap((p) =>
      p.flights
        .filter((f) => f.targets.some((t) => t.kind === "self"))
        .map((f) => ({ palaceIndex: p.palaceIndex, palace: p.palace, stem: p.stem, mutagen: f.mutagen, star: f.star })),
    ),
  };
}
