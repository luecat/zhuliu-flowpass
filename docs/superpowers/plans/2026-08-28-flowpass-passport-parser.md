# FlowPass Passport Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browser-local FlowPass JSON parser and human-readable passport viewer to the existing page without changing the current prompt-generator workflow.

**Architecture:** The generator and parser share one exported Draft 2020-12 JSON Schema. A pure parser module handles syntax, schema, graph-integrity, readiness checks, and summary construction; React components only manage workspace state and render typed results. The parser receives text and never performs network or storage operations.

**Tech Stack:** React 19, TypeScript 5.9, Vinext, Vitest, Testing Library, Ajv 8 Draft 2020-12, CSS.

**Spec:** `docs/superpowers/specs/2026-08-28-flowpass-passport-parser-design.md`

## Global Constraints

- Keep both workflows on the existing `/` route behind `產生提示詞` and `解析護照` controls.
- Parsing is browser-local: no `fetch`, localStorage, Cookie, account, database, or AI API.
- Preserve the current generator inputs, preset behavior, stale-copy protection, and clipboard behavior.
- Reuse the exact exported `PASSPORT_JSON_SCHEMA`; do not maintain a parser-only copy.
- A valid parser result is still labeled `AI 草稿，尚未確認`; never show approval, compliance, safety, or a risk score.
- Render all JSON-derived strings as React text, never `dangerouslySetInnerHTML`.
- Keep the existing public Sites project and deploy only after tests, lint, and build pass.

## File Map

- Modify `package.json` and `package-lock.json`: add direct `ajv` dependency.
- Modify `app/prompt-builder.ts`: export the shared schema.
- Create `app/passport-sample.ts`: hold the exact hackathon sample object and formatted JSON string.
- Create `app/passport-parser.ts`: own parser types, validation, graph checks, and summaries.
- Create `app/passport-parser.test.ts`: test syntax, contract, graph, readiness, and summary behavior.
- Create `app/passport-viewer.tsx`: render typed summary, flows, issues, actions, questions, and administrative details.
- Create `app/passport-viewer.test.tsx`: test safe, accessible result rendering.
- Modify `app/page.tsx`: add the top-level workspace switch and controlled parser input/result.
- Modify `app/page.test.tsx`: test integration while preserving generator coverage.
- Modify `app/globals.css`: style parser controls, flow cards, issue states, and responsive layouts.

---

### Task 1: Shared schema, sample, and syntax/contract parser

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `app/prompt-builder.ts`
- Create: `app/passport-sample.ts`
- Create: `app/passport-parser.ts`
- Create: `app/passport-parser.test.ts`

**Interfaces:**
- Consumes: `PASSPORT_JSON_SCHEMA` from `app/prompt-builder.ts`.
- Produces: `FLOWPASS_SAMPLE`, `FLOWPASS_SAMPLE_JSON`, `parseFlowPassJson(raw: string): FlowPassParseResult`, `FlowPassParseResult`, `ValidationIssue`, `PassportDraft`, and `PassportSummary`.

- [ ] **Step 1: Write failing syntax and contract tests**

