// What you do in the reader (rate, save, move) is shown at once, kept in this device's storage, and sent
// to the agent as a small file in the OneDrive App Folder (docs/phase-2.md). Offline, it waits and is sent
// when you're back online. "Read" is remembered on this device only.
import { useCallback, useEffect, useState } from "react";
import { ACTIONS_SCHEMA_VERSION, type ActionsFile, type Edition, type ItemCard, type ReaderAction } from "@broadsheet/shared";
import { putJson } from "./data.ts";

const PENDING = "bs-actions-pending"; // not yet uploaded
const SENT = "bs-actions-sent"; // uploaded, maybe not yet in the edition
const READ = "bs-read";
const DEVICE = "bs-device";
/** If the agent hasn't reflected an action after this long, stop showing our own copy of it. */
const SENT_TTL_MS = 45 * 60 * 1000;

const load = <T>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));

function deviceId(): string {
  let id = localStorage.getItem(DEVICE);
  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
    localStorage.setItem(DEVICE, id);
  }
  return id;
}

/** Upload everything waiting. Returns true if nothing is left waiting. */
async function flush(): Promise<boolean> {
  const pending = load<ReaderAction[]>(PENDING, []);
  if (!pending.length) return true;
  const file: ActionsFile = { schemaVersion: ACTIONS_SCHEMA_VERSION, device: deviceId(), createdAt: new Date().toISOString(), actions: pending };
  const name = `ratings/${file.device}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  try {
    await putJson(name, file);
  } catch {
    return false; // offline or signed out: try again later
  }
  // Only remove what was sent (more may have been queued meanwhile).
  const still = load<ReaderAction[]>(PENDING, []).filter((a) => !pending.some((p) => p.at === a.at && p.itemId === a.itemId && p.type === a.type));
  save(PENDING, still);
  save(SENT, [...load<ReaderAction[]>(SENT, []), ...pending]);
  return still.length === 0;
}

/** An action as the screens create it; the time is added when it's queued. */
export type NewAction = ReaderAction extends infer A ? (A extends unknown ? Omit<A, "at"> : never) : never;

export type Overlay = { rating?: -1 | 0 | 1 | null; saved?: boolean; section?: string };

/** Your actions that the edition doesn't show yet, by item. */
function overlayFor(edition: Edition | null): Map<string, Overlay> {
  const items = new Map((edition?.items ?? []).map((i) => [i.id, i]));
  const generated = edition ? new Date(edition.generatedAt).getTime() : 0;
  let sent = load<ReaderAction[]>(SENT, []);
  // Forget sent actions once the edition reflects them, or once they're old.
  sent = sent.filter((a) => {
    const item = items.get(a.itemId);
    if (!item || Date.now() - new Date(a.at).getTime() > SENT_TTL_MS) return false;
    if (new Date(a.at).getTime() > generated) return true;
    if (a.type === "rate") return item.rating !== a.rating;
    if (a.type === "save") return item.saved !== a.saved;
    if (a.type === "move") return item.section !== a.section;
    return false;
  });
  save(SENT, sent);

  const map = new Map<string, Overlay>();
  for (const a of [...sent, ...load<ReaderAction[]>(PENDING, [])].sort((x, y) => x.at.localeCompare(y.at))) {
    const o = map.get(a.itemId) ?? {};
    if (a.type === "rate") o.rating = a.rating;
    if (a.type === "save") o.saved = a.saved;
    if (a.type === "move") o.section = a.section;
    map.set(a.itemId, o);
  }
  return map;
}

export function applyOverlay(item: ItemCard, o: Overlay | undefined): ItemCard {
  if (!o) return item;
  return {
    ...item,
    rating: o.rating !== undefined ? o.rating : item.rating,
    saved: o.saved ?? item.saved,
    section: o.section ?? item.section,
    sectionByYou: o.section ? true : item.sectionByYou,
  };
}

export function useReaderActions(edition: Edition | null) {
  const [version, setVersion] = useState(0);
  const [waiting, setWaiting] = useState(() => load<ReaderAction[]>(PENDING, []).length);
  const bump = () => setVersion((v) => v + 1);

  const send = useCallback(async () => {
    await flush();
    setWaiting(load<ReaderAction[]>(PENDING, []).length);
  }, []);

  useEffect(() => {
    send();
    addEventListener("online", send);
    return () => removeEventListener("online", send);
  }, [send]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const overlay = useCallback(() => overlayFor(edition), [edition, version]);

  const act = useCallback(
    (a: NewAction) => {
      save(PENDING, [...load<ReaderAction[]>(PENDING, []), { ...a, at: new Date().toISOString() } as ReaderAction]);
      bump();
      setWaiting(load<ReaderAction[]>(PENDING, []).length);
      send().then(bump);
    },
    [send],
  );

  const [read, setRead] = useState<Set<string>>(() => new Set(load<string[]>(READ, [])));
  const markRead = useCallback((id: string, isRead = true) => {
    setRead((prev) => {
      const next = new Set(prev);
      if (isRead) next.add(id);
      else next.delete(id);
      // Keep the list from growing forever: only the last 500.
      save(READ, [...next].slice(-500));
      return next;
    });
  }, []);

  return { overlay: overlay(), act, waiting, read, markRead };
}
