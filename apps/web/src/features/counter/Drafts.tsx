/**
 * Draft sales at the counter (data/mutations/drafts.ts): set a sale aside so
 * the next customer can be served, and bring it back when its customer is
 * ready — the truck has arrived, the money has come, the colour is decided.
 *
 * Two sheets, both modal, both with three ways out (close, scrim, Escape):
 *   - SAVE: an optional name, because "the 1,245 one" is not how a cashier
 *     remembers a customer; "Kofi — collecting at 3pm" is.
 *   - DRAFTS: what is waiting, newest first, each with what it comes to, and
 *     the two things to do with it. Deleting asks twice in place — a draft is
 *     somebody's order, and there is no undo once it is gone.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DraftSale } from '../../data/queries/drafts';
import { Money } from '../../money/Money';
import { Icon } from '../../ui/Icon';

/** Focus into a sheet on open, Escape to close, focus back where it came from. */
function useSheet(onClose: () => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus], button')?.focus();
    return () => before?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return ref;
}

function Sheet({
  label,
  title,
  onClose,
  children,
}: {
  readonly label: string;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): ReactNode {
  const ref = useSheet(onClose);
  return (
    <>
      <div className="sheet-scrim" aria-hidden="true" onClick={onClose} />
      <div ref={ref} className="modal-sheet" role="dialog" aria-modal="true" aria-label={label}>
        <span className="sheet-grip" aria-hidden="true" />
        <div className="modal-sheet-head">
          <h2 className="modal-sheet-title">{title}</h2>
          <button type="button" className="sheet-close pressable" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

export function SaveDraftSheet({
  lineCount,
  totalMinor,
  initialLabel,
  onSave,
  onClose,
}: {
  readonly lineCount: number;
  readonly totalMinor: bigint;
  /** A resumed draft keeps the name it was given. */
  readonly initialLabel: string | null;
  readonly onSave: (label: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [label, setLabel] = useState(initialLabel ?? '');
  return (
    <Sheet label="Save as draft" title="Save this sale as a draft" onClose={onClose}>
      <form
        className="modal-sheet-body"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(label);
        }}
      >
        <p className="draft-what">
          <span>{lineCount === 1 ? '1 line' : `${String(lineCount)} lines`}</span>
          <Money amount={totalMinor} className="money draft-what-total" />
        </p>
        <label className="tender-field draft-name">
          <span>Name or note (optional)</span>
          <input
            className="draft-name-input"
            type="text"
            autoComplete="off"
            maxLength={60}
            placeholder="e.g. Kofi — collecting at 3pm"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <p className="tender-hint">
          It stays on this device under Drafts. Serve the next customer, then pick it up again — nothing is charged
          until it is.
        </p>
        <div className="modal-sheet-actions">
          <button type="button" className="secondary-action pressable" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-action pressable">
            <Icon name="draft" size={20} />
            Save draft
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function savedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function DraftsSheet({
  drafts,
  onResume,
  onDelete,
  onClose,
}: {
  readonly drafts: readonly DraftSale[];
  readonly onResume: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <Sheet label="Drafts" title={`Drafts (${String(drafts.length)})`} onClose={onClose}>
      {drafts.length === 0 ? (
        <div className="empty-state">
          <Icon name="draft" size={36} />
          <span className="empty-title">No drafts</span>
          <p className="empty-body">A sale saved as a draft waits here until its customer is ready.</p>
        </div>
      ) : (
        <ul className="draft-list" aria-label="Saved drafts">
          {drafts.map((d) => {
            const name = d.label ?? `Draft from ${savedAt(d.createdAt)}`;
            return (
              <li key={d.id} className="draft-row">
                <div className="draft-row-main">
                  <span className="draft-row-name">{name}</span>
                  <span className="draft-row-meta">
                    {d.lines.length === 1 ? '1 line' : `${String(d.lines.length)} lines`} · saved {savedAt(d.parkedAt)}
                  </span>
                  <span className="draft-row-items">
                    {d.lines
                      .slice(0, 3)
                      .map((l) => l.name)
                      .join(', ')}
                    {d.lines.length > 3 ? ` +${String(d.lines.length - 3)} more` : ''}
                  </span>
                </div>
                <Money amount={d.totalMinor} className="money draft-row-total" />
                <div className="draft-row-actions">
                  {confirming === d.id ? (
                    <>
                      <button type="button" className="secondary-action pressable" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                      <button
                        type="button"
                        className="primary-action danger pressable"
                        aria-label={`Yes, delete ${name}`}
                        onClick={() => {
                          setConfirming(null);
                          onDelete(d.id);
                        }}
                      >
                        Yes, delete
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="draft-delete pressable"
                        aria-label={`Delete ${name}`}
                        onClick={() => setConfirming(d.id)}
                      >
                        <Icon name="trash" size={20} />
                      </button>
                      <button type="button" className="primary-action pressable" onClick={() => onResume(d.id)}>
                        Resume
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
