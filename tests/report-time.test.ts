import { test } from "node:test";
import assert from "node:assert/strict";
import { InputError } from "../src/input.js";
import * as reportTime from "../src/report-time.js";

const {
  referencedRelativeYears,
  validIsoDate,
  validateReportTemporalText,
} = reportTime;

function temporalErrorCode(
  text: string,
  evidenceYears = [2026, 2027],
  referenceYear = 2026,
) {
  try {
    validateReportTemporalText(
      text,
      "section career claim 0 text",
      evidenceYears,
      referenceYear,
    );
  } catch (error) {
    if (error instanceof InputError) return error.code;
    throw error;
  }
  return null;
}

test("报告时间模块只公开报告层实际使用的三个接口", () => {
  assert.deepEqual(Object.keys(reportTime).sort(), [
    "referencedRelativeYears",
    "validIsoDate",
    "validateReportTemporalText",
  ]);
});

test("时间文本验证器独立保持日期、时区、时刻与区间错误优先级", () => {
  for (const [text, code] of [
    ["2027-02-29适合行动吗？", "INVALID_NUMERIC_DATE"],
    [
      "2027-03-14 02:30 America/New_York适合行动吗？",
      "NONEXISTENT_LOCAL_TIME",
    ],
    [
      "2026-11-01T01:30-06:00[America/New_York]适合签约吗？",
      "OFFSET_TIME_ZONE_MISMATCH",
    ],
    [
      "2026-11-01T01:30-04:00[America/New_York]和2026-11-01T05:30Z哪个更适合签约？",
      "DUPLICATE_ABSOLUTE_TIME",
    ],
    [
      "2026-11-01T05:30Z至2026-11-01T05:30Z适合签约吗？",
      "ZERO_LENGTH_TIME_INTERVAL",
    ],
    [
      "2026-11-01T06:30Z至2026-11-01T05:30Z适合签约吗？",
      "REVERSED_TIME_INTERVAL",
    ],
    [
      "区间一是2026-11-01T05:30Z至2026-11-01T06:30Z；区间二是2026-11-01T06:00Z至2026-11-01T07:00Z，哪个更适合签约？",
      "OVERLAPPING_TIME_INTERVAL",
    ],
    [
      "2026-11-01T05:30Z以后哪个时间更适合签约？",
      "OPEN_ENDED_TIME_INTERVAL",
    ],
    [
      "2026-11-01T05:30Z至2026-11-01T06:30Z，持续90分钟，适合签约吗？",
      "TIME_INTERVAL_DURATION_MISMATCH",
    ],
    [
      "2027-03-14T01:30-05:00[America/New_York]至2027-03-14T03:30-04:00[America/New_York]，持续2小时，适合行动吗？",
      "TIME_INTERVAL_DURATION_MISMATCH",
    ],
  ] as const)
    assert.equal(temporalErrorCode(text), code, text);
});

test("重复日程依次要求绝对范围、IANA 时区与逐次 evidence", () => {
  for (const [text, code] of [
    ["每天09:00适合联系客户吗？", "RECURRENCE_RANGE_REQUIRED"],
    ["每隔两周联系一次客户是否合适？", "RECURRENCE_RANGE_REQUIRED"],
    [
      "2026-11-01T00:00Z至2026-11-08T00:00Z，每天09:00适合联系客户吗？",
      "RECURRENCE_TIME_ZONE_REQUIRED",
    ],
    [
      "出生时区是Asia/Shanghai。2026-11-01T00:00Z至2026-11-08T00:00Z，每天09:00适合联系客户吗？",
      "RECURRENCE_TIME_ZONE_REQUIRED",
    ],
    [
      "2026-11-01T00:00-04:00[America/New_York]至2026-11-08T00:00-05:00[America/New_York]，每天09:00适合联系客户吗？",
      "UNSUPPORTED_RECURRENCE_GRANULARITY",
    ],
    [
      "2026-11-01T04:00Z至2026-11-08T05:00Z，按America/New_York当地每天09:00适合联系客户吗？",
      "UNSUPPORTED_RECURRENCE_GRANULARITY",
    ],
  ] as const)
    assert.equal(temporalErrorCode(text), code, text);

  assert.doesNotThrow(() =>
    validateReportTemporalText(
      "系统每天09:00运行，仅作计划说明。",
      "section career claim 0 text",
      [2026, 2027],
      2026,
    ),
  );
});

test("时间模块公开的日期与相对年份辅助函数保持确定性", () => {
  assert.equal(validIsoDate("2024-02-29"), true);
  assert.equal(validIsoDate("2027-02-29"), false);
  assert.equal(validIsoDate("2026/09/25"), false);
  assert.deepEqual(
    referencedRelativeYears("今年与明年，再看今年", 2026),
    [2026, 2027],
  );
  assert.deepEqual(referencedRelativeYears("明年", null), []);
});
