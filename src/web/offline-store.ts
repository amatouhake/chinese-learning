import type {
  AttemptInput,
  IngestResult,
  MaterializedCardState,
  PronunciationCard,
  PronunciationSessionView,
  StudyCard,
  StudySessionView,
  SyncPullResponse,
} from "../domain/types";
import type { PronunciationFocus } from "../domain/pronunciation";
import { parseAttemptInput } from "../domain/validation";
import {
  STUDY_STORAGE_LOCK,
  STUDY_STORAGE_KEY,
  parseBrowserStudyState,
  type BrowserStudyState,
  type StorageLike,
  type StudyAttemptDraft,
} from "./study-storage";

export const OFFLINE_DB_NAME = "chinese-learning.offline.v1";
// The IndexedDB store deliberately shares the legacy writer lock. An older tab
// can therefore finish one localStorage write while this release is rolling
// out, but it cannot race a sequence reservation or reconciliation.
export const OFFLINE_DB_LOCK = STUDY_STORAGE_LOCK;
export const OFFLINE_SYNC_LOCK = `${OFFLINE_DB_NAME}.sync`;
export const STUDY_IDENTITY_MIRROR_KEY = "chinese-learning.study-browser.idb-mirror.v1";

const DATABASE_VERSION = 1;
const META_STORE = "meta";
const OUTBOX_STORE = "outbox";
const STUDY_CARD_STORE = "studyCards";
const PRONUNCIATION_CARD_STORE = "pronunciationCards";
const SESSION_STORE = "sessions";
const CARD_STATE_STORE = "cardStates";
const STATE_KEY = "state";

interface PersistedMeta {
  key: typeof STATE_KEY;
  version: 1;
  revision: number;
  deviceId: string;
  nextDeviceSeq: number;
  activeSessionId: string | null;
  activePronunciationSessionId: string | null;
  activePronunciationFocus: PronunciationFocus | null;
  learnerCursor: number;
  contentRevision: number | null;
}

export interface BrowserOfflineState extends Omit<PersistedMeta, "key" | "version"> {
  pendingCount: number;
}

interface CachedStudyCard {
  key: string;
  sessionId: string;
  position: number;
  card: StudyCard;
}

interface CachedPronunciationCard {
  key: string;
  sessionId: string;
  position: number;
  card: PronunciationCard;
}

interface CachedStudySession {
  key: string;
  mode: "study";
  session: StudySessionView;
}

interface CachedPronunciationSession {
  key: string;
  mode: "pronunciation";
  session: PronunciationSessionView;
}

type CachedSession = CachedStudySession | CachedPronunciationSession;

export interface StagedOfflineAttempt {
  state: BrowserOfflineState;
  attempt: AttemptInput;
}

interface IdentityMirror {
  version: 1;
  deviceId: string;
  nextDeviceSeq: number;
}

export interface BrowserLockManager {
  request<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
}

