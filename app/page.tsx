'use client';

import { useMemo, useState } from 'react';
import {
  buildPromptJson,
  presets,
  type FlowPassInputs,
  type Preset,
} from './prompt-builder';
import {
  parseFlowPassJson,
  type FlowPassParseResult,
  type IssueCategory,
} from './passport-parser';
import { FLOWPASS_SAMPLE_JSON } from './passport-sample';
import { PassportViewer } from './passport-viewer';

type InputMode = 'preset' | 'custom';
type WorkspaceMode = 'generate' | 'parse';
type CopyState = 'idle' | 'copied' | 'error';
type LayerStatus = 'idle' | 'pass' | 'warning' | 'error';

const emptyInputs: FlowPassInputs = {
  materials: '',
  intended_use: '',
  personal_or_sensitive_data: '',
  destination_and_audience: '',
};

const flowStages: Record<Preset['id'] | 'custom', string[]> = {
  recruitment_video: [
    '社員照片與錄音',
    '安全處理',
    'AI 影片工具',
    '公開社群',
  ],
  interview_summary: ['訪談錄音', '取得同意', 'AI 轉錄', '團隊雲端'],
  company_document: ['公司文件', '移除敏感資訊', 'AI 分析', '團隊知識庫'],
  custom: ['你的資料', '安全處理', 'AI 工具', '分享去向'],
};

const questions: Array<{
  key: keyof FlowPassInputs;
  number: string;
  label: string;
  hint: string;
  placeholder: string;
  required: boolean;
}> = [
  {
    key: 'materials',
    number: '01',
    label: '要處理什麼東西？',
    hint: '只要說資料類型，不必貼上實際內容。',
    placeholder: '例如：社員照片、訪談錄音、公司文件',
    required: true,
  },
  {
    key: 'intended_use',
    number: '02',
    label: '想用 AI 做什麼？',
    hint: '用一句話說明希望完成的工作。',
    placeholder: '例如：製作招生影片、整理訪談摘要',
    required: true,
  },
  {
    key: 'personal_or_sensitive_data',
    number: '03',
    label: '可能包含哪些個資或敏感資料？',
    hint:
      '不知道也可以留白，系統會列為待確認；密碼、API 金鑰或營業秘密也算敏感資料。',
    placeholder: '例如：人臉、姓名、聲音、營業秘密；不確定可留白',
    required: false,
  },
  {
    key: 'destination_and_audience',
    number: '04',
    label: '完成後要放哪裡／分享給誰？',
    hint: '尚未決定也可以留白。',
    placeholder: '例如：團隊雲端、客戶、公開社群',
    required: false,
  },
];

const layerStatusLabels: Record<LayerStatus, string> = {
  idle: '等待解析',
  pass: '通過',
  warning: '待確認',
  error: '有錯誤',
};

function getLayerStatus(
  result: FlowPassParseResult | null,
  category: IssueCategory,
): LayerStatus {
  if (!result) return 'idle';

  if (category === 'syntax') {
    if (result.status === 'invalid_json') return 'error';
  } else if (category === 'schema') {
    if (result.status === 'invalid_json') return 'idle';
    if (result.status === 'invalid_contract') return 'error';
  } else if (!result.passport) {
    return 'idle';
  } else if (category === 'graph' && result.status === 'invalid_graph') {
    return 'error';
  }

  const issues = result.issues.filter((issue) => issue.category === category);
  if (issues.some((issue) => issue.severity === 'error')) return 'error';
  if (issues.length > 0) return 'warning';
  return 'pass';
}

