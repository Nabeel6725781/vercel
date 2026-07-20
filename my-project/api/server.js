// server.js (Node/Express) — images only
// Install: npm i express multer node-fetch
// Deploy on Vercel (api/vision-ocr.js) or Netlify function (adjust exports).
import express from 'express';
import multer from 'multer';
import fetch from 'node-fetch';

const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB limit
const app = express();

app.post('/api/vision-ocr', upload.single('file'), async (req, res) => {
  try {
    const apiKey = process.env.OCR_DOCUMENT_READER;
    if (!apiKey) return res.status(500).json({ success: false, error: 'OCR service not configured' });

    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    // Only images supported here. PDFs require the async batch flow (see below).
    const isImage = file.mimetype.startsWith('image/');
    if (!isImage) {
      return res.status(400).json({ success: false, error: 'Only image files supported by this function. Use PDF-support deployment (see docs).' });
    }

    const base64 = file.buffer.toString('base64');

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
      console.error('Vision error', json);
      return res.status(500).json({ success: false, error: 'Vision API error', details: json });
    }

    const fullText = json?.responses?.[0]?.fullTextAnnotation?.text || '';
    // Parse text into structured fields:
    const extracted = parseTextToFields(fullText);
    const confidence = estimateConfidence(json);
    return res.json({ success: true, extracted, confidence, errors: [] });
  } catch (err) {
    console.error('OCR endpoint error', err);
    return res.status(500).json({ success: false, error: String(err) });
  }
});

// small heuristic confidence estimator
function estimateConfidence(visionJson) {
  try {
    const page = visionJson?.responses?.[0]?.fullTextAnnotation?.pages?.[0];
    if (!page) return 0.7;
    // Vision doesn't give single confidence for fullTextAnnotation; use symbols confidence if present
    let confidences = [];
    const blocks = page.blocks || [];
    blocks.forEach((b) => {
      (b.paragraphs || []).forEach((p) => {
        (p.words || []).forEach((w) => {
          (w.symbols || []).forEach((s) => { if (s.confidence) confidences.push(s.confidence); });
        });
      });
    });
    if (!confidences.length) return 0.75;
    const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    return Math.round(Math.max(0.4, Math.min(0.99, avg)) * 100) / 100;
  } catch {
    return 0.75;
  }
}

// Basic text -> fields heuristics. Improve per your expected document formats.
function parseTextToFields(text) {
  // Normalize whitespace
  const t = text.replace(/\r/g, '\n').replace(/\t/g, ' ').trim();
  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const joined = lines.join(' | ');

  const out = {};

  // Name heuristics
  // Look for labels like "Name", "Student Name", "Applicant"
  const nameMatch = text.match(/(?:Student Name|Name|Candidate Name|Applicant[:\s\-]*)[:\s\-]*([A-Za-z ]{3,80})/i)
    || text.match(/([A-Z][a-z]{1,}\s[A-Z][a-z]{1,}(?:\s[A-Z][a-z]{1,})?)/);
  if (nameMatch) out['Student Name'] = (nameMatch[1] || nameMatch[0]).trim();

  // Father Name
  const fatherMatch = text.match(/(?:Father(?:'s)? Name|S\/O|S\/ O|Son of|Son of[:\s\-]*)[:\s\-]*([A-Za-z ]{3,80})/i);
  if (fatherMatch) out['Father Name'] = fatherMatch[1].trim();

  // CNIC pattern
  const cnicMatch = text.match(/\b\d{5}-\d{7}-\d\b/);
  if (cnicMatch) out['CNIC Number'] = cnicMatch[0];

  // Roll / Reg / Document numbers — common patterns (alphanumeric)
  const rollMatch = text.match(/Roll(?:\s*No|[:\s\-])*([A-Za-z0-9\-\/]{3,20})/i)
    || text.match(/\b(Roll|Reg|Registration|Seat No|Seat):?\s*([A-Za-z0-9\-\/]{3,20})/i);
  if (rollMatch) out['Roll Number'] = (rollMatch[2] || rollMatch[1] || '').toString().trim();

  // Year (4-digit)
  const yearMatch = text.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) out['Exam Year'] = yearMatch[0];

  // Marks / Percent
  const percentMatch = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  if (percentMatch) out['Percentage'] = percentMatch[1];

  const marksMatch = text.match(/Obtained\s*Marks[:\s]*([0-9]{2,4})/i) || text.match(/Marks\s*:\s*([0-9]{2,4})/i);
  if (marksMatch) out['Obtained Marks'] = marksMatch[1];

  // Board / Institute (heuristic: lines containing 'Board' or usual institute keywords)
  const boardLine = lines.find((l) => /board|university|institute|college/i.test(l) && l.length < 60);
  if (boardLine) out['Board'] = boardLine;

  // return extracted object
  return out;
}

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Vision OCR server listening on ${PORT}`));
}
export default app;