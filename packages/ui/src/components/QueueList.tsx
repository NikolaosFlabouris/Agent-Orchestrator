import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { useStore } from '../store.js';
import { api } from '../api.js';
import type { TaskResponse } from '../api.js';

export function QueueList({ tasks }: { tasks: TaskResponse[] }) {
  const [items, setItems] = useState(tasks);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
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
        className="text-gray-600 select-none cursor-grab active:cursor-grabbing px-1"
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
        className="flex-1 flex items-center justify-between cursor-pointer"
      >
        <div>
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
        <div className="text-sm text-gray-400">
          Position {task.queue_position}
        </div>
      </div>
    </div>
  );
}
