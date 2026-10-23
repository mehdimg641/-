/**
 * The Instagram page the dashboard shows. Sent with every request (X-Sepand-Account); the server
 * falls back to the first connected page when it is missing or no longer connected.
 */
const KEY = "sepand.account";

export function getActivePage(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setActivePage(accountId: string) {
  try {
    localStorage.setItem(KEY, accountId);
  } catch {
    // Storage blocked: the server keeps showing the first page.
  }
}
