/**
 * Per-tab identity, stored in sessionStorage rather than localStorage on
 * purpose: sessionStorage is scoped to a single tab, so opening a second tab
 * produces a second, distinct player. That is what makes local multi-tab
 * playtesting possible without extra browser profiles.
 */
const TAB_ID_KEY = "netsleuth:tabId";
const NAME_KEY = "netsleuth:name";

export function getTabId(): string {
  let id = sessionStorage.getItem(TAB_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(TAB_ID_KEY, id);
  }
  return id;
}

/** Remembered display name, so a refresh does not re-prompt. */
export function getStoredName(): string | null {
  return sessionStorage.getItem(NAME_KEY);
}

export function storeName(name: string): void {
  sessionStorage.setItem(NAME_KEY, name);
}

/**
 * Whether this tab is the one that opened the lobby. Only the creating tab may
 * send intent:"create"; every other tab must send intent:"join" so that a
 * mistyped code fails loudly instead of opening a ghost lobby.
 */
const CREATED_KEY = "netsleuth:created:";

export function markCreated(code: string): void {
  sessionStorage.setItem(CREATED_KEY + code, "1");
}

export function didCreate(code: string): boolean {
  return sessionStorage.getItem(CREATED_KEY + code) === "1";
}
