// HelloAsso is used for MEMBERSHIP payments only (books and drop-in seats are
// reserved online and paid in the shop). The membership form is an iframe the
// visitor loads by pressing a button (frame-src in lib/marketingCsp.js) plus a
// plain link: no form of ours posts to HelloAsso and no redirect to it follows a
// form POST, so form-action lists no HelloAsso host.
//
// usesSandbox() tells whether HELLOASSO_API_BASE points at the HelloAsso sandbox
// (payments are not real): used by the launch guards and the admin banner.

function usesSandbox(apiBase) {
  if (!apiBase) return false;
  try {
    const host = new URL(apiBase).hostname.toLowerCase();
    return host === "helloasso-sandbox.com" || host.endsWith(".helloasso-sandbox.com");
  } catch {
    return false;
  }
}

module.exports = { usesSandbox };
