import type { Page } from "@playwright/test";

const DB_NAME = "chinese-learning.offline.v1";

export function seedLegacyCompletedSession(
  page: Page,
  mode: "pronunciation" | "reading" | "grammar",
  session: Record<string, unknown> & { id: string },
): Promise<void> {
  return page.evaluate(
    async ({ dbName, mode, session }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      const transaction = db.transaction(["meta", "sessions"], "readwrite");
      const metaStore = transaction.objectStore("meta");
      const sessions = transaction.objectStore("sessions");
      const meta = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const get = metaStore.get("state");
        get.onerror = () => reject(get.error);
        get.onsuccess = () => resolve(get.result);
      });
      sessions.put({ key: `${mode}\u001f${session.id}`, mode, session });
      metaStore.put({
        ...meta,
        activePronunciationSessionId: null,
        activePronunciationFocus: null,
        activeReadingSessionId: null,
        activeGrammarSessionId: null,
        activeGrammarTopicId: null,
        presentedResult: { mode, sessionId: session.id },
        dismissedResultSessionIds: [],
      });
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    },
    { dbName: DB_NAME, mode, session },
  );
}

export function readOfflineMeta(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async (dbName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const get = db.transaction("meta", "readonly").objectStore("meta").get("state");
      get.onerror = () => reject(get.error);
      get.onsuccess = () => resolve(get.result);
    });
  }, DB_NAME);
}