```ts
import { describe, expect, it } from 'vitest';
import { FLOWPASS_SAMPLE_JSON } from './passport-sample';
import { parseFlowPassJson } from './passport-parser';

describe('parseFlowPassJson', () => {
  it('summarizes the supplied FlowPass sample', () => {
    const result = parseFlowPassJson(FLOWPASS_SAMPLE_JSON);
    expect(result.status).not.toMatch(/^invalid_/);
    expect(result.summary).toMatchObject({
      nodeCount: 8,
      edgeCount: 4,
      actionCount: 4,
      questionCount: 8,
      priorityCounts: { high: 3, medium: 4, low: 1 },
    });
  });

  it('reports invalid JSON without changing the source text', () => {
    const result = parseFlowPassJson('{"passport_draft":');
    expect(result.status).toBe('invalid_json');
    expect(result.passport).toBeNull();
    expect(result.issues[0]).toMatchObject({ category: 'syntax', severity: 'error' });
  });

  it('reports a missing passport section with a JSON path', () => {
    const parsed = JSON.parse(FLOWPASS_SAMPLE_JSON);
    delete parsed.passport_draft.use_case;
    const result = parseFlowPassJson(JSON.stringify(parsed));
    expect(result.status).toBe('invalid_contract');
    expect(result.issues.some((issue) => issue.path === '$.passport_draft.use_case')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `rtk npm test -- app/passport-parser.test.ts`

Expected: FAIL because the sample and parser modules do not exist.

- [ ] **Step 3: Add Ajv and export the schema**

Run: `rtk npm install ajv@8.17.1`

In `app/prompt-builder.ts`, change only the declaration token from `const PASSPORT_JSON_SCHEMA` to `export const PASSPORT_JSON_SCHEMA`; keep the object body byte-for-byte unchanged.

- [ ] **Step 4: Add the exact supplied sample**

Create `FLOWPASS_SAMPLE` from the supplied `passport_draft` object without semantic rewriting, then export:

```ts
export const FLOWPASS_SAMPLE_JSON = JSON.stringify(FLOWPASS_SAMPLE, null, 2);
```

- [ ] **Step 5: Implement strict parsing and schema validation**

Define these stable interfaces:

```ts
export type IssueSeverity = 'error' | 'warning' | 'info';
export type IssueCategory = 'syntax' | 'schema' | 'graph' | 'readiness';

export type ValidationIssue = {
  code: string;
  category: IssueCategory;
  severity: IssueSeverity;
  path: string;
  message: string;
  relatedIds?: string[];
};

export type FlowPassParseResult = {
  status:
    | 'invalid_json'
    | 'invalid_contract'
    | 'invalid_graph'
    | 'valid_with_warnings'
    | 'valid';
  passport: PassportDraft | null;
  issues: ValidationIssue[];
  summary: PassportSummary | null;
};
```

Compile `PASSPORT_JSON_SCHEMA` once:

```ts
import Ajv2020 from 'ajv/dist/2020.js';
import { PASSPORT_JSON_SCHEMA } from './prompt-builder';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validatePassport = ajv.compile(PASSPORT_JSON_SCHEMA);
```

For required-property errors, join `instancePath` and `params.missingProperty`; convert the empty path to `$`. Return `invalid_contract` and no passport/summary whenever schema validation fails.

- [ ] **Step 6: Run the focused test and verify it passes**

Run: `rtk npm test -- app/passport-parser.test.ts`

Expected: PASS for valid sample, syntax error, and missing-section path.

- [ ] **Step 7: Commit the parser foundation**

```bash
rtk git add package.json package-lock.json app/prompt-builder.ts app/passport-sample.ts app/passport-parser.ts app/passport-parser.test.ts
rtk git commit -m "feat: add FlowPass passport parser foundation"
```

---

### Task 2: Graph integrity and readiness summary

**Files:**
- Modify: `app/passport-parser.ts`
- Modify: `app/passport-parser.test.ts`

**Interfaces:**
- Consumes: the validated `PassportDraft` from Task 1.
- Produces: populated `ValidationIssue[]`, `PassportSummary`, and `ReadableFlow[]` returned by `parseFlowPassJson`.

- [ ] **Step 1: Write failing graph and readiness tests**

Add tests that mutate a cloned sample and assert:

```ts
expect(sampleResult.summary?.sensitivityCounts).toEqual({
  high: 4,
  medium: 2,
  low: 2,
  unknown: 0,
});
expect(sampleResult.summary?.unknownFields).toEqual([
  '$.retention.duration',
  '$.retention.deletion_plan',
  '$.administrative_hints.requested_tool',
]);
expect(sampleResult.issues.filter((issue) => issue.code === 'orphan_node')).toHaveLength(3);
```

Also create one dangling edge, one duplicate node ID, one self-loop, one repeated edge, and one fenced JSON input. Assert dangling/duplicate/self-loop are errors, repeated edge is a warning, and a complete fenced block parses with a `markdown_fence` warning.

- [ ] **Step 2: Run the focused test and verify new assertions fail**

Run: `rtk npm test -- app/passport-parser.test.ts`

Expected: FAIL because graph issues, fence handling, and complete summary fields are absent.

- [ ] **Step 3: Implement graph and readiness checks**

After schema validation:

- Build a `Map<string, PassportNode>` and report blank or duplicate IDs.
- Validate edge endpoints, action `applies_to_node_ids`, and question `related_node_ids`.
- Report self-loops as errors and exact repeated `from_node_id|to_node_id|purpose` tuples as warnings.
- Detect directed cycles with depth-first search and emit one `graph_cycle` warning per detected cycle signature.
- Count node participation and report orphan data/tool/plugin/storage/destination nodes as warnings and orphan person/organization nodes as info.
- If `retention.storage_location` equals a node ID or starts with `node_`, require an existing storage node.
- For public sharing, require a destination node that participates in at least one edge.
- Turn `unknown_fields`, every `needs_confirmation`, public sharing, high sensitivity, unknown retention, unknown tool, and officer review into readiness information without a risk score.

Return `invalid_graph` when any graph issue has severity `error`; otherwise return `valid_with_warnings` whenever any warning or info exists, and `valid` only when `issues` is empty.

- [ ] **Step 4: Build the complete summary**

Populate exact counts, sensitivity counts, priority counts, unknown fields, sharing/retention/admin values, and readable flows:

```ts
type ReadableFlow = {
  id: string;
  fromLabel: string;
  toLabel: string;
  purpose: string;
  needsConfirmation: boolean;
};
```

- [ ] **Step 5: Run parser tests and verify they pass**

Run: `rtk npm test -- app/passport-parser.test.ts`

Expected: all parser tests PASS, including the 8/4/4/8 sample result.

- [ ] **Step 6: Commit graph validation**

```bash
rtk git add app/passport-parser.ts app/passport-parser.test.ts
rtk git commit -m "feat: validate FlowPass data-flow graphs"
```

---

### Task 3: Accessible passport viewer

**Files:**
- Create: `app/passport-viewer.tsx`
- Create: `app/passport-viewer.test.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `result: FlowPassParseResult`.
- Produces: `PassportViewer({ result, section }: { result: FlowPassParseResult; section: 'flow' | 'details' })`.