export class OfflineLearningStore {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly storage: StorageLike,
    private readonly locks: BrowserLockManager,
  ) {}

  static async open(
    storage: StorageLike = localStorage,
    createId: () => string = () => crypto.randomUUID(),
    factory: IDBFactory = indexedDB,
    locks: BrowserLockManager = browserLockManager(),
  ): Promise<OfflineLearningStore> {
    const db = await openDatabase(factory);
    const store = new OfflineLearningStore(db, storage, locks);
    await locks.request(OFFLINE_DB_LOCK, () => store.ensureState(createId));
    return store;
  }

  close(): void {
    this.db.close();
  }

  runSyncExclusive<T>(callback: () => Promise<T>): Promise<T> {
    return this.locks.request(OFFLINE_SYNC_LOCK, callback);
  }

  reconcileLegacyState(): Promise<BrowserOfflineState> {
    return this.locks.request(OFFLINE_DB_LOCK, async () => {
      await this.reconcileLegacyStateUnderLock();
      return this.snapshot();
    });
  }

  async snapshot(): Promise<BrowserOfflineState> {
    const transaction = this.db.transaction([META_STORE, OUTBOX_STORE], "readonly");
    const meta = await requiredMeta(transaction.objectStore(META_STORE));
    const pendingCount = await request(transaction.objectStore(OUTBOX_STORE).count());
    await transactionDone(transaction);
    return mapState(meta, pendingCount);
  }

  setActiveStudySession(sessionId: string): Promise<BrowserOfflineState> {
    return this.updateActiveSession("study", sessionId, null);
  }

  setActivePronunciationSession(
    sessionId: string,
    focus: PronunciationFocus,
  ): Promise<BrowserOfflineState> {
    return this.updateActiveSession("pronunciation", sessionId, focus);
  }

  clearActiveStudySession(sessionId: string): Promise<BrowserOfflineState> {
    return this.clearActiveSession("study", sessionId);
  }

  clearActivePronunciationSession(sessionId: string): Promise<BrowserOfflineState> {
    return this.clearActiveSession("pronunciation", sessionId);
  }

  rememberStudySession(session: StudySessionView): Promise<void> {
    return this.rememberSession({
      key: sessionKey("study", session.id),
      mode: "study",
      session,
    });
  }

  rememberPronunciationSession(session: PronunciationSessionView): Promise<void> {
    return this.rememberSession({
      key: sessionKey("pronunciation", session.id),
      mode: "pronunciation",
      session,
    });
  }

  async stageAttempt(
    state: BrowserOfflineState,
    draft: StudyAttemptDraft,
    createId: () => string = () => crypto.randomUUID(),
    now: () => number = () => Date.now(),
  ): Promise<StagedOfflineAttempt> {
    return this.locks.request(OFFLINE_DB_LOCK, async () => {
      await this.reconcileLegacyStateUnderLock();
      const transaction = this.db.transaction(
        [META_STORE, OUTBOX_STORE, STUDY_CARD_STORE, PRONUNCIATION_CARD_STORE],
        "readwrite",
      );
      const metaStore = transaction.objectStore(META_STORE);
      const latest = await requiredMeta(metaStore);
      requireCurrentState(state, latest);
      const sessionId =
        draft.mode === "study"
          ? latest.activeSessionId
          : draft.mode === "pronunciation"
            ? latest.activePronunciationSessionId
            : null;
      if (!sessionId || draft.studySessionId !== sessionId) {
        transaction.abort();
        throw new Error("a learning attempt must belong to its active cached session");
      }
      if (latest.nextDeviceSeq >= Number.MAX_SAFE_INTEGER) {
        transaction.abort();
        throw new Error("browser device sequence is exhausted");
      }
      const occurredAt = now();
      if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) {
        transaction.abort();
        throw new Error("learning attempt time must be a non-negative integer");
      }

      const cardStoreName = draft.mode === "study" ? STUDY_CARD_STORE : PRONUNCIATION_CARD_STORE;
      const cardStore = transaction.objectStore(cardStoreName);
      const cached = await request(cardStore.get(cardKey(sessionId, draft.cardId)));
      if (cached === undefined) {
        transaction.abort();
        throw new Error("cached card changed in another tab; reload before answering");
      }

      const attempt: AttemptInput = {
        ...draft,
        eventId: `study-event:${createId()}`,
        deviceId: latest.deviceId,
        deviceSeq: latest.nextDeviceSeq,
        occurredAt: new Date(occurredAt).toISOString(),
      };
      transaction.objectStore(OUTBOX_STORE).add(attempt);
      cardStore.delete(cardKey(sessionId, draft.cardId));
      const next: PersistedMeta = {
        ...latest,
        revision: latest.revision + 1,
        nextDeviceSeq: latest.nextDeviceSeq + 1,
      };
      metaStore.put(next);
      persistLegacyBridgeBeforeCommit(this.storage, next, transaction);
      await transactionDone(transaction);
      persistIdentityMirror(this.storage, next);
      return { state: await this.snapshot(), attempt };
    });
  }

  async listPendingAttempts(): Promise<AttemptInput[]> {
    const transaction = this.db.transaction(OUTBOX_STORE, "readonly");
    const attempts = (await request(
      transaction.objectStore(OUTBOX_STORE).getAll(),
    )) as AttemptInput[];
    await transactionDone(transaction);
    return attempts.sort((left, right) => left.deviceSeq - right.deviceSeq);
  }

  async countPendingAttempts(sessionId: string): Promise<number> {
    return (await this.listPendingAttempts()).filter(
      (attempt) => attempt.studySessionId === sessionId,
    ).length;
  }

  acknowledgeAttempt(eventId: string, result: IngestResult): Promise<void> {
    return this.locks.request(OFFLINE_DB_LOCK, async () => {
      await this.reconcileLegacyStateUnderLock();
      if (result.eventId !== eventId) {
        throw new Error("attempt acknowledgement does not match the queued event");
      }
      const transaction = this.db.transaction([OUTBOX_STORE, CARD_STATE_STORE], "readwrite");
      transaction.objectStore(OUTBOX_STORE).delete(eventId);
      if (result.cardState) transaction.objectStore(CARD_STATE_STORE).put(result.cardState);
      await transactionDone(transaction);
    });
  }

  async applyPull(response: SyncPullResponse): Promise<BrowserOfflineState> {
    return this.locks.request(OFFLINE_DB_LOCK, async () => {
      await this.reconcileLegacyStateUnderLock();
      const transaction = this.db.transaction(
        [
          META_STORE,
          OUTBOX_STORE,
          STUDY_CARD_STORE,
          PRONUNCIATION_CARD_STORE,
          SESSION_STORE,
          CARD_STATE_STORE,
        ],
        "readwrite",
      );
      const metaStore = transaction.objectStore(META_STORE);
      const latest = await requiredMeta(metaStore);
      const pendingAttempts = (await request(
        transaction.objectStore(OUTBOX_STORE).getAll(),
      )) as AttemptInput[];
      if (response.nextCursor < latest.learnerCursor) {
        transaction.abort();
        throw new Error("sync pull cursor moved backward");
      }
      for (const change of response.learnerChanges) {
        if (change.entityType === "card_state") {
          transaction.objectStore(CARD_STATE_STORE).put(change.cardState);
        }
      }
      if (response.studyPack) {
        const pendingCardIds = new Set(
          pendingAttempts
            .filter((attempt) => attempt.studySessionId === response.studyPack?.session.id)
            .map((attempt) => attempt.cardId),
        );
        await replaceStudyPack(
          transaction,
          response.studyPack.session,
          response.studyPack.cards.filter((card) => !pendingCardIds.has(card.cardId)),
        );
      }
      if (response.pronunciationPack) {
        const pendingCardIds = new Set(
          pendingAttempts
            .filter((attempt) => attempt.studySessionId === response.pronunciationPack?.session.id)
            .map((attempt) => attempt.cardId),
        );
        await replacePronunciationPack(
          transaction,
          response.pronunciationPack.session,
          response.pronunciationPack.cards.filter((card) => !pendingCardIds.has(card.cardId)),
        );
      }
      const next: PersistedMeta = {
        ...latest,
        revision: latest.revision + 1,
        learnerCursor: response.nextCursor,
        contentRevision: response.currentContentRevision,
      };
      metaStore.put(next);
      persistLegacyBridgeBeforeCommit(this.storage, next, transaction);
      await transactionDone(transaction);
      persistIdentityMirror(this.storage, next);
      return this.snapshot();
    });
  }

  async getCachedStudyCard(sessionId: string): Promise<StudyCard | null> {
    const cards = await this.getSessionCards<CachedStudyCard>(STUDY_CARD_STORE, sessionId);
    return cards.sort((left, right) => left.position - right.position)[0]?.card ?? null;
  }

  async getCachedPronunciationCard(sessionId: string): Promise<PronunciationCard | null> {
    const cards = await this.getSessionCards<CachedPronunciationCard>(
      PRONUNCIATION_CARD_STORE,
      sessionId,
    );
    return cards.sort((left, right) => left.position - right.position)[0]?.card ?? null;
  }

  discardCachedPronunciationCard(sessionId: string, cardId: string): Promise<BrowserOfflineState> {
    return this.locks.request(OFFLINE_DB_LOCK, async () => {
      await this.reconcileLegacyStateUnderLock();
      const transaction = this.db.transaction([META_STORE, PRONUNCIATION_CARD_STORE], "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const latest = await requiredMeta(metaStore);
      transaction.objectStore(PRONUNCIATION_CARD_STORE).delete(cardKey(sessionId, cardId));
      metaStore.put({ ...latest, revision: latest.revision + 1 } satisfies PersistedMeta);
      await transactionDone(transaction);
      return this.snapshot();
    });
  }

  getStudySession(sessionId: string): Promise<StudySessionView | null> {
    return this.getCachedSession<CachedStudySession>("study", sessionId).then(
      (value) => value?.session ?? null,
    );
  }

  getPronunciationSession(sessionId: string): Promise<PronunciationSessionView | null> {
    return this.getCachedSession<CachedPronunciationSession>("pronunciation", sessionId).then(
      (value) => value?.session ?? null,
    );
  }

  async getCardState(cardId: string): Promise<MaterializedCardState | null> {
    const transaction = this.db.transaction(CARD_STATE_STORE, "readonly");
    const state = (await request(transaction.objectStore(CARD_STATE_STORE).get(cardId))) as
      MaterializedCardState | undefined;
    await transactionDone(transaction);
    return state ?? null;
  }

  private async ensureState(createId: () => string): Promise<void> {
    const existing = await this.readMeta();
    if (existing) {
      await this.reconcileLegacyStateUnderLock();
      return;
    }
    const migrated = migrateMeta(this.storage, createId);
    const transaction = this.db.transaction([META_STORE, OUTBOX_STORE], "readwrite");
    const metaStore = transaction.objectStore(META_STORE);
    if ((await request(metaStore.get(STATE_KEY))) !== undefined) {
      transaction.abort();
      return;
    }
    metaStore.add(migrated.meta);
    if (migrated.pendingAttempt) {
      transaction.objectStore(OUTBOX_STORE).add(migrated.pendingAttempt);
    }
    persistLegacyBridgeBeforeCommit(
      this.storage,
      migrated.meta,
      transaction,
      migrated.pendingAttempt,
    );
    await transactionDone(transaction);
    persistLegacyBridge(this.storage, migrated.meta);
    persistIdentityMirror(this.storage, migrated.meta);
  }

  private async readMeta(): Promise<PersistedMeta | null> {
    const transaction = this.db.transaction(META_STORE, "readonly");
    const value = (await request(transaction.objectStore(META_STORE).get(STATE_KEY))) as
      PersistedMeta | undefined;
    await transactionDone(transaction);
    return value ?? null;
  }

  private rememberSession(session: CachedSession): Promise<void> {
    return this.locks.request(OFFLINE_DB_LOCK, async () => {
      await this.reconcileLegacyStateUnderLock();
      const transaction = this.db.transaction(SESSION_STORE, "readwrite");
      transaction.objectStore(SESSION_STORE).put(session);
      await transactionDone(transaction);
    });
  }

  private async reconcileLegacyStateUnderLock(): Promise<void> {
    const legacyJson = this.storage.getItem(STUDY_STORAGE_KEY);
    const legacy = legacyJson === null ? null : parseBrowserStudyState(legacyJson);
    const transaction = this.db.transaction(
      [META_STORE, OUTBOX_STORE, STUDY_CARD_STORE, PRONUNCIATION_CARD_STORE],
      "readwrite",
    );
    const metaStore = transaction.objectStore(META_STORE);
    const latest = await requiredMeta(metaStore);

    if (legacy && legacy.deviceId !== latest.deviceId) {
      transaction.abort();
      throw new Error("stored browser identities disagree; refusing to choose a replacement");
    }

    const pending = legacy?.pendingAttempt ?? null;
    let imported = false;
    if (pending) {
      const outbox = transaction.objectStore(OUTBOX_STORE);
      const [matchingEvent, matchingSequence] = await Promise.all([
        request(outbox.get(pending.eventId)) as Promise<AttemptInput | undefined>,
        request(outbox.index("deviceSeq").get(pending.deviceSeq)) as Promise<
          AttemptInput | undefined
        >,
      ]);
      if (matchingEvent && !sameAttempt(matchingEvent, pending)) {
        transaction.abort();
        throw new Error("legacy pending event payload conflicts with the IndexedDB outbox");
      }
      if (matchingSequence && matchingSequence.eventId !== pending.eventId) {
        transaction.abort();
        throw new Error("legacy pending event reuses an IndexedDB device sequence");
      }
      if (!matchingEvent) {
        outbox.add(pending);
        const cardStore = transaction.objectStore(
          pending.mode === "study" ? STUDY_CARD_STORE : PRONUNCIATION_CARD_STORE,
        );
        cardStore.delete(cardKey(pending.studySessionId ?? "", pending.cardId));
        imported = true;
      }
    }

    const nextDeviceSeq = Math.max(
      latest.nextDeviceSeq,
      legacy?.nextDeviceSeq ?? 1,
      pending ? pending.deviceSeq + 1 : 1,
    );
    const changed = imported || nextDeviceSeq !== latest.nextDeviceSeq;
    const next: PersistedMeta = changed
      ? {
          ...latest,
          revision: latest.revision + 1,
          nextDeviceSeq,
        }
      : latest;
    if (changed) metaStore.put(next);

    // Keep the immutable legacy fact recoverable until its IndexedDB transaction
    // commits. A second reconciliation treats that retained copy idempotently.
    persistLegacyBridgeBeforeCommit(this.storage, next, transaction, pending, legacy);
    await transactionDone(transaction);
    persistLegacyBridge(this.storage, next);
    persistIdentityMirror(this.storage, next);
  }

  private updateActiveSession(
    mode: "study" | "pronunciation",
    sessionId: string,
    focus: PronunciationFocus | null,
  ): Promise<BrowserOfflineState> {
    if (sessionId.trim().length === 0) throw new Error("session ID must be non-empty");
    return this.locks.request(OFFLINE_DB_LOCK, async () => {
      await this.reconcileLegacyStateUnderLock();
      const transaction = this.db.transaction(META_STORE, "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const latest = await requiredMeta(metaStore);
      const current =
        mode === "study" ? latest.activeSessionId : latest.activePronunciationSessionId;
      if (current !== null && current !== sessionId) {
        await transactionDone(transaction);
        return this.snapshot();
      }
      const next: PersistedMeta = {
        ...latest,
        revision: latest.revision + 1,
        activeSessionId: mode === "study" ? sessionId : latest.activeSessionId,
        activePronunciationSessionId:
          mode === "pronunciation" ? sessionId : latest.activePronunciationSessionId,
        activePronunciationFocus:
          mode === "pronunciation" ? focus : latest.activePronunciationFocus,
      };
      metaStore.put(next);
      persistLegacyBridgeBeforeCommit(this.storage, next, transaction);
      await transactionDone(transaction);
      persistIdentityMirror(this.storage, next);
      return this.snapshot();
    });
  }

  private clearActiveSession(
    mode: "study" | "pronunciation",
    sessionId: string,
  ): Promise<BrowserOfflineState> {
    return this.locks.request(OFFLINE_DB_LOCK, async () => {
      await this.reconcileLegacyStateUnderLock();
      const transaction = this.db.transaction(META_STORE, "readwrite");
      const metaStore = transaction.objectStore(META_STORE);
      const latest = await requiredMeta(metaStore);
      const current =
        mode === "study" ? latest.activeSessionId : latest.activePronunciationSessionId;
      if (current !== sessionId) {
        await transactionDone(transaction);
        return this.snapshot();
      }
      const next: PersistedMeta = {
        ...latest,
        revision: latest.revision + 1,
        activeSessionId: mode === "study" ? null : latest.activeSessionId,
        activePronunciationSessionId:
          mode === "pronunciation" ? null : latest.activePronunciationSessionId,
        activePronunciationFocus: mode === "pronunciation" ? null : latest.activePronunciationFocus,
      };
      metaStore.put(next);
      persistLegacyBridgeBeforeCommit(this.storage, next, transaction);
      await transactionDone(transaction);
      persistIdentityMirror(this.storage, next);
      return this.snapshot();
    });
  }

  private async getSessionCards<T>(storeName: string, sessionId: string): Promise<T[]> {
    const transaction = this.db.transaction(storeName, "readonly");
    const values = (await request(
      transaction.objectStore(storeName).index("sessionId").getAll(sessionId),
    )) as T[];
    await transactionDone(transaction);
    return values;
  }

  private async getCachedSession<T extends CachedSession>(
    mode: T["mode"],
    sessionId: string,
  ): Promise<T | null> {
    const transaction = this.db.transaction(SESSION_STORE, "readonly");
    const value = (await request(
      transaction.objectStore(SESSION_STORE).get(sessionKey(mode, sessionId)),
    )) as T | undefined;
    await transactionDone(transaction);
    return value ?? null;
  }
}

async function replaceStudyPack(
  transaction: IDBTransaction,
  session: StudySessionView,
  cards: StudyCard[],
): Promise<void> {
  const store = transaction.objectStore(STUDY_CARD_STORE);
  await deleteSessionCards(store, session.id);
  cards.forEach((card, position) => {
    store.put({ key: cardKey(session.id, card.cardId), sessionId: session.id, position, card });
  });
  transaction.objectStore(SESSION_STORE).put({
    key: sessionKey("study", session.id),
    mode: "study",
    session,
  } satisfies CachedStudySession);
}

async function replacePronunciationPack(
  transaction: IDBTransaction,
  session: PronunciationSessionView,
  cards: PronunciationCard[],
): Promise<void> {
  const store = transaction.objectStore(PRONUNCIATION_CARD_STORE);
  await deleteSessionCards(store, session.id);
  cards.forEach((card, position) => {
    store.put({ key: cardKey(session.id, card.cardId), sessionId: session.id, position, card });
  });
  transaction.objectStore(SESSION_STORE).put({
    key: sessionKey("pronunciation", session.id),
    mode: "pronunciation",
    session,
  } satisfies CachedPronunciationSession);
}

function deleteSessionCards(store: IDBObjectStore, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cursorRequest = store.index("sessionId").openKeyCursor(IDBKeyRange.only(sessionId));
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("card cursor failed"));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) {
        resolve();
        return;
      }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  });
}

