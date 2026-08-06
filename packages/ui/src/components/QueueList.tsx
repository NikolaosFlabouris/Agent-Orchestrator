import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import type { DragEndEvent, PointerSensorOptions } from '@dnd-kit/core';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '../store.js';
import { api } from '../api.js';
import type { TaskResponse } from '../api.js';

/** `PointerSensor` answers to touch as well as mouse and pen, which makes it
 *  unusable as-is next to a `TouchSensor`: a finger fires `pointerdown` AND
 *  `touchstart`, and dnd-kit instantiates a sensor per activator without
 *  deduplicating them. Both would then run — the pointer one starting a
 *  reorder after 5px of movement, i.e. exactly the scroll-stealing behaviour
 *  the touch sensor's press delay exists to prevent, and dispatching a second
 *  drag start when the delay later elapses. Narrowing the activator to
 *  non-touch pointers hands touch to the `TouchSensor` alone and leaves
 *  mouse and pen input on the original code path. */
class NonTouchPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: (event: ReactPointerEvent, options: PointerSensorOptions) =>
        event.nativeEvent.pointerType !== 'touch' &&
        PointerSensor.activators[0].handler(event, options),
    },
  ];
}

export function QueueList({ tasks }: { tasks: TaskResponse[] }) {
  const [items, setItems] = useState(tasks);
  // Two sensors, two very different activation rules. The pointer sensor
  // keeps its 5px distance constraint — with a mouse, a small drag is
  // unambiguous. On touch, "moved 5px" is indistinguishable from the start
  // of a page scroll, so the touch sensor instead requires a 250ms press
  // held within 5px: below that the browser keeps the gesture and the page
  // scrolls normally, and only a deliberate press-and-hold starts a
  // reorder. (The handle is also left without `touch-action: none` for the
  // same reason — the browser must stay free to claim a scroll.)
  const sensors = useSensors(
    useSensor(NonTouchPointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    })
  );

  // Sync local optimistic state with the parent's task list whenever
  // the parent provides a new array. Most server-driven reorders are
  // same-length (just position changes), so the previous
  // `length !== items.length` guard skipped them and the local order
  // diverged from the server's. We resync on any identity change. Done
  // inside useEffect rather than directly during render to keep
  // StrictMode quiet.
  useEffect(() => {
    if (tasks !== items) setItems(tasks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = items.findIndex((t) => t.id === Number(active.id));
    const newIndex = items.findIndex((t) => t.id === Number(over.id));

    if (oldIndex === -1 || newIndex === -1) return;

    const targetPosition = items[newIndex].queue_position ?? newIndex + 1;

    // Reorder locally (optimistic)
    const newItems = [...items];
    const [moved] = newItems.splice(oldIndex, 1);
    newItems.splice(newIndex, 0, moved);
    setItems(newItems);

    // Send reorder to server (swaps positions)
    try {
      await api.patchTask(Number(active.id), {
        action: 'reorder',
        queue_position: targetPosition,
      });
    } catch {
      // Revert on error
      setItems(items);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <div className="space-y-2">
        {items.map((task) => (
          <DraggableQueueItem key={task.id} task={task} />
        ))}
      </div>
    </DndContext>
  );
}

function DraggableQueueItem({ task }: { task: TaskResponse }) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({ id: task.id });

  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: task.id });

  const navigate = useNavigate();
  const forgejoBaseUrl = useStore((s) => s.forgejoBaseUrl);

  const issueHref =
    forgejoBaseUrl && task.repo
      ? `${forgejoBaseUrl}/${task.repo.owner}/${task.repo.name}/issues/${task.issue_id}`
      : null;

  const goToTask = () => navigate(`/tasks/${task.id}`);

  // Combine refs
  const setRef = (node: HTMLDivElement | null) => {
    setDragRef(node);
    setDropRef(node);
  };

  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : undefined;

  return (
    <div
      ref={setRef}
      style={style}
      className={`flex items-center gap-3 bg-gray-900 border rounded p-3 transition-colors ${
        isDragging
          ? 'border-blue-500 opacity-80 z-10'
          : isOver
            ? 'border-blue-700'
            : 'border-gray-800 hover:border-gray-700'
      }`}
    >
      <span
        {...attributes}
        {...listeners}
        role="button"
        aria-label="Drag to reorder queue position"
        /* The glyph's own box is only ~17x24px (line-height 1.5 on 16px
           text) — well under the 44x44px comfortable touch target. Rather
           than pad the span, which would widen the handle column and shift
           every row's content sideways on desktop, an empty
           absolutely-positioned ::after inflates the hit area to ~45x48px
           across the row's own padding. Pointer and touch events landing on
           a pseudo-element are dispatched to its originating element, so
           the drag listeners on this span receive them, and nothing about
           the rendered layout changes at any width. */
        className="relative text-gray-600 select-none cursor-grab active:cursor-grabbing px-1 after:absolute after:-inset-x-3.5 after:-inset-y-3 after:content-['']"
      >
        ::
      </span>
      <div
        role="link"
        tabIndex={0}
        onClick={goToTask}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            goToTask();
          }
        }}
        /* `min-w-0` so the flex child may actually shrink (its default
           `min-width: auto` is what let a long issue title push the position
           metadata off-screen), and the row splits into two stacked lines
           below `sm` — `sm:` reinstates the original single row. */
        className="min-w-0 flex-1 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-0 cursor-pointer"
      >
        <div className="min-w-0 truncate">
          {issueHref ? (
            <a
              href={issueHref}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => e.stopPropagation()}
              className="text-blue-400 font-mono text-sm hover:underline"
            >
              #{task.issue_id}
            </a>
          ) : (
            <span className="text-blue-400 font-mono text-sm">
              #{task.issue_id}
            </span>
          )}{' '}
          <span>{task.issue_title}</span>
          {task.repo && (
            <span className="text-gray-500 text-sm ml-2">
              {task.repo.owner}/{task.repo.name}
            </span>
          )}
        </div>
        <div className="text-sm text-gray-400 flex flex-wrap items-center gap-x-2 gap-y-1 sm:flex-nowrap">
          {task.blocked && (
            <span
              className="px-2 py-0.5 rounded text-xs font-medium bg-amber-900 text-amber-300"
              title={`Waiting on ${(task.blocked_by ?? [])
                .map((n) => `#${n}`)
                .join(', ')}`}
            >
              blocked
            </span>
          )}
          <span>Position {task.queue_position}</span>
        </div>
      </div>
    </div>
  );
}