function ParserCheckLayers({
  result,
}: {
  result: FlowPassParseResult | null;
}) {
  const layers: Array<{
    category: IssueCategory;
    number: string;
    title: string;
    description: string;
  }> = [
    {
      category: 'syntax',
      number: '01',
      title: 'JSON 格式',
      description: '括號、引號與純 JSON',
    },
    {
      category: 'schema',
      number: '02',
      title: 'FlowPass 契約',
      description: '必要欄位、型別與版本',
    },
    {
      category: 'graph',
      number: '03',
      title: '節點連線',
      description: '引用、孤立節點與回流',
    },
    {
      category: 'readiness',
      number: '04',
      title: '待確認事項',
      description: '未知欄位與人工作業',
    },
  ];

  return (
    <ol className="check-layer-list" aria-label="解析檢查層級">
      {layers.map((layer) => {
        const status = getLayerStatus(result, layer.category);
        return (
          <li className={`layer-status-${status}`} key={layer.category}>
            <span>{layer.number}</span>
            <div>
              <strong>{layer.title}</strong>
              <small>{layer.description}</small>
            </div>
            <b>{layerStatusLabels[status]}</b>
          </li>
        );
      })}
    </ol>
  );
}

export default function Home() {
  const [workspaceMode, setWorkspaceMode] =
    useState<WorkspaceMode>('generate');
  const [inputMode, setInputMode] = useState<InputMode>('preset');
  const [selectedPreset, setSelectedPreset] =
    useState<Preset['id']>('recruitment_video');
  const [inputs, setInputs] = useState<FlowPassInputs>({
    ...presets[0].inputs,
  });
  const [promptResult, setPromptResult] = useState(() =>
    buildPromptJson(presets[0].inputs),
  );
  const [parserInput, setParserInput] = useState(FLOWPASS_SAMPLE_JSON);
  const [parseResult, setParseResult] =
    useState<FlowPassParseResult | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const isIncomplete = useMemo(
    () => !inputs.materials.trim() || !inputs.intended_use.trim(),
    [inputs.intended_use, inputs.materials],
  );
  const activeFlow =
    inputMode === 'custom' ? flowStages.custom : flowStages[selectedPreset];

  function choosePreset(id: Preset['id']) {
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;

    setInputMode('preset');
    setSelectedPreset(id);
    setInputs({ ...preset.inputs });
    setIsDirty(true);
    setCopyState('idle');
  }

  function chooseCustom() {
    setInputMode('custom');
    setInputs({ ...emptyInputs });
    setIsDirty(true);
    setCopyState('idle');
  }

  function updateInput(key: keyof FlowPassInputs, value: string) {
    setInputs((current) => ({ ...current, [key]: value }));
    setInputMode('custom');
    setIsDirty(true);
    setCopyState('idle');
  }

  function generate() {
    if (isIncomplete) return;

    setPromptResult(buildPromptJson(inputs));
    setIsDirty(false);
    setCopyState('idle');
  }

  async function copy() {
    if (isDirty) return;

    try {
      await navigator.clipboard.writeText(promptResult);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2200);
    } catch {
      setCopyState('error');
    }
  }

  function updateParserInput(value: string) {
    setParserInput(value);
    setParseResult(null);
  }

  function parsePassport() {
    setParseResult(parseFlowPassJson(parserInput));
  }

  function clearParser() {
    setParserInput('');
    setParseResult(null);
  }

  function loadParserSample() {
    setParserInput(FLOWPASS_SAMPLE_JSON);
    setParseResult(null);
  }

  const copyMessage =
    copyState === 'copied'
      ? 'JSON 已複製'
      : copyState === 'error'
        ? '無法自動複製，請直接選取 JSON。'
        : '';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            流
          </span>
          <div>
            <strong>竹流 FlowPass</strong>
            <span>AI 使用流向護照</span>
          </div>
        </div>
        <div className="file-trail" aria-label="目前檔案">
          <span>黑客松 MVP</span>
          <b aria-hidden="true">/</b>
          <strong>
            {workspaceMode === 'generate'
              ? 'Passport prompt.json'
              : 'Passport viewer.json'}
          </strong>
        </div>
        <div className="topbar-status">
          <span className="status-dot" aria-hidden="true" />
          {workspaceMode === 'generate' ? '本機草稿' : '本機解析'}
        </div>
      </header>

      <nav className="workspace-nav" aria-label="FlowPass 工作區">
        <div className="workspace-switch" role="group" aria-label="工作模式">
          <button
            type="button"
            className={workspaceMode === 'generate' ? 'active' : ''}
            aria-pressed={workspaceMode === 'generate'}
            onClick={() => setWorkspaceMode('generate')}
          >
            <span aria-hidden="true">01</span>
            產生提示詞
          </button>
          <button
            type="button"
            className={workspaceMode === 'parse' ? 'active' : ''}
            aria-pressed={workspaceMode === 'parse'}
            onClick={() => setWorkspaceMode('parse')}
          >
            <span aria-hidden="true">02</span>
            解析護照
          </button>
        </div>
        <p>
          <span aria-hidden="true">●</span>
          測試版 · 不上傳內容
        </p>
      </nav>

      <main
        className={
          workspaceMode === 'parse'
            ? 'editor-shell parser-shell'
            : 'editor-shell'
        }
      >
        <aside
          className="left-panel"
          aria-label={
            workspaceMode === 'generate' ? '情境與護照圖層' : '解析檢查層級'
          }
        >
          {workspaceMode === 'generate' ? (
            <>
          <div className="sidebar-heading">
            <span>FLOW TEMPLATES</span>
            <span className="sidebar-count">3 PRESETS</span>
          </div>

          <div className="preset-list" role="group" aria-label="情境範例">
            {presets.map((preset, index) => (
              <button
                key={preset.id}
                type="button"
                className={
                  inputMode === 'preset' && selectedPreset === preset.id
                    ? 'preset-row selected'
                    : 'preset-row'
                }
                aria-pressed={
                  inputMode === 'preset' && selectedPreset === preset.id
                }
                onClick={() => choosePreset(preset.id)}
              >
                <span className="layer-icon" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="preset-copy">
                  <strong>{preset.title}</strong>
                  <small>{preset.description}</small>
                </span>
                <span className="preset-badge">{preset.badge}</span>
              </button>
            ))}
          </div>

          <div className="layer-section">
            <p>護照資料圖層</p>
            <ul>
              <li>
                <span className="node-swatch data" />
                Materials
                <b>處理東西</b>
              </li>
              <li>
                <span className="node-swatch tool" />
                Intended use
                <b>使用目的</b>
              </li>
              <li>
                <span className="node-swatch flow" />
                Sensitive data
                <b>個資／機密</b>
              </li>
              <li>
                <span className="node-swatch action" />
                Destination
                <b>放置去向</b>
              </li>
            </ul>
          </div>

          <div className="privacy-card">
            <span aria-hidden="true">✓</span>
            <div>
              <strong>資料最小化</strong>
              <p>只填資料類型，不要貼上照片、錄音或文件內容。</p>
            </div>
          </div>
            </>
          ) : (
            <>
              <div className="sidebar-heading">
                <span>JSON CHECKS</span>
                <span className="sidebar-count">4 LAYERS</span>
              </div>
              <ParserCheckLayers result={parseResult} />
              <div className="parser-sidebar-note">
                <span aria-hidden="true">⌁</span>
                <div>
                  <strong>只在瀏覽器解析</strong>
                  <p>不會上傳、儲存或自動修正你貼上的內容。</p>
                </div>
              </div>
              <div className="privacy-card parser-privacy-card">
                <span aria-hidden="true">!</span>
                <div>
                  <strong>不要貼原始素材</strong>
                  <p>只貼 AI 回傳的資料類型與流向 JSON。</p>
                </div>
              </div>
            </>
          )}
        </aside>

        <section className="canvas-area" aria-labelledby="page-title">
          {workspaceMode === 'generate' ? (
            <>
          <div className="canvas-intro">
            <div>
              <span className="prototype-label">PROTOTYPE · 02</span>
              <h1 id="page-title">四個簡單問題，建立你的 AI 使用流向。</h1>
              <p>
                不用先想好完整流程。前兩題必填，其餘留白時會自動成為待確認問題。
              </p>
            </div>
          </div>

          <div className="canvas-stage">
            <article className="prompt-frame">
              <div className="frame-label">
                <span>FlowPass / Guided Input</span>
                <span>4 FIELDS</span>
              </div>

              <div className="mode-switch" role="group" aria-label="輸入方式">
                <button
                  type="button"
                  className={
                    inputMode === 'preset' ? 'mode-button active' : 'mode-button'
                  }
                  aria-pressed={inputMode === 'preset'}
                  onClick={() => choosePreset(selectedPreset)}
                >
                  使用範例
                </button>
                <button
                  type="button"
                  className={
                    inputMode === 'custom' ? 'mode-button active' : 'mode-button'
                  }
                  aria-pressed={inputMode === 'custom'}
                  onClick={chooseCustom}
                >
                  自行填寫
                </button>
              </div>

              <div className="question-grid">
                {questions.map((question) => (
                  <div className="question-card" key={question.key}>
                    <div className="question-header">
                      <span>{question.number}</span>
                      <div>
                        <label htmlFor={question.key}>{question.label}</label>
                        <small>
                          {question.required ? '必填' : '選填 · 可留白'}
                        </small>
                      </div>
                    </div>
                    <p id={`${question.key}-hint`}>{question.hint}</p>
                    <textarea
                      id={question.key}
                      aria-label={question.label}
                      aria-describedby={`${question.key}-hint`}
                      required={question.required}
                      value={inputs[question.key]}
                      onChange={(event) =>
                        updateInput(question.key, event.target.value)
                      }
                      placeholder={question.placeholder}
                      rows={3}
                    />
                  </div>
                ))}
              </div>

              <div className="flow-preview-label">
                <span>PREVIEW</span>
                系統將依答案建立節點與待確認事項
              </div>
              <div className="flow-preview" aria-label="預估資料流">
                {activeFlow.map((stage, index) => (
                  <div className="flow-step" key={stage}>
                    <span>{stage}</span>
                    {index < activeFlow.length - 1 && (
                      <i aria-hidden="true">→</i>
                    )}
                  </div>
                ))}
              </div>

              <div className="frame-footer">
                <p
                  id="required-fields-status"
                  className={
                    isIncomplete ? 'blank-hint visible' : 'blank-hint'
                  }
                >
                  請完成前兩個必填欄位
                </p>
                <button
                  type="button"
                  className="generate-button"
                  disabled={isIncomplete}
                  aria-describedby="required-fields-status"
                  onClick={generate}
                >
                  <span aria-hidden="true">✦</span>
                  產生護照 JSON
                </button>
              </div>

              <div className="guardrail-row">
                <span>AI 只建立草稿</span>
                <span>空白欄位保留未知</span>
                <span>最後由本人確認</span>
              </div>
            </article>
          </div>
            </>
          ) : (
            <>
              <div className="canvas-intro parser-intro">
                <div>
                  <span className="prototype-label">PROTOTYPE · 03</span>
                  <h1 id="page-title">
                    貼上 AI 回傳 JSON，查看資料去了哪裡。
                  </h1>
                  <p>
                    先檢查格式與節點引用，再把安全措施和待確認問題整理成可讀護照。
                  </p>
                </div>
              </div>

              <div className="canvas-stage parser-canvas-stage">
                <article className="prompt-frame parser-input-frame">
                  <div className="frame-label">
                    <span>FlowPass / Passport Parser</span>
                    <span>LOCAL ONLY</span>
                  </div>

                  <div className="parser-input-heading">
                    <div>
                      <label htmlFor="passport-json-input">AI 回傳 JSON</label>
                      <p id="passport-json-hint">
                        可直接貼上純 JSON；完整的 ```json code fence 也能辨識並提醒。
                      </p>
                    </div>
                    <div className="parser-utility-actions">
                      <button type="button" onClick={loadParserSample}>
                        載入範例 JSON
                      </button>
                      <button type="button" onClick={clearParser}>
                        清除 JSON
                      </button>
                    </div>
                  </div>

                  <textarea
                    id="passport-json-input"
                    className="parser-textarea"
                    aria-label="AI 回傳 JSON"
                    aria-describedby="passport-json-hint"
                    spellCheck={false}
                    value={parserInput}
                    onChange={(event) => updateParserInput(event.target.value)}
                  />

                  <div className="parser-submit-row">
                    <p>
                      <span aria-hidden="true">✓</span>
                      只解析結構，不判定補助、合規或安全。
                    </p>
                    <button
                      type="button"
                      className="generate-button parser-submit-button"
                      onClick={parsePassport}
                    >
                      <span aria-hidden="true">⌁</span>
                      開始解析護照
                    </button>
                  </div>
                </article>

                {parseResult?.passport ? (
                  <PassportViewer result={parseResult} section="flow" />
                ) : (
                  <section className="parser-placeholder" aria-live="polite">
                    <div className="placeholder-mark" aria-hidden="true">
                      {'{ }'}
                    </div>
                    <div>
                      <strong>
                        {parseResult
                          ? 'JSON 尚未通過格式檢查'
                          : '解析後會在這裡顯示資料流'}
                      </strong>
                      <p>
                        {parseResult
                          ? '請依右側錯誤路徑修正後，再重新解析。'
                          : '你會看到案例摘要、節點連線與孤立節點提示。'}
                      </p>
                    </div>
                  </section>
                )}
              </div>
            </>
          )}
        </section>

        <aside className="inspector-panel" aria-labelledby="inspector-heading">
          {workspaceMode === 'generate' ? (
            <>
          <div className="inspector-title">
            <div>
              <span>OUTPUT</span>
              <h2 id="inspector-heading">JSON Inspector</h2>
            </div>
            <span className="schema-pill">flowpass.prompt.v1</span>
          </div>

          <div className="property-grid">
            <span>Template</span>
            <strong>English</strong>
            <span>Inputs</span>
            <strong>4 separate fields</strong>
            <span>Decision</span>
            <strong>Human review</strong>
          </div>

          <div className="output-toolbar">
            <div>
              <span className="json-dot" aria-hidden="true">
                {'{ }'}
              </span>
              <strong>passport-prompt.json</strong>
            </div>
            <button
              type="button"
              className="copy-button"
              onClick={copy}
              disabled={isDirty}
            >
              複製 JSON
            </button>
          </div>

          <pre data-testid="json-output" tabIndex={0}>
            {promptResult}
          </pre>
          <p
            className={
              copyState === 'error' ? 'copy-status error' : 'copy-status'
            }
            role="status"
            aria-live="polite"
          >
            {isDirty
              ? '內容已變更，請重新產生 JSON。'
              : copyMessage || '可直接貼入支援 JSON 提示詞的 AI 工具。'}
          </p>
            </>
          ) : (
            <>
              <div className="inspector-title parser-inspector-title">
                <div>
                  <span>PARSED OUTPUT</span>
                  <h2 id="inspector-heading">Passport Viewer</h2>
                </div>
                <span className="schema-pill">flowpass_passport_draft</span>
              </div>
              {parseResult ? (
                <PassportViewer result={parseResult} section="details" />
              ) : (
                <div className="inspector-empty-state">
                  <span aria-hidden="true">⌁</span>
                  <strong>等待解析</strong>
                  <p>
                    按下「開始解析護照」後，這裡會顯示檢查結果、安全措施與待確認問題。
                  </p>
                  <ol>
                    <li>檢查 JSON 格式</li>
                    <li>驗證 FlowPass 欄位</li>
                    <li>核對節點與連線</li>
                    <li>整理人工待辦</li>
                  </ol>
                </div>
              )}
            </>
          )}
        </aside>
      </main>
    </div>
  );
}
