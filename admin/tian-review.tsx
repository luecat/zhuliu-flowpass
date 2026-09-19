import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { api } from './api';
import { record, evaluationOf, attachmentOf, string, number } from './parsers';
import type { Attachment, Case, Review, ReviewDecision, RuleEvaluationView } from './types';
import { REVIEWS } from './types';
import { attachmentLabel, bytes, money, outcomeLabel, ruleLabel } from './format';
import { ReviewActions } from './review-actions';

type PurchaseDetails = {
  softwareName?: string;
  companyName?: string;
  purchaseDate?: string;
  originalCurrency?: string;
  otherCurrency?: string | null;
  originalExpense?: string;
  convertedTwd?: number;
  invoiceNumber?: string | null;
  receiptBuyerName?: string | null;
  applicantName?: string | null;
  nationalId?: string | null;
  householdAddress?: string | null;
};

type SlotRef =
  | { kind: 'none' }
  | { kind: 'eval'; id: string }
  | { kind: 'doc'; id: string };

type SlotId = 'a' | 'b';

type Verdict = 'good' | 'bad' | null;

type SavedIssue = {
  key: string;
  label: string;
  reason: string;
};

type LayoutSize = { col: number; row: number; side: number };

function sameRef(left: SlotRef, right: SlotRef): boolean {
  if (left.kind === 'none' || right.kind === 'none') return left.kind === right.kind;
  return left.kind === right.kind && left.id === right.id;
}

/** Put an item only into its own column. Left never writes right, and vice versa. */
function assignToSlot(
  slots: { a: SlotRef; b: SlotRef },
  slot: SlotId,
  next: SlotRef,
): { a: SlotRef; b: SlotRef } {
  if (sameRef(slots[slot], next)) {
    return slot === 'a' ? { a: { kind: 'none' }, b: slots.b } : { a: slots.a, b: { kind: 'none' } };
  }
  return slot === 'a' ? { a: next, b: slots.b } : { a: slots.a, b: next };
}

function isInLeft(slots: { a: SlotRef; b: SlotRef }, ref: SlotRef): boolean {
  return ref.kind !== 'none' && sameRef(slots.a, ref);
}

function isInRight(slots: { a: SlotRef; b: SlotRef }, ref: SlotRef): boolean {
  return ref.kind !== 'none' && sameRef(slots.b, ref);
}

const SIMILARITY_RULES = new Set([
  'invoice_fingerprint',
  'transaction_fingerprint',
  'payment_source_fingerprint',
  'invoice_duplicate',
]);

/** Preferred attachment requirement keys for each 勾稽 rule (first match wins). */
const RULE_ATTACHMENT_KEYS: Record<string, string[]> = {
  invoice_fingerprint: ['vendor_receipt', 'purchase_proof'],
  invoice_duplicate: ['vendor_receipt', 'purchase_proof'],
  transaction_fingerprint: ['card_transaction', 'purchase_proof'],
  payment_source_fingerprint: ['card_transaction', 'purchase_proof'],
  applicant_name_consistency: ['vendor_receipt', 'identity_front', 'purchase_proof'],
  exchange_rate_reasonableness: ['card_transaction', 'vendor_receipt', 'purchase_proof'],
  purchase_window: ['vendor_receipt', 'purchase_proof'],
  tool_consistency: ['vendor_receipt', 'purchase_proof'],
  age_eligibility: ['identity_front', 'identity_back'],
  household_address: ['identity_front', 'identity_back'],
  national_id: ['identity_front', 'identity_back'],
};

function relatedDocumentForRule(ruleCode: string, docs: Attachment[]): Attachment | null {
  const preferred = RULE_ATTACHMENT_KEYS[ruleCode];
  const ready = docs.filter((doc) => doc.status === 'ready');
  if (preferred) {
    for (const key of preferred) {
      const match = ready.find((doc) => doc.requirementKey === key);
      if (match) return match;
    }
  }
  // Fallback: invoice-ish rules → first invoice; otherwise first ready doc.
  if (ruleCode.includes('invoice') || ruleCode.includes('receipt') || ruleCode === 'tool_consistency') {
    return ready.find((doc) => doc.kind === 'invoice') ?? ready[0] ?? null;
  }
  if (ruleCode.includes('transaction') || ruleCode.includes('payment') || ruleCode.includes('exchange')) {
    return (
      ready.find((doc) => doc.requirementKey === 'card_transaction') ??
      ready.find((doc) => doc.kind === 'invoice') ??
      ready[0] ??
      null
    );
  }
  return ready[0] ?? null;
}

