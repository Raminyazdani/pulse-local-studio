import type { Project } from './types';

export interface SavedProject {
  id: string;
  name: string;
  updated: number;
}

/** A newer project activation must never overtake an older in-flight save. */
export class ProjectSaveQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private write: (id: string, body: string) => Promise<{ id: string; updated: number }>) {}

  save(project: Project): Promise<{ id: string; updated: number }> {
    const body = JSON.stringify(project);
    const id = project.id;
    const result = this.tail.then(() => this.write(id, body));
    // A failed attempt must remain observable to its caller without blocking
    // the next retry or a later project save forever.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