- [ ] **Step 1: Write failing viewer tests**

Render a successful sample result and assert the page displays `AI 草稿，尚未確認`, `8 個節點`, `4 條連線`, the complete readable flow text, `高 3`, `中 4`, `低 1`, four safety actions, and all unknown fields. Render an invalid result and assert a `role="alert"` contains a concrete path.

Add an action label containing `<script>alert('x')</script>` and assert it is visible as text while `container.querySelector('script')` is null.

- [ ] **Step 2: Run viewer tests and verify they fail**

Run: `rtk npm test -- app/passport-viewer.test.tsx`

Expected: FAIL because `PassportViewer` does not exist.

- [ ] **Step 3: Implement the viewer**

Implement the stable component boundary:

```tsx
export function PassportViewer({
  result,
  section,
}: {
  result: FlowPassParseResult;
  section: 'flow' | 'details';
}) {
  if (section === 'flow') return <FlowSection result={result} />;
  return <DetailsSection result={result} />;
}
```

Render these typed sections without tabs that hide critical information:

- Draft status and parse status.
- Four summary metrics.
- Use-case title, purpose, and outcome.
- Readable flow rows plus orphan/reference issues.
- Safety actions with reason and evidence label.
- Confirmation questions sorted high, medium, low while preserving source order within each group.
- Sharing, retention, administrative values, and unknown fields.

Every severity and priority card includes visible Chinese text; arrows are `aria-hidden` and the full relationship remains in text.

- [ ] **Step 4: Add responsive viewer styles**

Use existing color tokens. Add `.passport-viewer`, `.metric-grid`, `.flow-card`, `.issue-card`, `.priority-high`, `.priority-medium`, `.priority-low`, `.draft-banner`, and mobile rules. Do not add SVG or image assets.

- [ ] **Step 5: Run viewer tests and verify they pass**

Run: `rtk npm test -- app/passport-viewer.test.tsx`

Expected: all viewer tests PASS.

- [ ] **Step 6: Commit the viewer**

```bash
rtk git add app/passport-viewer.tsx app/passport-viewer.test.tsx app/globals.css
rtk git commit -m "feat: render parsed FlowPass passports"
```

---

### Task 4: Same-page workspace integration

