const express = require("express");
const PDFDocument = require("pdfkit");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── JSON FILE STORAGE ────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, "data");
const ORDER_FILE = path.join(DATA_DIR, "orders.json");

// Make sure data folder exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

// Read all orders from JSON file
function readOrders() {
  if (!fs.existsSync(ORDER_FILE)) return [];
  try {
    const raw = fs.readFileSync(ORDER_FILE, "utf8");
    return JSON.parse(raw) || [];
  } catch (e) {
    return [];
  }
}

// Write orders array back to JSON file
function writeOrders(orders) {
  fs.writeFileSync(ORDER_FILE, JSON.stringify(orders, null, 2), "utf8");
}

// ─── ADMIN AUTH ───────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "crfashions@2026";
const activeSessions = new Set();

function generateToken() { return crypto.randomBytes(32).toString("hex"); }

function isAdmin(req) {
  const token = req.headers["x-admin-token"] || req.query.adminToken;
  return token && activeSessions.has(token);
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req))
    return res.status(403).json({ error: "Unauthorized. Admin access required." });
  next();
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const DEFAULT_FROM_NAME = "CR FASHIONS";
const DEFAULT_FROM_PHONE = "7032208265";

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getTodayStr() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  return `${mm}-${dd}-${yyyy}`; // MM-DD-YYYY
}

function getTimeStr() {
  return new Date().toLocaleTimeString("en-IN", { hour12: true });
}

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
app.post("/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = generateToken();
    activeSessions.add(token);
    return res.json({ success: true, token });
  }
  res.status(401).json({ success: false, error: "Incorrect password" });
});

app.post("/admin/logout", (req, res) => {
  const token = req.headers["x-admin-token"];
  if (token) activeSessions.delete(token);
  res.json({ success: true });
});

app.get("/admin/verify", (req, res) => {
  res.json({ admin: isAdmin(req) });
});