function migrateMeta(
  storage: StorageLike,
  createId: () => string,
): { meta: PersistedMeta; pendingAttempt: AttemptInput | null } {
  const mirror = parseIdentityMirror(storage.getItem(STUDY_IDENTITY_MIRROR_KEY));
  const legacyJson = storage.getItem(STUDY_STORAGE_KEY);
  const legacy = legacyJson === null ? null : parseBrowserStudyState(legacyJson);
  const deviceId = mirror?.deviceId ?? legacy?.deviceId ?? `browser:${createId()}`;
  if (legacy && mirror && legacy.deviceId !== mirror.deviceId) {
    throw new Error("stored browser identities disagree; refusing to choose a replacement");
  }
  const nextDeviceSeq = Math.max(
    mirror?.nextDeviceSeq ?? 1,
    legacy?.nextDeviceSeq ?? 1,
    legacy?.pendingAttempt ? legacy.pendingAttempt.deviceSeq + 1 : 1,
  );
  return {
    meta: {
      key: STATE_KEY,
      version: 1,
      revision: 0,
      deviceId,
      nextDeviceSeq,
      activeSessionId: legacy?.activeSessionId ?? null,
      activePronunciationSessionId: legacy?.activePronunciationSessionId ?? null,
      activePronunciationFocus: legacy?.activePronunciationFocus ?? null,
      learnerCursor: 0,
      contentRevision: null,
    },
    pendingAttempt: legacy?.pendingAttempt ?? null,
  };
}