**Files:**
- Modify: `app/page.tsx`
- Modify: `app/page.test.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `FLOWPASS_SAMPLE_JSON`, `parseFlowPassJson`, and `PassportViewer`.
- Produces: the `/` route with preserved generator state and a controlled parser workflow.

- [ ] **Step 1: Write failing integration tests**

Add tests that:

- Switch between `產生提示詞` and `解析護照` and retain edits in both modes.
- Confirm the parser starts with the supplied sample.
- Click `解析護照` and see 8 nodes, 4 edges, 4 actions, and 8 questions.
- Enter invalid JSON, receive a `role="alert"`, and retain the exact textarea value.
- Delete `use_case`, parse again, and see `$.passport_draft.use_case`.
- Use `載入範例` and `清除` without altering generator inputs.
- Continue passing every existing generator and clipboard test.

- [ ] **Step 2: Run page tests and verify new assertions fail**

Run: `rtk npm test -- app/page.test.tsx`

Expected: new workspace-mode and parser assertions FAIL while existing generator tests remain green.

- [ ] **Step 3: Add controlled workspace state**

In `page.tsx`, rename the existing `Mode` to `InputMode`, then add:

```ts
type WorkspaceMode = 'generate' | 'parse';
const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('generate');
const [parserInput, setParserInput] = useState(FLOWPASS_SAMPLE_JSON);
const [parseResult, setParseResult] = useState<FlowPassParseResult | null>(null);
```

Add a visible 44px-high primary mode switch after the top bar. Preserve both states when switching. `解析護照` calls `parseFlowPassJson(parserInput)`; `清除` empties only parser input/result; `載入範例` restores only parser input and clears the previous result.

- [ ] **Step 4: Render parser-specific columns**

When `workspaceMode === 'parse'`:

- Left panel lists the four validation layers and marks idle/pass/warning/error from `parseResult`.
- Center canvas shows the JSON input, privacy hint, sample/clear controls, parse button, and readable flow portion of `PassportViewer`.
- Right inspector shows the draft banner, metrics, issues, actions, questions, and admin details.

Render `<PassportViewer result={parseResult} section="flow" />` in the center and `<PassportViewer result={parseResult} section="details" />` in the inspector. Do not duplicate result mapping in `page.tsx`.

- [ ] **Step 5: Complete responsive styles**

Keep three columns above 1080px, move the inspector below at 1080px, use one column at 720px, and keep all primary controls at least 44px high. Ensure the workspace switch is not inside the breadcrumb hidden at 1080px.

- [ ] **Step 6: Run page and full tests**

Run: `rtk npm test -- app/page.test.tsx`

Expected: page tests PASS.

Run: `rtk npm test`

Expected: all generator, parser, viewer, and integration tests PASS.

- [ ] **Step 7: Commit integration**

```bash
rtk git add app/page.tsx app/page.test.tsx app/globals.css
rtk git commit -m "feat: add same-page FlowPass passport workspace"
```

---

### Task 5: Final validation and Sites handoff

**Files:**
- Review: all changed source, tests, lockfile, and documentation.

**Interfaces:**
- Consumes: the complete same-page parser implementation.
- Produces: one validated commit ready for the existing public test Site.

- [ ] **Step 1: Run static and production checks**

Run: `rtk npm test`

Expected: all tests PASS.

Run: `rtk npm run lint`

Expected: exit 0 with no lint errors.

Run: `rtk npm run build`

Expected: exit 0 and valid Sites output in `dist/`.

- [ ] **Step 2: Review the exact diff**

Run: `rtk git diff --check`

Expected: no whitespace errors.

Run: `rtk git status --short`

Expected: only intentional implementation or generated lockfile changes remain.

- [ ] **Step 3: Commit any final verified adjustments**

```bash
rtk git add app package.json package-lock.json docs/superpowers/plans/2026-08-28-flowpass-passport-parser.md
rtk git commit -m "feat: complete FlowPass passport parser"
```

- [ ] **Step 4: Publish the validated commit**

Use the existing Sites project in `.openai/hosting.json`, preserve public access, save a new version from the validated source, deploy it, wait for success, and reopen the existing Site tab at the deployed URL.
