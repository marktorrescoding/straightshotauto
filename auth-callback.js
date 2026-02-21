(() => {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  const expiresAt = Number(params.get("expires_at"));
  const tokenType = params.get("token_type");
  if (!accessToken || !refreshToken || !Number.isFinite(expiresAt)) return;

  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    token_type: tokenType || "bearer"
  };

  chrome.storage.local.set({ "fbco.auth.session.v1": session }, () => {
    document.body.textContent =
      "Signed in to StraightShotAuto. You can close this tab and return to Facebook Marketplace.";
    setTimeout(() => window.close(), 800);
  });
})();