// ─── PUBLIC ROUTES ────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Anyone can submit an order → saved to orders.json
app.post("/submit_order", (req, res) => {
  try {
    const { toName, toAddress, fromName, fromPhone } = req.body;
    if (!toName || !toAddress)
      return res.status(400).json({ error: "Name and address are required" });

    const orders = readOrders();
    const id = orders.length + 1;
    const dateStr = getTodayStr();
    const timeStr = getTimeStr();

    const newOrder = {
      id,
      toName,
      toAddress,
      fromName: fromName || DEFAULT_FROM_NAME,
      fromPhone: fromPhone || DEFAULT_FROM_PHONE,
      date: dateStr,
      time: timeStr,
    };

    orders.push(newOrder);
    writeOrders(orders);

    res.json({ success: true, id, dateStr, timeStr });
  } catch (err) {
    console.error("submit_order error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN-ONLY ROUTES ────────────────────────────────────────────────────────

// Get orders — optionally filtered by date (MM-DD-YYYY)
app.get("/get_orders", requireAdmin, (req, res) => {
  try {
    const { date } = req.query;
    const orders = readOrders();

    const filtered = date
      ? orders.filter((o) => o.date === date)
      : orders;

    res.json(filtered);
  } catch (err) {
    console.error("get_orders error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Download all orders as JSON
app.get("/download_json", requireAdmin, (req, res) => {
  try {
    const orders = readOrders();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=CR_Fashions_Orders.json");
    res.send(JSON.stringify(orders, null, 2));
  } catch (err) {
    console.error("download_json error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload JSON to import/append orders
app.post("/upload_json", requireAdmin, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const raw = req.file.buffer.toString("utf8");
    const incoming = JSON.parse(raw);
    if (!Array.isArray(incoming)) return res.status(400).json({ error: "JSON must be an array of orders" });

    const existing = readOrders();

    // Always append all incoming orders, re-assign IDs sequentially
    const merged = [...existing, ...incoming].map((o, i) => ({ ...o, id: i + 1 }));
    writeOrders(merged);

    res.json({ success: true, added: incoming.length, total: merged.length });
  } catch (err) {
    console.error("upload_json error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate PDF shipping labels by date (MM-DD-YYYY)
app.get("/generate_labels", requireAdmin, (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "Date parameter required" });

    const orders = readOrders();
    const filtered = orders.filter((o) => o.date === date);

    if (filtered.length === 0)
      return res.status(404).json({ message: `No orders found for ${date}` });

    const doc = new PDFDocument({ size: "A4", margin: 30 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=shipping_labels_${date}.pdf`);
    doc.pipe(res);

    // Dynamic layout — 2 columns, rows grow to fit tallest label
    const PAGE_HEIGHT = 841; // A4 points
    const MARGIN = 30;
    const COL_WIDTH = 270;
    const GAP = 12;
    const TEXT_WIDTH = 260 - 12 * 2;
    const LINE_GAP = 3;

    // Helper: measure label height the same way drawLabel does
    function measureLabelHeight(order) {
      doc.font("Helvetica").fontSize(11);
      // Must match the same collapse logic used in drawLabel
      const address = (order.toAddress || "").replace(/\s*\n\s*/g, ", ").replace(/,\s*,/g, ",").trim();
      const nameH = doc.heightOfString(`Name: ${order.toName || ""}`, { width: TEXT_WIDTH, lineGap: LINE_GAP });
      const addrLblH = doc.heightOfString("Address:", { width: TEXT_WIDTH, lineGap: LINE_GAP });
      const addrH = doc.heightOfString(address, { width: TEXT_WIDTH, lineGap: LINE_GAP });
      const fromNameH = doc.heightOfString(`Name: ${order.fromName || ""}`, { width: TEXT_WIDTH, lineGap: LINE_GAP });
      const phoneH = doc.heightOfString(`Phone: ${order.fromPhone || ""}`, { width: TEXT_WIDTH, lineGap: LINE_GAP });
      const unboxH = doc.heightOfString("UNBOX VIDEO IS MANDATORY", { width: TEXT_WIDTH, lineGap: LINE_GAP });
      return 10 + 16 + 6 + nameH + 6 + addrLblH + 4 + addrH + 12 + 16 + 6 + fromNameH + 6 + phoneH + 8 + unboxH + 14;
    }

    // Group into rows of 2
    const rows = [];
    for (let i = 0; i < filtered.length; i += 2) {
      rows.push(filtered.slice(i, i + 2));
    }

    let rowY = MARGIN;

    rows.forEach((pair) => {
      // Row height = tallest label in the pair
      const rowHeight = Math.max(...pair.map(measureLabelHeight));

      // New page if row doesn't fit
      if (rowY + rowHeight > PAGE_HEIGHT - MARGIN) {
        doc.addPage();
        rowY = MARGIN;
      }

      // Draw labels side by side
      pair.forEach((order, colIndex) => {
        drawLabel(doc, MARGIN + colIndex * COL_WIDTH, rowY, {
          toName: order.toName || "",
          toAddress: order.toAddress || "",
          fromName: order.fromName || DEFAULT_FROM_NAME,
          fromPhone: order.fromPhone || DEFAULT_FROM_PHONE,
        });
      });

      rowY += rowHeight + GAP;
    });

    doc.end();
  } catch (err) {
    console.error("generate_labels error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate PDF label for a single order by id
app.get("/generate_label_single", requireAdmin, (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: "id parameter required" });

    const orders = readOrders();
    const order = orders.find(o => String(o.id) === String(id));
    if (!order) return res.status(404).json({ error: "Order not found" });

    const doc = new PDFDocument({ size: [300, 400], margin: 0 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=label_${id}.pdf`);
    doc.pipe(res);

    drawLabel(doc, 20, 20, {
      toName: order.toName || "",
      toAddress: order.toAddress || "",
      fromName: order.fromName || DEFAULT_FROM_NAME,
      fromPhone: order.fromPhone || DEFAULT_FROM_PHONE,
    });

    doc.end();
  } catch (err) {
    console.error("generate_label_single error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── PDF DRAWING ──────────────────────────────────────────────────────────────
function drawLabel(doc, x, y, label) {
  const width = 260;
  const padding = 12;
  const textWidth = width - padding * 2;
  const fontSize = 11;
  const lineGap = 3;

  doc.font("Helvetica").fontSize(fontSize);

  // Collapse all line breaks/extra spaces into a single flowing paragraph
  const address = (label.toAddress || "").replace(/\s*\n\s*/g, ", ").replace(/,\s*,/g, ",").trim();

  // Measure each part accurately
  const nameHeight = doc.heightOfString(`Name: ${label.toName}`, { width: textWidth, lineGap });
  const addrLblHeight = doc.heightOfString("Address:", { width: textWidth, lineGap });
  const addrHeight = doc.heightOfString(address, { width: textWidth, lineGap });
  const fromNameH = doc.heightOfString(`Name: ${label.fromName}`, { width: textWidth, lineGap });
  const phoneH = doc.heightOfString(`Phone: ${label.fromPhone}`, { width: textWidth, lineGap });
  const unboxH = doc.heightOfString("UNBOX VIDEO IS MANDATORY", { width: textWidth, lineGap });

  // Calculate total height dynamically
  const totalHeight =
    10 +              // top padding
    16 +              // "TO:" line
    6 +              // gap
    nameHeight + 6 +
    addrLblHeight + 4 +
    addrHeight + 12 + // extra gap after address
    16 +              // "FROM:" line
    6 +
    fromNameH + 6 +
    phoneH + 8 +
    unboxH +
    14;               // bottom padding

  // Draw the box with exact calculated height
  doc.rect(x, y, width, totalHeight).stroke();

  let cy = y + 10;

  // ── TO ──
  doc.font("Helvetica-Bold").fontSize(12).text("TO:", x + padding, cy, { underline: true });
  cy += 16 + 6;

  doc.font("Helvetica").fontSize(fontSize);
  // "Name:" bold, value normal
  doc.font("Helvetica-Bold").text("Name: ", x + padding, cy, { continued: true, lineGap });
  doc.font("Helvetica").text(label.toName, { lineGap });
  cy += nameHeight + 6;

  // "Address:" bold
  doc.font("Helvetica-Bold").text("Address:", x + padding, cy, { width: textWidth, lineGap });
  cy += addrLblHeight + 4;

  // Address text — normal font, wraps naturally
  doc.font("Helvetica").text(address, x + padding, cy, { width: textWidth, lineGap });
  cy += addrHeight + 12;

  // ── FROM ──
  doc.font("Helvetica-Bold").fontSize(12).text("FROM:", x + padding, cy, { underline: true });
  cy += 16 + 6;

  doc.font("Helvetica").fontSize(fontSize);
  // "Name:" bold, value normal
  doc.font("Helvetica-Bold").text("Name: ", x + padding, cy, { continued: true, lineGap });
  doc.font("Helvetica").text(label.fromName, { lineGap });
  cy += fromNameH + 6;

  // "Phone:" bold, value normal
  doc.font("Helvetica-Bold").text("Phone: ", x + padding, cy, { continued: true, lineGap });
  doc.font("Helvetica").text(label.fromPhone, { lineGap });
  cy += phoneH + 8;

  // ── UNBOX ──
  doc.font("Helvetica-Bold").fontSize(15)
    .text("UNBOX VIDEO IS MANDATORY", x + padding, cy, { width: textWidth, align: "center", lineGap });
}

// ─── START ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ CR Fashions running on port ${PORT}`);
  console.log(`📁 Data file: ${ORDER_FILE}`);
});
