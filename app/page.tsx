'use client';

import { useMemo, useState } from 'react';
import {
  buildPromptJson,
  presets,
  type FlowPassInputs,
  type Preset,
} from './prompt-builder';

type Mode = 'preset' | 'custom';
type CopyState = 'idle' | 'copied' | 'error';

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

export default function Home() {
  const [mode, setMode] = useState<Mode>('preset');
  const [selectedPreset, setSelectedPreset] =
    useState<Preset['id']>('recruitment_video');
  const [inputs, setInputs] = useState<FlowPassInputs>({
    ...presets[0].inputs,
  });
  const [result, setResult] = useState(() =>
    buildPromptJson(presets[0].inputs),
  );
  const [isDirty, setIsDirty] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const isIncomplete = useMemo(
    () => !inputs.materials.trim() || !inputs.intended_use.trim(),
    [inputs.intended_use, inputs.materials],
  );
  const activeFlow =
    mode === 'custom' ? flowStages.custom : flowStages[selectedPreset];

  function choosePreset(id: Preset['id']) {
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;

    setMode('preset');
    setSelectedPreset(id);
    setInputs({ ...preset.inputs });
    setIsDirty(true);
    setCopyState('idle');
  }

  function chooseCustom() {
    setMode('custom');
    setInputs({ ...emptyInputs });
    setIsDirty(true);
    setCopyState('idle');
  }

  function updateInput(key: keyof FlowPassInputs, value: string) {
    setInputs((current) => ({ ...current, [key]: value }));
    setMode('custom');
    setIsDirty(true);
    setCopyState('idle');
  }

  function generate() {
    if (isIncomplete) return;

    setResult(buildPromptJson(inputs));
    setIsDirty(false);
    setCopyState('idle');
  }

  async function copy() {
    if (isDirty) return;

    try {
      await navigator.clipboard.writeText(result);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2200);
    } catch {
      setCopyState('error');
    }
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
          <strong>Passport prompt.json</strong>
        </div>
        <div className="topbar-status">
          <span className="status-dot" aria-hidden="true" />
          本機草稿
        </div>
      </header>

      <main className="editor-shell">
        <aside className="left-panel" aria-label="情境與護照圖層">
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
                  mode === 'preset' && selectedPreset === preset.id
                    ? 'preset-row selected'
                    : 'preset-row'
                }
                aria-pressed={
                  mode === 'preset' && selectedPreset === preset.id
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
        </aside>

        <section className="canvas-area" aria-labelledby="page-title">
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
                    mode === 'preset' ? 'mode-button active' : 'mode-button'
                  }
                  aria-pressed={mode === 'preset'}
                  onClick={() => choosePreset(selectedPreset)}
                >
                  使用範例
                </button>
                <button
                  type="button"
                  className={
                    mode === 'custom' ? 'mode-button active' : 'mode-button'
                  }
                  aria-pressed={mode === 'custom'}
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
        </section>

        <aside className="inspector-panel" aria-labelledby="inspector-heading">
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
            {result}
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
        </aside>
      </main>
    </div>
  );
}
