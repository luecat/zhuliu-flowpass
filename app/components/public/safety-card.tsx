'use client';

import { useEffect, useMemo, useState } from 'react';
import { PublicApiClient } from '../../lib/public-api';
import { applicantVisibleCopy } from './applicant-copy';

export type SafetyCardModel = {
  title: string;
  purpose: string;
  flow: string[];
  beforeUpload: string[];
  whileUsing: string[];
  beforePublish: string[];
  incidentSteps: Array<{ key: string; action: string }>;
  meta: { tool: string; audience: string; retention: string };
};

const AUDIENCE_LABELS: Record<string, string> = {
  self: '僅限本人',
  team: '團隊成員',
  client: '指定對象',
  public: '公開',
  unknown: '待確認',
};

const WIDTH = 1080;
const PAD = 64;
const FONT = '"PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif';
const COLOR = {
  ground: '#f5f4ef',
  panel: '#ffffff',
  line: '#d7e1dc',
  ink: '#1f2a24',
  muted: '#5f6f67',
  green: '#236b4b',
  greenSoft: '#e2f3ea',
  amberSoft: '#fff4d6',
  amberInk: '#6f4b00',
};

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines = 6): string[] {
  const lines: string[] = [];
  let line = '';
  for (const char of Array.from(text)) {
    const next = line + char;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = char.trim() ? char : '';
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && lines.join('').length < Array.from(text).length) {
    lines[maxLines - 1] = `${Array.from(lines[maxLines - 1]).slice(0, -1).join('')}…`;
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * `textBaseline: 'top'` is not reliably implemented the same way across canvas engines —
 * some Android WebViews (notably the one LINE's in-app browser embeds) position it closer
 * to a full line-height too high for CJK text, which is why titles were rendering above
 * their own panel. `alphabetic` is the one baseline every engine agrees on, so draw calls
 * add this fixed offset instead of trusting `top`.
 *
 * This is a plain constant, not `ctx.measureText(...).actualBoundingBoxAscent` — that metric
 * turned out to be just as unreliable cross-engine (it under-reported on the same Android
 * WebView, pulling text back up nearly flush with the panel's top edge). A fixed ratio can't
 * disagree with itself between engines; 0.9 leans generous so any remaining per-font slop
 * shows up as slightly more breathing room above the text, never less.
 */
const ASCENT_RATIO = 0.9;
function ascentOf(size: number): number {
  return size * ASCENT_RATIO;
}

/** Lays out the card; draws only when `draw` is true so the first pass can size the canvas. */
function layoutCard(ctx: CanvasRenderingContext2D, model: SafetyCardModel, draw: boolean): number {
  const inner = WIDTH - PAD * 2;
  let y = PAD;
  // `top` is passed in rather than read from the outer `y`: the production minifier folds
  // `y = a; y += text(...)` into `y = a + text(...)`, so a closure reading `y` saw the value
  // from *before* the assignment and drew every panel title BOX_PAD too high.
  const text = (value: string, x: number, top: number, size: number, color: string, weight = 400, maxWidth = inner, maxLines = 6, lineHeight = 1.45) => {
    ctx.font = `${weight} ${size}px ${FONT}`;
    const lines = wrap(ctx, value, maxWidth, maxLines);
    if (draw) {
      ctx.fillStyle = color;
      ctx.textBaseline = 'alphabetic';
      const ascent = ascentOf(size);
      lines.forEach((line, index) => ctx.fillText(line, x, top + index * size * lineHeight + ascent));
    }
    return lines.length * size * lineHeight;
  };

  if (draw) { ctx.fillStyle = COLOR.ground; ctx.fillRect(0, 0, WIDTH, ctx.canvas.height); }

  y += text('竹流 FlowPass · AI 安全使用卡', PAD, y, 28, COLOR.green, 700);
  y += 18;
  y += text(model.title, PAD, y, 56, COLOR.ink, 800, inner, 3, 1.25);
  y += 14;
  y += text(model.purpose, PAD, y, 30, COLOR.muted, 400, inner, 3);
  y += 40;

  const TITLE_SIZE = 34;
  const TITLE_LINE_HEIGHT = 1.3;
  const TITLE_GAP = 16;
  const ITEM_SIZE = 30;
  const ITEM_LINE_HEIGHT = 1.45;
  const ITEM_GAP = 14;
  const BOX_PAD = 36;
  const BADGE_RADIUS = 16;
  // Half the item font size centers the badge on a text line's ink rather than
  // its full leaded height (which would sit the badge visibly low).
  const BADGE_CENTER_OFFSET = ITEM_SIZE / 2;

  const panel = (title: string, items: string[], tone: 'plain' | 'amber', bullet: (index: number) => string) => {
    if (items.length === 0) return;
    const top = y;
    const textX = PAD + BOX_PAD + 44;
    const textWidth = inner - BOX_PAD * 2 - 44;
    // Measure first so the panel background can be drawn behind the text.
    ctx.font = `400 ${ITEM_SIZE}px ${FONT}`;
    const wrapped = items.map((item) => wrap(ctx, item, textWidth, 4));
    const itemsHeight = wrapped.reduce((total, lines) => total + lines.length * ITEM_SIZE * ITEM_LINE_HEIGHT, 0)
      + ITEM_GAP * (items.length - 1);
    const height = BOX_PAD + TITLE_SIZE * TITLE_LINE_HEIGHT + TITLE_GAP + itemsHeight + BOX_PAD;
    if (draw) {
      ctx.fillStyle = tone === 'amber' ? COLOR.amberSoft : COLOR.panel;
      roundRect(ctx, PAD, top, inner, height, 28);
      ctx.fill();
      if (tone === 'plain') { ctx.strokeStyle = COLOR.line; ctx.lineWidth = 2; ctx.stroke(); }
    }
    const titleTop = top + BOX_PAD;
    y = titleTop + text(title, PAD + BOX_PAD, titleTop, TITLE_SIZE, tone === 'amber' ? COLOR.amberInk : COLOR.green, 700, inner - BOX_PAD * 2, 1, TITLE_LINE_HEIGHT) + TITLE_GAP;
    wrapped.forEach((lines, index) => {
      if (draw) {
        ctx.fillStyle = tone === 'amber' ? COLOR.amberInk : COLOR.green;
        ctx.beginPath();
        ctx.arc(PAD + BOX_PAD + BADGE_RADIUS, y + BADGE_CENTER_OFFSET, BADGE_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `700 20px ${FONT}`;
        ctx.textAlign = 'center';
        // `middle` only needs to average ascent+descent, which engines agree on far more
        // consistently than `top` — the small ~7px sit-low this used to have is a much
        // safer failure mode here than reintroducing measured-metric drift.
        ctx.textBaseline = 'middle';
        ctx.fillText(bullet(index), PAD + BOX_PAD + BADGE_RADIUS, y + BADGE_CENTER_OFFSET);
        ctx.textAlign = 'left';
        ctx.font = `400 ${ITEM_SIZE}px ${FONT}`;
        ctx.fillStyle = COLOR.ink;
        ctx.textBaseline = 'alphabetic';
        const itemAscent = ascentOf(ITEM_SIZE);
        lines.forEach((line, lineIndex) => ctx.fillText(line, textX, y + lineIndex * ITEM_SIZE * ITEM_LINE_HEIGHT + itemAscent));
      }
      y += lines.length * ITEM_SIZE * ITEM_LINE_HEIGHT + (index < wrapped.length - 1 ? ITEM_GAP : 0);
    });
    y = top + height + 24;
  };

  panel('資料處理流程', model.flow, 'plain', (index) => String(index + 1));
  panel('上傳前', model.beforeUpload, 'plain', () => '✓');
  panel('使用中', model.whileUsing, 'plain', () => '✓');
  panel('公開前', model.beforePublish, 'plain', () => '✓');
  panel('遇到狀況時：停、隔、留、報、查', model.incidentSteps.map((step) => step.action), 'amber', (index) => model.incidentSteps[index]?.key ?? '');

  y += 8;
  y += text(`工具：${model.meta.tool}　分享對象：${model.meta.audience}　保存期間：${model.meta.retention}`, PAD, y, 26, COLOR.muted, 400, inner, 2);
  y += 6;
  y += text('依你的 FlowPass 護照產生，只記錄資料類型與流向，不含實際內容。', PAD, y, 24, COLOR.muted, 400, inner, 2);
  return Math.ceil(y + PAD);
}

function applicantModel(model: SafetyCardModel): SafetyCardModel {
  const copy = (value: string, fallback: string) => applicantVisibleCopy(value, fallback);
  return {
    ...model,
    title: copy(model.title, 'AI 使用流程'),
    purpose: copy(model.purpose, '依確認之護照與資料流程整理的安全重點'),
    flow: model.flow.map((item) => copy(item, '資料流程')),
    meta: {
      tool: copy(model.meta.tool, '待確認'),
      audience: AUDIENCE_LABELS[model.meta.audience] ?? copy(model.meta.audience, '待確認'),
      retention: copy(model.meta.retention, '待確認'),
    },
  };
}

async function renderCard(model: SafetyCardModel): Promise<{ dataUrl: string; blob: Blob }> {
  const measure = document.createElement('canvas');
  measure.width = WIDTH;
  measure.height = 10;
  const measureCtx = measure.getContext('2d');
  if (!measureCtx) throw new Error('canvas unavailable');
  const height = layoutCard(measureCtx, model, false);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  layoutCard(ctx, model, true);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas export failed');
  return { dataUrl: canvas.toDataURL('image/png'), blob };
}

type CardState =
  | { kind: 'loading' }
  | { kind: 'ready'; dataUrl: string; blob: Blob; title: string }
  | { kind: 'error' };

export function SafetyCard({ caseId }: { caseId: string }) {
  const api = useMemo(() => new PublicApiClient(), []);
  const [state, setState] = useState<CardState>({ kind: 'loading' });
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void api.read<{ model: SafetyCardModel }>(`/api/v1/cases/${encodeURIComponent(caseId)}/safety-card`)
      .then(async ({ model }) => {
        const visible = applicantModel(model);
        const image = await renderCard(visible);
        if (active) setState({ kind: 'ready', ...image, title: visible.title });
      })
      .catch(() => { if (active) setState({ kind: 'error' }); });
    return () => { active = false; };
  }, [api, caseId]);

  async function save() {
    if (state.kind !== 'ready') return;
    const file = new File([state.blob], 'flowpass-安全使用卡.png', { type: 'image/png' });
    if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'AI 安全使用卡' });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    const link = document.createElement('a');
    link.href = state.dataUrl;
    link.download = 'flowpass-safety-card.png';
    document.body.append(link);
    link.click();
    link.remove();
    setNotice('如果沒有開始下載，請長按上方圖卡，選擇「儲存圖片」。');
  }

  if (state.kind === 'loading') return <div className="applicant-inline-state" role="status">正在產生安全使用卡…</div>;
  if (state.kind === 'error') return <div className="applicant-inline-state applicant-inline-state--error" role="alert"><p>安全使用卡暫時無法產生，請稍後再試。</p></div>;
  return (
    <div className="applicant-safety-card">
      {/* A locally rendered data URL; next/image cannot optimize it and would break long-press saving. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={state.dataUrl} alt={`AI 安全使用卡：${state.title}`} />
      <div className="applicant-safety-card-actions">
        <button type="button" className="primary-action" onClick={() => void save()}>儲存圖卡</button>
        <p>在 LINE 裡也可以長按圖卡，選擇「儲存圖片」。</p>
      </div>
      {notice && <p className="applicant-safety-card-notice" role="status">{notice}</p>}
    </div>
  );
}