const LAYOUT_KEY = 'flowpass.admin.tian.layout';
const DEFAULT_LAYOUT: LayoutSize = { col: 53, row: 76, side: 216 };
const MIN_PCT = 22;
const MAX_PCT = 78;
const MIN_SIDE = 208;
const MAX_SIDE = 380;

function purchaseDetailsOf(value: unknown): PurchaseDetails | null {
  if (value === null) return null;
  const v = record(value);
  return {
    softwareName: string(v.softwareName),
    companyName: string(v.companyName),
    purchaseDate: string(v.purchaseDate),
    originalCurrency: string(v.originalCurrency),
    otherCurrency: string(v.otherCurrency) ?? null,
    originalExpense: string(v.originalExpense),
    convertedTwd: number(v.convertedTwd),
    invoiceNumber: string(v.invoiceNumber) ?? null,
    receiptBuyerName: string(v.receiptBuyerName) ?? null,
    applicantName: string(v.applicantName) ?? null,
    nationalId: string(v.nationalId) ?? null,
    householdAddress: string(v.householdAddress) ?? null,
  };
}

function documentUrl(id: string) {
  return `/admin/v1/documents/${encodeURIComponent(id)}/content`;
}

function matchedCaseCodes(item: RuleEvaluationView): string[] {
  const blob = [item.explanation, ...item.steps.map((step) => step.value)].join(' ');
  return [...new Set([...blob.matchAll(/FP-\d{8}-[A-Z0-9]+/g)].map((match) => match[0]))];
}

function isSimilarity(item: RuleEvaluationView) {
  return SIMILARITY_RULES.has(item.ruleCode) && item.outcome === 'needs_review';
}

