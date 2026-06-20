import fs from 'node:fs';
import path from 'node:path';
import type { Task, AgentResult } from '@orchestrator/shared';
import { getTasks } from './db.js';
import {
  getContainer,
  inspectContainer,
  stopContainer,
  removeContainer,
} from './docker.js';
import { getOutputDir, getTaskDir } from './workspace.js';
import { DRAIN_TIMEOUT_MINUTES } from './constants.js';
import type { Scheduler } from './scheduler.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Graceful shutdown handler.
 * Pauses scheduler, drains running containers, processes completed results,
 * kills stragglers at deadline.
 */
export async function gracefulShutdown(
  scheduler: Scheduler,
  log: FastifyBaseLogger,
  onCleanExit: () => Promise<void>
): Promise<void> {
  log.info({ event: 'shutdown_start' }, 'Shutdown requested. Draining active tasks...');

  // 1. Stop accepting new work
  scheduler.pause();
  scheduler.stop();

  // 2. Set drain deadline. Capped at DRAIN_TIMEOUT_MINUTES regardless of
  // any individual tool's timeout — see constants.ts. Long-running tasks
  // mid-flight get SIGKILL'd at the deadline; recovery handles them next
  // boot.
  const drainTimeoutMs = DRAIN_TIMEOUT_MINUTES * 60 * 1000;
  const deadline = Date.now() + drainTimeoutMs;

  // 3. Find running tasks
  const running = new Map<number, Task>();
  const activeTasks = [
    ...getTasks({ status: 'preparing' }),
    ...getTasks({ status: 'in-progress' }),
    ...getTasks({ status: 'in-review' }),
  ].filter((t) => t.container_id);

  for (const task of activeTasks) {
    running.set(task.id, task);
  }

  if (running.size === 0) {
    log.info({ event: 'shutdown_no_active' }, 'No active tasks. Shutting down immediately.');
    await onCleanExit();
    return;
  }

  log.info(
    { event: 'shutdown_draining', count: running.size, deadline: new Date(deadline).toISOString() },
    `Waiting for ${running.size} active tasks to complete`
  );

  // 4. Drain loop — wait for containers to finish
  while (Date.now() < deadline && running.size > 0) {
    for (const [taskId, task] of running) {
      if (!task.container_id) {
        running.delete(taskId);
        continue;
      }

      try {
        const container = getContainer(task.container_id);
        const info = await inspectContainer(container);

        if (info.State.Status === 'exited') {
          log.info(
            { event: 'shutdown_task_completed', task_id: taskId },
            'Task completed during drain. Processing results.'
          );

          // Read results and process via scheduler's post-agent flow
          const outputDir = getOutputDir(task);
          const taskDir = getTaskDir(task);
          let result: AgentResult;
          try {
            const raw = fs.readFileSync(
              path.join(outputDir, 'result.json'),
              'utf-8'
            );
            result = JSON.parse(raw);
          } catch {
            result = {
              status: 'failure',
              error_message: 'No result.json produced by agent',
            };
          }

          let role: 'develop' | 'review' = 'develop';
          try {
            const raw = fs.readFileSync(
              path.join(taskDir, 'meta.json'),
              'utf-8'
            );
            const meta = JSON.parse(raw);
            role = meta.role;
          } catch {
            // Default to develop
          }

          // Process results via scheduler
          try {
            await scheduler.processCompletedTask(task, result, role);
          } catch (err) {
            log.error(
              { event: 'shutdown_process_error', task_id: taskId, err },
              'Failed to process completed task during drain'
            );
          }

          try {
            await removeContainer(container);
          } catch { /* best effort */ }

          running.delete(taskId);
        }
      } catch {
        // Container inspect failed — remove from tracking
        running.delete(taskId);
      }
    }

    if (running.size > 0) {
      await sleep(5000);
    }
  }

  // 5. Handle tasks that didn't finish before deadline
  for (const [taskId, task] of running) {
    log.warn(
      { event: 'shutdown_kill_straggler', task_id: taskId },
      'Task did not complete before drain deadline'
    );

    if (task.container_id) {
      try {
        const container = getContainer(task.container_id);
        await stopContainer(container);
        await removeContainer(container);
      } catch {
        // Best effort
      }
    }

    // Leave the DB status as-is — startup recovery will handle it
  }

  // 6. Clean exit
  log.info({ event: 'shutdown_complete' }, 'Shutdown complete');
  await onCleanExit();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
