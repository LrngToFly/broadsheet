// What you do in the reader (rate, save, move, hide) is shown at once, kept in this device's storage, and sent
// to the agent as a small file in the OneDrive App Folder (docs/phase-2.md). Offline, it waits and is sent
// when you're back online. "Read" is remembered on this device only.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ACTIONS_SCHEMA_VERSION, isItemAction, type ActionsFile, type Edition, type HideReason, type ItemCard, type ReaderAction, type RulesFile } from "@broadsheet/shared";
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
  const still = load<ReaderAction[]>(PENDING, []).filter((a) => !pending.some((p) => p.at === a.at && p.type === a.type));
  save(PENDING, still);
  save(SENT, [...load<ReaderAction[]>(SENT, []), ...pending]);
  return still.length === 0;
}

/** An action as the screens create it; the time is added when it's queued. */
export type NewAction = ReaderAction extends infer A ? (A extends unknown ? Omit<A, "at"> : never) : never;

export type Overlay = { rating?: -1 | 0 | 1 | null; saved?: boolean; section?: string; hidden?: boolean; reason?: HideReason | null; note?: string | null };

/** Rules-page changes that rules.json doesn't show yet. */
export type SettingsOverlay = {
  ownWords?: string;
  /** Approve, dismiss, on, off or delete, by rule id. */
  ops: Map<string, string>;
  /** New wording sent for a rule. */
  edits: Map<string, string>;
  /** Rules you typed, waiting to be drafted. */
  added: { text: string; at: string }[];
};

/** Your actions that the edition doesn't show yet, by item, and the Rules-page ones that rules.json doesn't. */
function overlayFor(edition: Edition | null, rules: RulesFile | null): { items: Map<string, Overlay>; settings: SettingsOverlay } {
  const items = new Map((edition?.items ?? []).map((i) => [i.id, i]));
  const hidden = new Map((edition?.hidden ?? []).map((h) => [h.id, h]));
  const generated = edition ? new Date(edition.generatedAt).getTime() : 0;
  let sent = load<ReaderAction[]>(SENT, []);
  // Forget sent actions once the edition reflects them, or once they're old.
  const rulesAt = rules ? new Date(rules.generatedAt).getTime() : 0;
  sent = sent.filter((a) => {
    if (Date.now() - new Date(a.at).getTime() > SENT_TTL_MS) return false;
    // Rules-page actions: shown until a rules.json made after them arrives.
    if (!isItemAction(a)) return new Date(a.at).getTime() > rulesAt;
    const item = items.get(a.itemId);
    if ((!item && !hidden.has(a.itemId)) || Date.now() - new Date(a.at).getTime() > SENT_TTL_MS) return false;
    if (new Date(a.at).getTime() > generated) return true;
    if (a.type === "hide") {
      const h = hidden.get(a.itemId);
      return !(h?.why.kind === "you" && h.why.reason === a.reason && h.why.note === a.note);
    }
    if (a.type === "unhide") return !item;
    if (!item) return true;
    if (a.type === "rate") return item.rating !== a.rating;
    if (a.type === "save") return item.saved !== a.saved;
    if (a.type === "move") return item.section !== a.section;
    return false;
  });
  save(SENT, sent);

  const map = new Map<string, Overlay>();
  const settings: SettingsOverlay = { ops: new Map(), edits: new Map(), added: [] };
  for (const a of [...sent, ...load<ReaderAction[]>(PENDING, [])].sort((x, y) => x.at.localeCompare(y.at))) {
    if (!isItemAction(a)) {
      if (a.type === "own-words") settings.ownWords = a.text;
      if (a.type === "rule") settings.ops.set(a.ruleId, a.op);
      if (a.type === "rule-edit") settings.edits.set(a.ruleId, a.text);
      if (a.type === "rule-add") settings.added.push({ text: a.text, at: a.at });
      continue;
    }
    const o = map.get(a.itemId) ?? {};
    if (a.type === "rate") o.rating = a.rating;
    if (a.type === "save") o.saved = a.saved;
    if (a.type === "move") o.section = a.section;
    if (a.type === "hide") Object.assign(o, { hidden: true, reason: a.reason, note: a.note });
    if (a.type === "unhide") Object.assign(o, { hidden: false, reason: null, note: null });
    map.set(a.itemId, o);
  }
  return { items: map, settings };
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

export function useReaderActions(edition: Edition | null, rules: RulesFile | null = null) {
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
  const overlay = useCallback(() => overlayFor(edition, rules), [edition, rules, version]);

  const act = useCallback(
    (a: NewAction) => {
      save(PENDING, [...load<ReaderAction[]>(PENDING, []), { ...a, at: new Date().toISOString() } as ReaderAction]);
      bump();
      setWaiting(load<ReaderAction[]>(PENDING, []).length);
      send().then(bump);
    },
    [send],
  );

  // What you've read: on this device straight away, and from your other devices through the agent (the edition's
  // read flags). Opening or marking an article also tells the agent, so your other devices learn it too.
  const [local, setLocal] = useState<Set<string>>(() => new Set(load<string[]>(READ, [])));
  const elsewhere = useMemo(() => new Set((edition?.items ?? []).filter((i) => i.read).map((i) => i.id)), [edition]);
  const [unread, setUnread] = useState<Set<string>>(new Set()); // marked unread here, until the agent catches up
  const read = useMemo(() => new Set([...local, ...[...elsewhere].filter((id) => !unread.has(id))]), [local, elsewhere, unread]);

  // What this session has already told the agent, so reopening an article doesn't send it again.
  const told = useRef(new Map<string, boolean>());
  const markRead = useCallback(
    (id: string, isRead = true) => {
      setLocal((prev) => {
        if (prev.has(id) === isRead) return prev;
        const next = new Set(prev);
        if (isRead) next.add(id);
        else next.delete(id);
        save(READ, [...next].slice(-500)); // keep the list from growing forever
        return next;
      });
      setUnread((prev) => {
        if (prev.has(id) === !isRead) return prev;
        const next = new Set(prev);
        if (isRead) next.delete(id);
        else next.add(id);
        return next;
      });
      // Tell the agent, unless it already knows (the edition says so) or this session already told it.
      if (elsewhere.has(id) !== isRead && told.current.get(id) !== isRead) {
        told.current.set(id, isRead);
        act({ type: "read", itemId: id, read: isRead });
      }
    },
    [elsewhere, act],
  );

  const { items, settings } = overlay();
  return { overlay: items, settings, act, waiting, read, markRead };
}
