import type { TicketWithMeta } from '../services/tickets.ts';
import { PriorityPill, StatusPill } from './layout.tsx';

/**
 * The htmx workhorse: one ticket row, rendered as a fragment.
 *
 * Every mutation returns this whole <tr> with hx-swap="outerHTML", so the row
 * is always a complete, self-consistent piece of HTML. No client-side state,
 * no partial-patch bugs.
 */
export function TicketRow({ ticket }: { ticket: TicketWithMeta }) {
  const id = `row-${ticket.id}`;
  const next = ticket.status === 'closed' ? 'open' : 'closed';
  const nextLabel = ticket.status === 'closed' ? '重新打开' : '关闭';

  return (
    <tr id={id}>
      <td>
        <a href={`/tickets/${ticket.id}`}>{ticket.subject}</a>
        {ticket.tags.length > 0 && (
          <div style="margin-top:4px">
            {ticket.tags.map((t) => (
              <span class="tag">{t}</span>
            ))}
          </div>
        )}
      </td>
      <td>
        <StatusPill status={ticket.status} />
      </td>
      <td>
        <PriorityPill priority={ticket.priority} />
      </td>
      <td class="muted">{ticket.assigneeName ?? '—'}</td>
      <td class="muted">{ticket.requesterEmail}</td>
      <td class="muted">{ticket.commentCount}</td>
      <td>
        <div class="row">
          <button
            hx-patch={`/ui/tickets/${ticket.id}/status`}
            hx-vals={JSON.stringify({ status: next })}
            hx-target={`#${id}`}
            hx-swap="outerHTML"
          >
            {nextLabel}
          </button>
          <button
            class="danger"
            hx-delete={`/ui/tickets/${ticket.id}`}
            hx-confirm="确定删除这张工单？此操作不可撤销。"
            hx-target={`#${id}`}
            hx-swap="outerHTML"
          >
            删除
          </button>
        </div>
      </td>
    </tr>
  );
}

/** Returned by delete: an empty body removes the row from the DOM. */
export function EmptyRow() {
  return <tr style="display:none" />;
}
