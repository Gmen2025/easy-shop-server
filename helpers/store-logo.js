function normalizeStoreLogo(value) {
  if (value === undefined) return undefined;
  const invalid = () => Object.assign(new Error("Logo must be an HTTPS image URL (up to 500 characters), or empty to use store initials."), { status: 400 });
  if (typeof value !== "string") throw invalid();
  const logo = value.trim();
  if (!logo) return "";
  if (logo.length > 500 || /\s/.test(logo)) throw invalid();
  let url;
  try { url = new URL(logo); } catch { throw invalid(); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw invalid();
  return logo;
}

module.exports = { normalizeStoreLogo };
