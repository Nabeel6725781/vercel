// api/vision-ocr.js
import Busboy from 'busboy';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  // CORS - only allow your GitHub Pages origin
  res.setHeader('Access-Control-Allow-Origin', 'https://nabeel6725781.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  try {
    const apiKey = process.env.OCR_DOCUMENT_READER;
    if (!apiKey) return res.status(500).json({ success: false, error: 'OCR service not configured' });

    // parse multipart form-data with Busboy
    const bb = new Busboy({ headers: req.headers });
    let fileBuffer = null;
    let filename = '';
    let docType = '';

    await new Promise((resolve, reject) => {
      bb.on('file', (fieldname, file, fname /*encoding, mimetype*/) => {
        filename = fname;
        const chunks = [];
        file.on('data', (data) => chunks.push(data));
        file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
      });
      bb.on('field', (name, val) => {
        if (name === 'doc_type') docType = val;
      });
      bb.on('finish', resolve);
      bb.on('error', reject);
      req.pipe(bb);
    });

    if (!fileBuffer) return res.status(400).json({ success: false, error: 'No file uploaded' });

    // Image-only handler (DOCUMENT_TEXT_DETECTION)
    const base64 = fileBuffer.toString('base64');
    const body = {
      requests: [
        {
          image: { content: base64 },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
        },
      ],
    };

    const visionRes = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = await visionRes.json();
    if (!visionRes.ok) {
      console.error('Vision API error', json);
      return res.status(500).json({ success: false, error: 'Vision API error', details: json });
    }

    const fullText = json?.responses?.[0]?.fullTextAnnotation?.text || '';
    const extracted = parseTextToFields(fullText);
    const confidence = estimateConfidence(json);

    return res.json({ success: true, extracted, confidence, errors: [] });
  } catch (err) {
    console.error('OCR handler error', err);
    return res.status(500).json({ success: false, error: String(err) });
  }
}

function estimateConfidence(visionJson) {
  try {
    const page = visionJson?.responses?.[0]?.fullTextAnnotation?.pages?.[0];
    if (!page) return 0.7;
    const confidences = [];
    (page.blocks || []).forEach((b) => {
      (b.paragraphs || []).forEach((p) => {
        (p.words || []).forEach((w) => {
          (w.symbols || []).forEach((s) => { if (s.confidence) confidences.push(s.confidence); });
        });
      });
    });
    if (!confidences.length) return 0.75;
    const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    return Math.max(0.4, Math.min(0.99, avg));
  } catch {
    return 0.75;
  }
}

function parseTextToFields(text) {
  const t = text.replace(/\r/g, '\n').replace(/\t/g, ' ').trim();
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const out = {};
  const nameMatch = text.match(/(?:Student Name|Name|Candidate Name|Applicant[:\s\-]*)[:\s\-]*([A-Za-z ]{3,80})/i)
    || text.match(/([A-Z][a-z]{1,}\s[A-Z][a-z]{1,}(?:\s[A-Z][a-z]{1,})?)/);
  if (nameMatch) out['Student Name'] = (nameMatch[1] || nameMatch[0]).trim();
  const fatherMatch = text.match(/(?:Father(?:'s)? Name|S\/O|S\/ O|Son of)[:\s\-]*([A-Za-z ]{3,80})/i);
  if (fatherMatch) out['Father Name'] = fatherMatch[1].trim();
  const cnicMatch = text.match(/\b\d{5}-\d{7}-\d\b/);
  if (cnicMatch) out['CNIC Number'] = cnicMatch[0];
  const rollMatch = text.match(/Roll(?:\s*No|[:\s\-])*([A-Za-z0-9\-\/]{3,20})/i)
    || text.match(/\b(Roll|Reg|Registration|Seat No|Seat):?\s*([A-Za-z0-9\-\/]{3,20})/i);
  if (rollMatch) out['Roll Number'] = (rollMatch[2] || rollMatch[1] || '').toString().trim();
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) out['Exam Year'] = yearMatch[0];
  const percentMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (percentMatch) out['Percentage'] = percentMatch[1];
  const boardLine = lines.find((l) => /board|university|institute|college/i.test(l) && l.length < 80);
  if (boardLine) out['Board'] = boardLine;
  return out;
}
