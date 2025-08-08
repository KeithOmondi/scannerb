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

// === Multer Configuration ===
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage });

// === Normalize Helper ===
const normalize = (str) => {
  if (!str || typeof str !== "string") return "";
  return str
    .toLowerCase()
    .replace(/alias.*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
};

// === Core Route ===

app.post("/match", upload.fields([{ name: "excel" }, { name: "pdf" }]), async (req, res, next) => {
  const cleanup = () => {
    try {
      if (req.files?.excel?.[0]?.path) fs.unlinkSync(req.files.excel[0].path);
      if (req.files?.pdf?.[0]?.path) fs.unlinkSync(req.files.pdf[0].path);
    } catch (err) {
      console.error("⚠️ File cleanup failed:", err);
    }
  };

  try {
    console.log("📥 Received upload");
    const threshold = parseInt(req.query.threshold) || 100;

    const excelFile = req.files?.excel?.[0];
    const pdfFile = req.files?.pdf?.[0];

    if (!excelFile || !pdfFile) {
      console.log("❌ Missing files");
      return res.status(400).json({ error: "Both Excel and PDF files are required." });
    }

    // === Read Excel File ===
    const workbook = xlsx.readFile(excelFile.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const excelData = xlsx.utils.sheet_to_json(sheet);
    const excelNames = excelData
      .map(row => normalize(row["Name of The Deceased"]))
      .filter(Boolean);
    console.log("✅ Excel names:", excelNames.length);

    if (!excelNames.length) {
      cleanup();
      return res.status(400).json({ error: "Excel sheet is empty or missing name column." });
    }

    // === Read PDF File ===
    const pdfBuffer = fs.readFileSync(pdfFile.path);
    const pdfText = (await pdfParse(pdfBuffer)).text;
    console.log("✅ PDF text length:", pdfText.length);

    // === Extract Names from PDF ===
    const matches = new Set();

    const estateRegex = /(to the estate of|estate of|re:|for|by)\s+(.*?)(?:,|\n| who died| deceased)/gi;
    let match;
    while ((match = estateRegex.exec(pdfText)) !== null) {
      matches.add(normalize(match[2]));
    }

    const fallbackRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
    Array.from(pdfText.matchAll(fallbackRegex)).forEach(m =>
      matches.add(normalize(m[1]))
    );

    const gazetteNames = Array.from(matches);
    console.log("✅ Gazette names extracted:", gazetteNames.length);

    // === Efficient Batch Matching Using `fuzzball.extract()` ===
    const results = excelNames.map(excelName => {
      const topMatch = fuzzball.extract(excelName, gazetteNames, {
        scorer: fuzzball.ratio,
        returnObjects: true,
        limit: 1,
      })[0];

      return {
        excelName,
        gazetteMatch: topMatch.string,
        score: topMatch.score,
      };
    }).filter(result => result.score >= threshold);

    console.log("✅ Matching complete:", results.length, "matches found");
    cleanup();
    return res.status(200).json({ matched: results });

  } catch (err) {
    console.error("❌ Error during processing:", err);
    cleanup();
    next(err);
  }
});



// === Error Handler Middleware ===
app.use((err, req, res, next) => {
  res.status(500).json({
    error: "Something went wrong. Please try again later.",
    details: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// === Start Server ===
app.listen(PORT, () =>
  console.log(`✅ Server running on http://localhost:${PORT}`)
);