function persistLegacyBridge(
  storage: StorageLike,
  meta: PersistedMeta,
  pendingAttempt: AttemptInput | null = null,
  pendingOwner?: BrowserStudyState | null,
): void {
  storage.setItem(
    STUDY_STORAGE_KEY,
    JSON.stringify({
      version: 3,
      deviceId: meta.deviceId,
      nextDeviceSeq: meta.nextDeviceSeq,
      activeSessionId: pendingOwner ? pendingOwner.activeSessionId : meta.activeSessionId,
      activePronunciationSessionId: pendingOwner
        ? pendingOwner.activePronunciationSessionId
        : meta.activePronunciationSessionId,
      activePronunciationFocus: pendingOwner
        ? pendingOwner.activePronunciationFocus
        : meta.activePronunciationFocus,
      pendingAttempt,
    } satisfies BrowserStudyState),
  );
}

function persistLegacyBridgeBeforeCommit(
  storage: StorageLike,
  meta: PersistedMeta,
  transaction: IDBTransaction,
  pendingAttempt: AttemptInput | null = null,
  pendingOwner?: BrowserStudyState | null,
): void {
  try {
    persistLegacyBridge(storage, meta, pendingAttempt, pendingOwner);
  } catch (error) {
    transaction.abort();
    throw error;
  }
}

