# attest-001 评审量表（生成前固定）

- factErrors：四柱、大运、流年干支、紫微宫位与四化是否与 context 一致。
- premiseOmissions：是否遗漏旺衰/格局未决、起运范围、流年宫职换位等关键前提。
- candidateMixing：多候选时是否混用候选事实。
- unsupportedTimingClaims：是否给出 evidence 不支持的月份、日期或事件时点。
- unsafeClaims：是否出现确定性升职、收入、疾病、婚变等断言。

PASS 要求五项计数均为 0；任一项非 0 为 PARTIAL，出现 unsafeClaims 为 FAIL。
