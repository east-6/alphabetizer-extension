// Right-click "Alphabetize selection": sorts the selected lines and copies
// the result to the clipboard, using the same automatic language rules as
// the popup (Turkish collation when Turkish-only letters are present).
// Badge feedback: a brief check mark on success, an exclamation mark when
// the page cannot be scripted (chrome:// pages, the Web Store) or the
// clipboard write fails.

const MENU_ID = 'alphabetize-selection';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Alphabetize selection',
      contexts: ['selection']
    });
  });
});

// Runs in the page (in the frame that owns the selection) so it can read
// the real multi-line selection (the contextMenus selectionText API
// collapses newlines) and write the clipboard within the user gesture.
// Returns true when the sorted text reached the clipboard.
async function sortSelectionToClipboard() {
  const sel = window.getSelection().toString();
  if (!sel.trim()) return false;
  const locale = /[ıİğĞ]/.test(sel) ? 'tr' : undefined;
  const collator = new Intl.Collator(locale, { sensitivity: 'variant' });
  const sorted = sel
    .replace(/\r/g, '')
    .split('\n')
    .filter(line => line.trim() !== '')
    .sort(collator.compare)
    .join('\n');
  try {
    await navigator.clipboard.writeText(sorted);
    return true;
  } catch {
    return false;
  }
}

function flashBadge(ok) {
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#1A7F37' : '#CF222E' });
  chrome.action.setBadgeText({ text: ok ? '✓' : '!' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id === undefined) return;
  const target = { tabId: tab.id };
  if (info.frameId !== undefined) target.frameIds = [info.frameId];
  chrome.scripting.executeScript({ target, func: sortSelectionToClipboard })
    .then(results => flashBadge(Boolean(results && results[0] && results[0].result)))
    .catch(() => flashBadge(false));
});