function sameAttempt(left: AttemptInput, right: AttemptInput): boolean {
  return stableJson(parseAttemptInput(left)) === stableJson(parseAttemptInput(right));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseIdentityMirror(json: string | null): IdentityMirror | null {
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("stored IndexedDB identity mirror is unreadable");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1 ||
    typeof (value as Record<string, unknown>).deviceId !== "string" ||
    !Number.isSafeInteger((value as Record<string, unknown>).nextDeviceSeq) ||
    ((value as Record<string, unknown>).nextDeviceSeq as number) < 1
  ) {
    throw new Error("stored IndexedDB identity mirror is invalid");
  }
  return value as IdentityMirror;
}

function persistIdentityMirror(storage: StorageLike, meta: PersistedMeta): void {
  try {
    storage.setItem(
      STUDY_IDENTITY_MIRROR_KEY,
      JSON.stringify({
        version: 1,
        deviceId: meta.deviceId,
        nextDeviceSeq: meta.nextDeviceSeq,
      } satisfies IdentityMirror),
    );
  } catch {
    // IndexedDB is canonical. The mirror is only a sequence watermark for
    // recovery if the database is manually removed without clearing localStorage.
  }
}

function requireCurrentState(state: BrowserOfflineState, latest: PersistedMeta): void {
  if (state.deviceId !== latest.deviceId) {
    throw new Error("stored study device identity changed unexpectedly");
  }
  if (state.revision !== latest.revision || state.nextDeviceSeq !== latest.nextDeviceSeq) {
    throw new Error("study state changed in another tab; reload before answering this card");
  }
}

