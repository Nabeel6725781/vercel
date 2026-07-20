export default function handler(req, res) {
  // Allow only the GitHub Pages origin
  res.setHeader('Access-Control-Allow-Origin', 'https://nabeel6725781.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.status(200).json({ ok: true });
}
