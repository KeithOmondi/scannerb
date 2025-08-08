const express = require("express");
const multer = require("multer");
const xlsx = require("xlsx");
const pdfParse = require("pdf-parse");
const fuzzball = require("fuzzball");
const fs = require("fs");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ================== Multer Config ===================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// ================== Helper: Normalize Name ===================
const normalize = (str) => {
  if (!str || typeof str !== "string") return "";
  return str
    .toLowerCase()
    .replace(/alias.*$/g, "")   // remove alias
    .replace(/\s+/g, " ")       // normalize spaces
    .trim();
};

// ================== Match Endpoint ===================
app.post("/match", upload.fields([{ name: "excel" }, { name: "pdf" }]), async (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 100;
    const excelFile = req.files["excel"][0];
    const pdfFile = req.files["pdf"][0];

    // === Step 1: Read Excel ===
    const workbook = xlsx.readFile(excelFile.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const excelData = xlsx.utils.sheet_to_json(sheet);
    const excelNames = excelData
      .map(row => normalize(row["Name of The Deceased"]))
      .filter(Boolean);

    // === Step 2: Read and Parse PDF ===
    const pdfBuffer = fs.readFileSync(pdfFile.path);
    const pdfData = await pdfParse(pdfBuffer);
    const text = pdfData.text;

    // === Step 3: Extract Names from PDF ===
    const matches = new Set();

    // Pattern 1: Estate phrases
    const estateRegex = /(to the estate of|estate of|re:|for|by)\s+(.*?)(?:,|\n| who died| deceased)/gi;
    let match;
    while ((match = estateRegex.exec(text)) !== null) {
      matches.add(normalize(match[2]));
    }

    // Pattern 2: General capitalized names (fallback)
    const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
    const capitalizedNames = Array.from(text.matchAll(namePattern)).map(m => normalize(m[1]));
    capitalizedNames.forEach(name => matches.add(name));

    const pdfNames = Array.from(matches);

    // === Step 4: Parallel Match Logic ===
    const results = await Promise.all(
      excelNames.map(async (excelName) => {
        let bestMatch = { score: 0, gazetteMatch: "" };

        for (const gazetteName of pdfNames) {
          const score = fuzzball.ratio(excelName, gazetteName);
          if (score > bestMatch.score) {
            bestMatch = { score, gazetteMatch: gazetteName };
          }
        }

        if (bestMatch.score >= threshold) {
          return {
            excelName,
            gazetteMatch: bestMatch.gazetteMatch,
            score: bestMatch.score,
          };
        }

        return null;
      })
    );

    const finalResults = results.filter(r => r !== null);

    // === Step 5: Clean Uploaded Files ===
    fs.unlinkSync(excelFile.path);
    fs.unlinkSync(pdfFile.path);

    // === Step 6: Return Response ===
    res.json({ matched: finalResults });

  } catch (error) {
    console.error("❌ Error processing files:", error);
    res.status(500).json({ error: "Failed to process files." });
  }
});

// ================== Start Server ===================
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