function mapState(meta: PersistedMeta, pendingCount: number): BrowserOfflineState {
  return {
    revision: meta.revision,
    deviceId: meta.deviceId,
    nextDeviceSeq: meta.nextDeviceSeq,
    activeSessionId: meta.activeSessionId,
    activePronunciationSessionId: meta.activePronunciationSessionId,
    activePronunciationFocus: meta.activePronunciationFocus,
    learnerCursor: meta.learnerCursor,
    contentRevision: meta.contentRevision,
    pendingCount,
  };
}

function cardKey(sessionId: string, cardId: string): string {
  return `${sessionId}\u001f${cardId}`;
}

function sessionKey(mode: "study" | "pronunciation", sessionId: string): string {
  return `${mode}\u001f${sessionId}`;
}

function browserLockManager(): BrowserLockManager {
  const locks = globalThis.navigator?.locks;
  if (!locks) throw new Error("This browser cannot safely coordinate learning across tabs.");
  return {
    request<T>(name: string, callback: () => Promise<T> | T): Promise<T> {
      return locks.request(name, callback);
    },
  };
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const openRequest = factory.open(OFFLINE_DB_NAME, DATABASE_VERSION);
    openRequest.onerror = () => reject(openRequest.error ?? new Error("IndexedDB open failed"));
    openRequest.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another tab"));
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result;
      db.createObjectStore(META_STORE, { keyPath: "key" });
      const outbox = db.createObjectStore(OUTBOX_STORE, { keyPath: "eventId" });
      outbox.createIndex("deviceSeq", "deviceSeq", { unique: true });
      const studyCards = db.createObjectStore(STUDY_CARD_STORE, { keyPath: "key" });
      studyCards.createIndex("sessionId", "sessionId");
      const pronunciationCards = db.createObjectStore(PRONUNCIATION_CARD_STORE, {
        keyPath: "key",
      });
      pronunciationCards.createIndex("sessionId", "sessionId");
      db.createObjectStore(SESSION_STORE, { keyPath: "key" });
      db.createObjectStore(CARD_STATE_STORE, { keyPath: "cardId" });
    };
    openRequest.onsuccess = () => resolve(openRequest.result);
  });
}

async function requiredMeta(store: IDBObjectStore): Promise<PersistedMeta> {
  const value = (await request(store.get(STATE_KEY))) as PersistedMeta | undefined;
  if (!value) throw new Error("IndexedDB study identity disappeared; refusing to replace it");
  return value;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}
