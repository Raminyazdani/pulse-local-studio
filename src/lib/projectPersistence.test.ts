import { describe, expect, it } from 'vitest';
import { ProjectSaveQueue } from './projectPersistence';
import type { Project } from './types';

const project = (id: string, name = id): Project => ({ id, name, tracks: [], clips: [], media: [] });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('portable project save ordering', () => {
  it('never activates the next project until an older in-flight save completes', async () => {
    const first = deferred();
    const activated: string[] = [];
    const queue = new ProjectSaveQueue(async id => {
      if (id === 'older') await first.promise;
      activated.push(id);
      return { id, updated: Date.now() };
    });
    const oldSave = queue.save(project('older'));
    const newSave = queue.save(project('newer'));
    await Promise.resolve();
    expect(activated).toEqual([]);
    first.resolve();
    await Promise.all([oldSave, newSave]);
    expect(activated).toEqual(['older', 'newer']);
  });

  it('takes an immutable snapshot before a queued request starts', async () => {
    const first = deferred();
    const bodies: string[] = [];
    const queue = new ProjectSaveQueue(async (id, body) => {
      if (id === 'blocker') await first.promise;
      bodies.push(body);
      return { id, updated: 1 };
    });
    void queue.save(project('blocker'));
    const snapshot = project('edit', 'Original title');
    const saved = queue.save(snapshot);
    snapshot.name = 'Later title';
    first.resolve();
    await saved;
    expect(JSON.parse(bodies[1]).name).toBe('Original title');
  });

  it('lets a failed write be retried without abandoning later saves', async () => {
    let attempt = 0;
    const queue = new ProjectSaveQueue(async id => {
      if (++attempt === 1) throw new Error('Drive disconnected');
      return { id, updated: 2 };
    });
    await expect(queue.save(project('portable'))).rejects.toThrow('Drive disconnected');
    await expect(queue.save(project('portable'))).resolves.toEqual({ id: 'portable', updated: 2 });
    await queue.drain();
  });
});