function readLayout(): LayoutSize {
  try {
    const raw = window.localStorage?.getItem(LAYOUT_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<LayoutSize>;
    const col = typeof parsed.col === 'number' ? parsed.col : DEFAULT_LAYOUT.col;
    const row = typeof parsed.row === 'number' ? parsed.row : DEFAULT_LAYOUT.row;
    const side = typeof parsed.side === 'number' ? parsed.side : DEFAULT_LAYOUT.side;
    return {
      col: Math.min(MAX_PCT, Math.max(MIN_PCT, col)),
      row: Math.min(MAX_PCT, Math.max(MIN_PCT, row)),
      side: Math.min(MAX_SIDE, Math.max(MIN_SIDE, side)),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function DocPreview({ doc }: { doc: Attachment }) {
  const title = attachmentLabel(doc);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const naturalRef = useRef({ w: 0, h: 0 });
  const viewRef = useRef({ scale: 1, x: 0, y: 0 });
  const pinchRef = useRef<{
    startDist: number;
    startScale: number;
    startX: number;
    startY: number;
    midX: number;
    midY: number;
  } | null>(null);
  const panRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const lastTapRef = useRef(0);

  const layoutImage = () => {
    const stage = stageRef.current;
    const img = imgRef.current;
    const { w: nw, h: nh } = naturalRef.current;
    if (!stage || !img || nw <= 0 || nh <= 0) return;

    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (sw <= 0 || sh <= 0) return;

    // Fit-to-box without upscaling at rest; zoom grows CSS size toward native pixels.
    const contain = Math.min(sw / nw, sh / nh);
    const fit = Math.min(contain, 1);
    const maxScale = Math.max(1, 1 / Math.max(contain, 1e-6));
    let scale = Math.min(maxScale, Math.max(1, viewRef.current.scale));
    if (scale <= 1.02) scale = 1;
    viewRef.current.scale = scale;

    const dw = nw * fit * scale;
    const dh = nh * fit * scale;
    let { x, y } = viewRef.current;

    if (scale <= 1) {
      x = (sw - dw) / 2;
      y = (sh - dh) / 2;
    } else {
      if (dw >= sw) x = Math.min(0, Math.max(sw - dw, x));
      else x = (sw - dw) / 2;
      if (dh >= sh) y = Math.min(0, Math.max(sh - dh, y));
      else y = (sh - dh) / 2;
    }
    viewRef.current.x = x;
    viewRef.current.y = y;

    img.style.width = `${dw}px`;
    img.style.height = `${dh}px`;
    img.style.transform = `translate(${x}px, ${y}px)`;
  };

  const resetView = () => {
    viewRef.current = { scale: 1, x: 0, y: 0 };
    layoutImage();
  };

  const zoomAround = (nextScale: number, midX: number, midY: number) => {
    const stage = stageRef.current;
    const { w: nw, h: nh } = naturalRef.current;
    if (!stage || nw <= 0 || nh <= 0) return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const contain = Math.min(sw / nw, sh / nh);
    const maxScale = Math.max(1, 1 / Math.max(contain, 1e-6));
    const prev = viewRef.current.scale;
    const scale = Math.min(maxScale, Math.max(1, nextScale));
    const ratio = scale / Math.max(prev, 1e-6);
    viewRef.current.scale = scale;
    viewRef.current.x = midX - (midX - viewRef.current.x) * ratio;
    viewRef.current.y = midY - (midY - viewRef.current.y) * ratio;
    layoutImage();
  };

  useEffect(() => {
    naturalRef.current = { w: 0, h: 0 };
    resetView();
  }, [doc.id]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || doc.mediaType === 'application/pdf') return;

    const touchDist = (a: Touch, b: Touch) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const touchMid = (a: Touch, b: Touch) => ({
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2,
    });

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        panRef.current = null;
        const rect = stage.getBoundingClientRect();
        const mid = touchMid(event.touches[0], event.touches[1]);
        pinchRef.current = {
          startDist: Math.max(1, touchDist(event.touches[0], event.touches[1])),
          startScale: viewRef.current.scale,
          startX: viewRef.current.x,
          startY: viewRef.current.y,
          midX: mid.x - rect.left,
          midY: mid.y - rect.top,
        };
        return;
      }
      if (event.touches.length === 1 && viewRef.current.scale > 1) {
        pinchRef.current = null;
        panRef.current = {
          startX: event.touches[0].clientX,
          startY: event.touches[0].clientY,
          origX: viewRef.current.x,
          origY: viewRef.current.y,
        };
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length >= 2 && pinchRef.current) {
        event.preventDefault();
        const pinch = pinchRef.current;
        const rect = stage.getBoundingClientRect();
        const mid = touchMid(event.touches[0], event.touches[1]);
        const midX = mid.x - rect.left;
        const midY = mid.y - rect.top;
        const nextScale = pinch.startScale * (touchDist(event.touches[0], event.touches[1]) / pinch.startDist);
        // Keep the original pinch midpoint under the fingers while scaling.
        const { w: nw, h: nh } = naturalRef.current;
        const contain = Math.min(stage.clientWidth / nw, stage.clientHeight / nh);
        const maxScale = Math.max(1, 1 / Math.max(contain, 1e-6));
        const scale = Math.min(maxScale, Math.max(1, nextScale));
        const ratio = scale / pinch.startScale;
        viewRef.current.scale = scale;
        viewRef.current.x = midX - (pinch.midX - pinch.startX) * ratio;
        viewRef.current.y = midY - (pinch.midY - pinch.startY) * ratio;
        layoutImage();
        return;
      }
      if (event.touches.length === 1 && panRef.current && viewRef.current.scale > 1) {
        event.preventDefault();
        const pan = panRef.current;
        viewRef.current.x = pan.origX + (event.touches[0].clientX - pan.startX);
        viewRef.current.y = pan.origY + (event.touches[0].clientY - pan.startY);
        layoutImage();
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinchRef.current = null;
      if (event.touches.length === 0) {
        panRef.current = null;
        layoutImage();
      } else if (event.touches.length === 1 && viewRef.current.scale > 1) {
        panRef.current = {
          startX: event.touches[0].clientX,
          startY: event.touches[0].clientY,
          origX: viewRef.current.x,
          origY: viewRef.current.y,
        };
      }
    };

    const blockBrowserGesture = (event: Event) => {
      event.preventDefault();
    };

    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoomAround(
        viewRef.current.scale * Math.exp(-event.deltaY * 0.01),
        event.clientX - rect.left,
        event.clientY - rect.top,
      );
    };

    const onDoubleClick = (event: MouseEvent) => {
      event.preventDefault();
      resetView();
    };

    const onTouchEndTap = (event: TouchEvent) => {
      if (event.touches.length > 0 || event.changedTouches.length !== 1) return;
      const now = Date.now();
      if (now - lastTapRef.current < 280) {
        resetView();
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
      }
    };

    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => layoutImage());
    ro?.observe(stage);

    stage.addEventListener('touchstart', onTouchStart, { passive: true });
    stage.addEventListener('touchmove', onTouchMove, { passive: false });
    stage.addEventListener('touchend', onTouchEnd);
    stage.addEventListener('touchend', onTouchEndTap);
    stage.addEventListener('touchcancel', onTouchEnd);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('dblclick', onDoubleClick);
    stage.addEventListener('gesturestart', blockBrowserGesture);
    stage.addEventListener('gesturechange', blockBrowserGesture);
    stage.addEventListener('gestureend', blockBrowserGesture);

    return () => {
      ro?.disconnect();
      stage.removeEventListener('touchstart', onTouchStart);
      stage.removeEventListener('touchmove', onTouchMove);
      stage.removeEventListener('touchend', onTouchEnd);
      stage.removeEventListener('touchend', onTouchEndTap);
      stage.removeEventListener('touchcancel', onTouchEnd);
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('dblclick', onDoubleClick);
      stage.removeEventListener('gesturestart', blockBrowserGesture);
      stage.removeEventListener('gesturechange', blockBrowserGesture);
      stage.removeEventListener('gestureend', blockBrowserGesture);
    };
  }, [doc.id, doc.mediaType]);

  if (doc.status !== 'ready') {
    return <p className="tian-idle">此附件尚無法預覽（{doc.status}）。</p>;
  }

  const isPdf = doc.mediaType === 'application/pdf';

  return (
    <div
      ref={stageRef}
      className={`tian-preview${isPdf ? ' is-pdf' : ' is-pinch'}`}
      aria-label={isPdf ? title : `${title}（框內雙指縮放）`}
    >
      {isPdf ? (
        <iframe className="tian-frame" src={documentUrl(doc.id)} title={title} />
      ) : (
        // Admin is Vite SPA, not Next.js.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          className="tian-img"
          src={documentUrl(doc.id)}
          alt={title}
          draggable={false}
          decoding="async"
          onLoad={(event) => {
            const image = event.currentTarget;
            naturalRef.current = {
              w: image.naturalWidth || 0,
              h: image.naturalHeight || 0,
            };
            resetView();
          }}
        />
      )}
    </div>
  );
}

