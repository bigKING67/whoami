import { InputError } from "./input.js";

export type UnsafeReportCategory =
  | "death-prediction"
  | "medical-diagnosis"
  | "guaranteed-finance"
  | "inevitable-relationship"
  | "guaranteed-event";

type SafetyRule = {
  category: UnsafeReportCategory;
  label: string;
  pattern: RegExp;
};

const RULES: readonly SafetyRule[] = [
  {
    category: "death-prediction",
    label: "死亡或寿命确定性预测",
    pattern:
      /必死|死定了|活不过(?:\d{1,3}\s*岁|[^，。！？；\n]{1,10})|(?:死亡|去世)(?:时间|日期|年份)|(?:注定|必然|必定|一定(?:会)?|肯定(?:会)?)(?:死亡|去世|早逝)/gu,
  },
  {
    category: "medical-diagnosis",
    label: "疾病诊断",
    pattern:
      /确诊(?:为|是)?[^，。！？；\n]{0,16}|(?:你|命主|此人)(?:已经|已)?(?:患有|有)(?:癌|肿瘤|心脏病|糖尿病|抑郁症|精神病|疾病|病症)|(?:必然|必定|一定(?:会)?|肯定(?:会)?|注定|必得|会得|将得)(?:[^，。！？；\n]{0,10})(?:癌|肿瘤|心脏病|糖尿病|抑郁症|精神病|疾病|病症)/gu,
  },
  {
    category: "guaranteed-finance",
    label: "保证收益或确定性盈亏",
    pattern:
      /稳赚(?:不赔)?|必赚|必亏|包赚|保证收益|收益保证|保本保收益|无风险收益|(?:一定|肯定)(?:会)?赚钱|注定发财/gu,
  },
  {
    category: "inevitable-relationship",
    label: "必然婚变或关系事件",
    pattern:
      /(?:注定|必然|必定|一定(?:会)?|肯定(?:会)?)(?:离婚|婚变|分手|出轨)|婚姻必破|必二婚/gu,
  },
  {
    category: "guaranteed-event",
    label: "确定性事业或人生事件",
    pattern:
      // “注定/必然/必定”后接事件即拦截；“一定/肯定/保证”须带“会/能”或直接接事件，并排除“一定要留意被裁风险”这类提醒。
      /(?:注定|必然|必定)[^，。！？；\n]{0,4}(?:升职|加薪|晋升|升迁|发财|暴富|中奖|结婚|复合|怀孕|跳槽成功|考上|录取|上岸|破产|失业|被裁)|(?:一定|肯定|保证)(?:会|能)(?:(?!要|需|应|防|避|留意|注意)[^，。！？；\n]){0,4}(?:升职|加薪|晋升|升迁|发财|暴富|中奖|结婚|复合|怀孕|跳槽成功|考上|录取|上岸|破产|失业|被裁)|(?:一定|肯定|保证)(?:升职|加薪|晋升|升迁|发财|暴富|中奖|结婚|复合|怀孕|跳槽成功|考上|录取|上岸|破产|失业|被裁)|(?:升职|加薪|晋升|结婚|复合|发财)(?:已成定局|板上钉钉)/gu,
  },
];

const CLAUSE_BOUNDARY = /[，。！？；\n]/u;
const CONTRAST_BOUNDARY = /(?:但是|但|然而|不过|可是)/u;
const NEGATION_CONTEXT =
  /(?:(?:尚)?不足以|不支持|不能|不得|不可|不应|不要|不宜|不依赖|不把|没有|未(?:自动)?(?:判定|确定|裁定)|切勿|拒绝|避免|禁止|并非|不是|不代表|不等于|不等同(?:于)?|不意味着|不给(?!力)|不构成|无法|不会)(?:[^，。！？；\n]{0,24})$|不$/u;
const POST_NEGATION = /^(?:并不成立|不是事实|并不存在|不可能|不可成立)/u;

function isNegated(text: string, index: number, length: number) {
  const prefixClause = text
    .slice(0, index)
    .split(CLAUSE_BOUNDARY)
    .at(-1)!
    .split(CONTRAST_BOUNDARY)
    .at(-1)!;
  if (NEGATION_CONTEXT.test(prefixClause.slice(-36))) return true;
  return POST_NEGATION.test(text.slice(index + length, index + length + 12));
}

export function findUnsafeReportClaim(text: string) {
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const index = match.index ?? 0;
      if (!isNegated(text, index, match[0].length))
        return {
          category: rule.category,
          label: rule.label,
          match: match[0],
          index,
        };
    }
  }
  return null;
}

export function assertSafeReportText(text: string, field: string) {
  const issue = findUnsafeReportClaim(text);
  if (issue)
    throw new InputError(
      "UNSAFE_REPORT_CLAIM",
      `${field} 包含${issue.label}；命理解读产物不得把传统解释写成高风险现实断言`,
    );
}

const TOPIC_PATTERNS = {
  strength: /旺衰|身强|身弱|偏强|偏弱|可任(?:财|官|杀|食伤)/u,
  pattern: /格局|成格|破格|败格/u,
  climate: /调候|寒暖|燥湿/u,
  balance: /扶抑/u,
  selection: /用神|喜用|忌神|取用|五行方向/u,
} as const;

export function requiredReasoningTopics(text: string) {
  return (Object.entries(TOPIC_PATTERNS) as Array<
    [keyof typeof TOPIC_PATTERNS, RegExp]
  >)
    .filter(([, pattern]) => pattern.test(text))
    .map(([topic]) => topic);
}

const PREMISE_UPGRADE =
  /(?:已经|已)(?:成立|确定|裁定|定论)|(?:结论|方向)(?:已经|已)?(?:确定|唯一)|(?:唯一|确定)(?:的)?(?:用神|喜用|忌神|格局|扶抑方向)|(?:用神|喜用|忌神|格局|扶抑方向)(?:已经|已)?(?:确定|唯一)|(?:无需|不必)(?:再)?(?:核对|验证|复核|考虑|理会|保留)(?:其他)?(?:条件|反证|分支|前提)?|没有其他可能/gu;

export function findUnresolvedPremiseUpgrade(text: string) {
  for (const match of text.matchAll(PREMISE_UPGRADE)) {
    const index = match.index ?? 0;
    if (!isNegated(text, index, match[0].length))
      return { match: match[0], index };
  }
  return null;
}

export function assertNoUnresolvedPremiseUpgrade(text: string, field: string) {
  if (findUnresolvedPremiseUpgrade(text))
    throw new InputError(
      "UNRESOLVED_PREMISE_CLAIM",
      `${field} 把未决论证写成已裁定结论`,
    );
}
