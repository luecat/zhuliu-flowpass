import type { Case, Review, ReviewDecision } from './types';
import { TianReview } from './tian-review';

export function Panel({
  item,
  busy,
  error,
  close,
  clearError,
  update,
}: {
  item: Case;
  busy: boolean;
  error: string;
  close: () => void;
  clearError: () => void;
  update: (review: Review, decision: ReviewDecision) => Promise<void>;
}) {
  return (
    <TianReview
      key={`tian-${item.id}`}
      item={item}
      busy={busy}
      error={error}
      clearError={clearError}
      close={close}
      update={update}
    />
  );
}