export function TianReview({
  item,
  busy,
  error: panelError,
  clearError,
  close,
  update,
}: {
  item: Case;
  busy: boolean;
  error: string;
  clearError: () => void;
  close: () => void;
  update: (review: Review, decision: ReviewDecision) => Promise<void>;
}) {
  const [slots, setSlots] = useState<{ a: SlotRef; b: SlotRef }>({ a: { kind: 'none' }, b: { kind: 'none' } });
  const [focusSlot, setFocusSlot] = useState<SlotId>('a');
  const [evaluations, setEvaluations] = useState<RuleEvaluationView[]>([]);
  const [documents, setDocuments] = useState<Attachment[]>([]);
  const [details, setDetails] = useState<PurchaseDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [draftReason, setDraftReason] = useState('');
  const [savedNotice, setSavedNotice] = useState('');
  const [completeOpen, setCompleteOpen] = useState(false);
  const [supplementBusy, setSupplementBusy] = useState(false);
  const [layout, setLayout] = useState<LayoutSize>(() =>
    typeof window === 'undefined' ? DEFAULT_LAYOUT : readLayout(),
  );
  const gridRef = useRef<HTMLDivElement>(null);
  const completeDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      api<unknown>(`/admin/v1/cases/${encodeURIComponent(item.id)}/evaluations`),
      api<unknown>(`/admin/v1/cases/${encodeURIComponent(item.id)}/documents`),
      api<unknown>(`/admin/v1/cases/${encodeURIComponent(item.id)}/purchase-details`),
    ])
      .then(([evalValue, docsValue, purchaseValue]) => {
        if (!active) return;
        const evalData = record(evalValue);
        const docsData = record(docsValue);
        setEvaluations(
          (Array.isArray(evalData.evaluations) ? evalData.evaluations : [])
            .map(evaluationOf)
            .filter((value): value is RuleEvaluationView => value !== null),
        );
        setDocuments(
          (Array.isArray(docsData.documents) ? docsData.documents : [])
            .map(attachmentOf)
            .filter((value): value is Attachment => value !== null),
        );
        setDetails(purchaseDetailsOf(record(purchaseValue).purchaseDetails ?? null));
      })
      .catch(() => {
        if (active) setError('核對資料暫時無法載入。');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [item.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.querySelector('dialog[open]')) return;
      if (completeOpen) {
        event.preventDefault();
        setCompleteOpen(false);
        return;
      }
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, completeOpen]);

  useEffect(() => {
    if (!completeOpen) return;
    const dialog = completeDialog.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    const timer = window.setTimeout(() => dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [completeOpen]);

  useEffect(() => {
    try {
      window.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Ignore persistence failures in restricted environments.
    }
  }, [layout]);

  const orderedEvals = useMemo(() => {
    // `rule_evaluations` is append-only, so re-running a rule leaves older rows behind. The API
    // returns them newest first; keep the newest of each set that would render identically.
    const seen = new Set<string>();
    const latest = evaluations.filter((value) => {
      const key = JSON.stringify([value.ruleCode, value.outcome, value.explanation, value.steps]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return latest.sort((left, right) => {
      const rank = (outcome: string) =>
        outcome === 'needs_review' ? 0 : outcome === 'fail' ? 1 : outcome === 'missing' ? 2 : 3;
      return rank(left.outcome) - rank(right.outcome);
    });
  }, [evaluations]);

  const flaggedCount = orderedEvals.filter(
    (value) => value.outcome === 'needs_review' || value.outcome === 'fail',
  ).length;

  /**
   * One requirement holds one file. Older uploads are superseded on the server now, but cases
   * uploaded before that still carry the earlier rows, so keep the newest of each here too.
   * The API returns documents newest first.
   */
  const currentDocuments = useMemo(() => {
    const seen = new Set<string>();
    return documents.filter((doc) => {
      const key = doc.requirementKey ?? `id:${doc.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [documents]);

  /** Sidebar grouping: the two rows a reviewer must act on first, then the rest. */
  const evalGroups = useMemo(() => {
    const bucket = (outcome: string) =>
      outcome === 'needs_review' || outcome === 'fail'
        ? '待人工確認'
        : outcome === 'missing'
          ? '資料待補'
          : '已通過';
    return (['待人工確認', '資料待補', '已通過'] as const)
      .map((title) => ({ title, items: orderedEvals.filter((value) => bucket(value.outcome) === title) }))
      .filter((group) => group.items.length > 0);
  }, [orderedEvals]);

  const focusRef = slots[focusSlot];
  const selectedEval =
    focusRef.kind === 'eval' ? orderedEvals.find((value) => value.id === focusRef.id) ?? null : null;
  const verdictKey =
    focusRef.kind === 'eval'
      ? `eval:${focusRef.id}`
      : focusRef.kind === 'doc'
        ? `doc:${focusRef.id}`
        : '';
  const verdict = verdictKey ? (verdicts[verdictKey] ?? null) : null;
  const canRequestDocuments =
    item.state === 'under_review' &&
    REVIEWS.some((review) => review.action === 'request_documents' && review.fromStates.includes(item.state));
  const savedIssues: SavedIssue[] = Object.entries(reasons)
    .filter(([, reason]) => reason.trim().length > 0)
    .map(([key, reason]) => {
      if (key.startsWith('doc:')) {
        const doc = documents.find((value) => value.id === key.slice(4));
        return { key, label: doc ? attachmentLabel(doc) : '附件', reason: reason.trim() };
      }
      if (key.startsWith('eval:')) {
        const evalItem = evaluations.find((value) => value.id === key.slice(5));
        return { key, label: evalItem ? ruleLabel(evalItem.ruleCode) : '勾稽項目', reason: reason.trim() };
      }
      return { key, label: '核對項目', reason: reason.trim() };
    });

  const pickInto = (slot: SlotId, next: SlotRef) => {
    // Left = 勾稽 only; right = 附件 only. Clicking 勾稽 also auto-fills the related attachment on the right.
    if (slot === 'a' && next.kind === 'eval') {
      const clearing = sameRef(slots.a, next);
      if (clearing) {
        setSlots({ a: { kind: 'none' }, b: slots.b });
        setFocusSlot('a');
        setDraftReason('');
        setSavedNotice('');
        return;
      }
      const evalItem = orderedEvals.find((value) => value.id === next.id);
      const related = evalItem ? relatedDocumentForRule(evalItem.ruleCode, currentDocuments) : null;
      const nextSlots = {
        a: next,
        b: related ? ({ kind: 'doc', id: related.id } as SlotRef) : slots.b,
      };
      setSlots(nextSlots);
      setFocusSlot('a');
      setDraftReason(reasons[`eval:${next.id}`] ?? '');
      setSavedNotice('');
      return;
    }

    const assigned = assignToSlot(slots, slot, next);
    setSlots(assigned);
    setFocusSlot(slot);
    const focused = assigned[slot];
    if (focused.kind === 'eval') setDraftReason(reasons[`eval:${focused.id}`] ?? '');
    else if (focused.kind === 'doc') setDraftReason(reasons[`doc:${focused.id}`] ?? '');
    else setDraftReason('');
    setSavedNotice('');
  };

  const setVerdict = (next: Verdict) => {
    if (!verdictKey) return;
    setVerdicts((prev) => ({ ...prev, [verdictKey]: next }));
    if (next !== 'bad') {
      setDraftReason('');
      setReasons((prev) => {
        const copy = { ...prev };
        delete copy[verdictKey];
        return copy;
      });
      setSavedNotice('');
    }
  };

  const saveIssue = () => {
    if (!verdictKey || !draftReason.trim()) return;
    setVerdicts((prev) => ({ ...prev, [verdictKey]: 'bad' }));
    setReasons((prev) => ({ ...prev, [verdictKey]: draftReason.trim() }));
    setSavedNotice('已儲存此項核對結果。');
  };

  const closeComplete = () => {
    const dialog = completeDialog.current;
    if (dialog?.open && typeof dialog.close === 'function') dialog.close();
    setCompleteOpen(false);
  };

  const confirmSupplement = async () => {
    const review = REVIEWS.find((value) => value.action === 'request_documents');
    if (!review || savedIssues.length === 0 || !canRequestDocuments) return;
    setSupplementBusy(true);
    try {
      const title = savedIssues.map((issue) => issue.label).join('、');
      const instructions = savedIssues.map((issue) => `・${issue.label}：${issue.reason}`).join('\n');
      await update(review, {
        title: title.slice(0, 200),
        instructions,
        reason: instructions,
      });
      closeComplete();
      close();
    } finally {
      setSupplementBusy(false);
    }
  };

  const beginResize = (axis: 'col' | 'row' | 'side', event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const grid = gridRef.current;
    if (!grid) return;
    const rect = grid.getBoundingClientRect();
    const start = axis === 'row' ? event.clientY : event.clientX;
    const base = layout[axis];
    event.currentTarget.setPointerCapture(event.pointerId);
    const onMove = (moveEvent: PointerEvent) => {
      if (axis === 'side') {
        const next = Math.min(MAX_SIDE, Math.max(MIN_SIDE, base + (moveEvent.clientX - start)));
        setLayout((prev) => ({ ...prev, side: next }));
        return;
      }
      const delta =
        axis === 'col'
          ? ((moveEvent.clientX - start) / rect.width) * 100
          : ((moveEvent.clientY - start) / rect.height) * 100;
      const next = Math.min(MAX_PCT, Math.max(MIN_PCT, base + delta));
      setLayout((prev) => (axis === 'col' ? { ...prev, col: next } : { ...prev, row: next }));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const formFields = (
    <dl className="tian-fields">
      <div>
        <dt>申請人</dt>
        <dd>{details?.applicantName ?? item.applicantName ?? '—'}</dd>
      </div>
      <div className="is-key">
        <dt>身分證字號</dt>
        <dd>{details?.nationalId ?? '—'}</dd>
      </div>
      <div>
        <dt>戶籍地址</dt>
        <dd>{details?.householdAddress ?? '—'}</dd>
      </div>
      <div className="is-key">
        <dt>發票號碼</dt>
        <dd>{details?.invoiceNumber ?? '未填寫'}</dd>
      </div>
      <div className="is-key">
        <dt>銀行付款實付台幣</dt>
        <dd>{money(details?.convertedTwd ?? item.requestedAmountTwd)}</dd>
      </div>
      <div>
        <dt>軟體名稱</dt>
        <dd>{details?.softwareName ?? '—'}</dd>
      </div>
      <div>
        <dt>供應商</dt>
        <dd>{details?.companyName ?? '—'}</dd>
      </div>
      <div>
        <dt>購買日期</dt>
        <dd>{details?.purchaseDate ?? '—'}</dd>
      </div>
      <div>
        <dt>收據買受人</dt>
        <dd>{details?.receiptBuyerName ?? '—'}</dd>
      </div>
    </dl>
  );

  const verdictPanel = (labels: { good: string; bad: string }) =>
    verdictKey ? (
      <div className="tian-verdict">
        {selectedEval?.explanation && <p className="tian-muted">{selectedEval.explanation}</p>}
        <div className="tian-verdict-row">
          <button type="button" className={verdict === 'good' ? 'is-on' : ''} onClick={() => setVerdict('good')}>
            {labels.good}
          </button>
          <button
            type="button"
            className={verdict === 'bad' || reasons[verdictKey] ? 'is-on is-bad' : ''}
            onClick={() => setVerdict('bad')}
          >
            {labels.bad}
          </button>
        </div>
        {(verdict === 'bad' || reasons[verdictKey]) && (
          <div className="tian-followup">
            <label htmlFor={`tian-reason-${focusSlot}`}>補件原因（會顯示給申請人）</label>
            <textarea
              id={`tian-reason-${focusSlot}`}
              rows={3}
              value={draftReason}
              onChange={(event) => {
                setDraftReason(event.target.value);
                setSavedNotice('');
              }}
              placeholder="例如：發票金額與填寫金額不符"
            />
            <button type="button" className="tian-save" disabled={!draftReason.trim()} onClick={saveIssue}>
              儲存
            </button>
            {savedNotice && <p className="tian-muted">{savedNotice}</p>}
          </div>
        )}
      </div>
    ) : null;

  const renderSlot = (slotId: SlotId) => {
    const ref = slots[slotId];
    const focused = focusSlot === slotId;
    const title = slotId === 'a' ? '左上' : '右上';

    if (ref.kind === 'none') {
      return (
        <div className={`tian-slot${focused ? ' is-focus' : ''}`}>
          <button type="button" className="tian-slot-select" aria-pressed={focused} onClick={() => setFocusSlot(slotId)}>
            <span>{title}</span>
            <em>表單資料（未選）</em>
          </button>
          <div className="tian-slot-body">{formFields}</div>
        </div>
      );
    }

    if (ref.kind === 'doc') {
      const doc = documents.find((value) => value.id === ref.id);
      if (!doc) {
        return <p className="tian-idle">附件已不存在。</p>;
      }
      return (
        <div className={`tian-slot${focused ? ' is-focus' : ''}`}>
          <button
            type="button"
            className="tian-slot-select"
            aria-pressed={focused}
            onClick={() => {
              setFocusSlot(slotId);
              setDraftReason(reasons[`doc:${doc.id}`] ?? '');
              setSavedNotice('');
            }}
          >
            <span>{title}</span>
            <em>
              {attachmentLabel(doc)} · {bytes(doc.byteSize)}
            </em>
          </button>
          <div className="tian-stage">
            <DocPreview doc={doc} />
          </div>
          {focused && verdictPanel({ good: '相符', bad: '需補件' })}
        </div>
      );
    }

    const evalItem = orderedEvals.find((value) => value.id === ref.id);
    if (!evalItem) {
      return <p className="tian-idle">勾稽項目已不存在。</p>;
    }
    const similar = isSimilarity(evalItem);
    const codes = similar ? matchedCaseCodes(evalItem) : [];
    return (
      <div className={`tian-slot${focused ? ' is-focus' : ''}`}>
        <button
          type="button"
          className="tian-slot-select"
          aria-pressed={focused}
          onClick={() => {
            setFocusSlot(slotId);
            setDraftReason(reasons[`eval:${evalItem.id}`] ?? '');
            setSavedNotice('');
          }}
        >
          <span>{title}</span>
          <em>
            {ruleLabel(evalItem.ruleCode)} · {outcomeLabel(evalItem.outcome)}
          </em>
        </button>
        {similar ? (
          <div className="tian-stage tian-stage-note">
            {codes.length > 0 ? (
              <div>
                <p>指紋相同案件：</p>
                <ul>
                  {codes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ul>
                <p className="tian-muted">
                  他案的附件影像無法在此載入，右上帶出的是本案的對應附件；要改看其他附件，請從下方附件區選取。
                </p>
              </div>
            ) : (
              <p>{evalItem.explanation || '有重複訊號，但步驟文字裡沒有案號。'}</p>
            )}
          </div>
        ) : (
          <div className="tian-basic-body">
            <p>{evalItem.explanation || '（無說明）'}</p>
            {evalItem.steps.length > 0 && (
              <dl className="tian-fields">
                {evalItem.steps.map((step) => (
                  <div key={`${evalItem.id}-${step.label}`}>
                    <dt>{step.label}</dt>
                    <dd>{step.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
        {focused && verdictPanel({ good: '無疑慮', bad: '需補件' })}
      </div>
    );
  };

  const topLeft = renderSlot('a');
  const topRight = renderSlot('b');

  return (
    <div className="tian-screen" role="dialog" aria-modal="true" aria-label={`田字格核對 ${item.caseCode}`}>
      <header className="tian-topbar">
        <div className="tian-topbar-main">
          <button type="button" className="tian-back" onClick={close}>
            ← 返回案件總覽
          </button>
          <span className="tian-topbar-code">{item.caseCode}</span>
        </div>
        <ReviewActions
          item={item}
          busy={busy || supplementBusy}
          error={panelError}
          clearError={clearError}
          update={update}
          toolbar
          savedDocumentIssues={canRequestDocuments ? savedIssues : []}
          onUseSavedDocumentIssues={() => setCompleteOpen(true)}
        />
      </header>
      {error && (
        <p className="error tian-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className="tian-loading" role="status">
          載入核對資料…
        </div>
      ) : (
        <div className="tian-shell" style={{ gridTemplateColumns: `${layout.side}px 1fr` }}>
          <aside className="tian-side">
            <div className="tian-side-head">
              <h2>勾稽結果</h2>
              {flaggedCount > 0 && <span className="tian-side-count">{flaggedCount} 待確認</span>}
            </div>
            <div className="tian-side-list">
              {orderedEvals.length === 0 ? (
                <p className="tian-muted tian-side-empty">尚無勾稽結果。</p>
              ) : (
                evalGroups.map((group) => (
                  <div key={group.title} className="tian-side-group">
                    <p className="tian-side-group-title">
                      {group.title} <b>{group.items.length}</b>
                    </p>
                    {group.items.map((evalItem) => {
                      const active = isInLeft(slots, { kind: 'eval', id: evalItem.id });
                      const related = relatedDocumentForRule(evalItem.ruleCode, currentDocuments);
                      return (
                        <button
                          key={evalItem.id}
                          type="button"
                          className={`tian-side-row is-${evalItem.outcome}${active ? ' is-current' : ''}`}
                          aria-current={active}
                          onClick={() => pickInto('a', { kind: 'eval', id: evalItem.id })}
                        >
                          <i aria-hidden="true" />
                          <span>
                            <b>{ruleLabel(evalItem.ruleCode)}</b>
                            {evalItem.outcome !== 'pass' && evalItem.explanation && (
                              <small>{evalItem.explanation}</small>
                            )}
                            {evalItem.outcome !== 'pass' && (
                              <em>
                                {outcomeLabel(evalItem.outcome)}
                                {related ? '・自動對照' : isSimilarity(evalItem) ? '・點擊比對' : '・自行選附件'}
                              </em>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
            <p className="tian-side-foot">點選 → 左上。未自動對照者，從附件區自行放入右上。</p>
          </aside>
          <button
            type="button"
            className="tian-splitter tian-splitter-side"
            style={{ left: `${layout.side}px` }}
            aria-label="調整側欄寬度"
            onPointerDown={(event) => beginResize('side', event)}
          />
          <div
            ref={gridRef}
            className="tian"
            style={{
              gridTemplateColumns: `${layout.col}% ${100 - layout.col}%`,
              gridTemplateRows: `${layout.row}% ${100 - layout.row}%`,
            }}
          >
            <div className="tian-cell tian-tl tian-cell-top">{topLeft}</div>
            <div className="tian-cell tian-tr tian-cell-top">{topRight}</div>
            <div className="tian-cell tian-tray">
              <div className="tian-cell-head">
                <h2>附件</h2>
                <span>點選 → 右上</span>
              </div>
              <div className="tian-tray-row">
                {currentDocuments.length === 0 ? (
                  <p className="tian-muted">尚無附件。</p>
                ) : (
                  currentDocuments.map((doc) => {
                    const active = isInRight(slots, { kind: 'doc', id: doc.id });
                    const verdictMark = verdicts[`doc:${doc.id}`];
                    const saved = Boolean(reasons[`doc:${doc.id}`]);
                    return (
                      <button
                        key={doc.id}
                        type="button"
                        className={`tian-doc${active ? ' is-slot-b' : ''}`}
                        onClick={() => pickInto('b', { kind: 'doc', id: doc.id })}
                      >
                        <span>
                          <strong>{attachmentLabel(doc)}</strong>
                          <small>{bytes(doc.byteSize)}</small>
                        </span>
                        <em>
                          {active
                            ? '右上'
                            : verdictMark === 'good'
                              ? '相符'
                              : verdictMark === 'bad' || saved
                                ? '已儲存'
                                : '點擊放入'}
                        </em>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            <button
              type="button"
              className="tian-splitter tian-splitter-col"
              style={{ left: `${layout.col}%`, height: `${layout.row}%` }}
              aria-label="調整左右寬度"
              onPointerDown={(event) => beginResize('col', event)}
            />
            <button
              type="button"
              className="tian-splitter tian-splitter-row"
              style={{ top: `${layout.row}%` }}
              aria-label="調整上下高度"
              onPointerDown={(event) => beginResize('row', event)}
            />
          </div>
        </div>
      )}
      {completeOpen && (
        <dialog
          ref={completeDialog}
          className="review-confirm-dialog tian-complete-dialog"
          aria-modal="true"
          aria-labelledby="tian-complete-title"
          onCancel={(event) => {
            event.preventDefault();
            closeComplete();
          }}
        >
          <p className="eyebrow">要求補件</p>
          <h4 id="tian-complete-title">確認要求補件</h4>
          <p>以下是本次核對已儲存的補件原因，確認後會通知申請人補件。</p>
          <ul className="tian-issue-list">
            {savedIssues.map((issue) => (
              <li key={issue.key}>
                <strong>{issue.label}</strong>
                <span>{issue.reason}</span>
              </li>
            ))}
          </ul>
          <div className="review-confirm-actions">
            <button type="button" className="secondary" data-initial-focus onClick={closeComplete}>
              返回修改
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || supplementBusy}
              aria-busy={busy || supplementBusy}
              onClick={() => void confirmSupplement()}
            >
              {busy || supplementBusy ? '處理中…' : '確認要求補件'}
            </button>
          </div>
        </dialog>
      )}
    </div>
  );
}
