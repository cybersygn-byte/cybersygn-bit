"""
Render authored template markdown into professional, branded PDFs.

Reads every templates-content/<slug>.md and produces web/templates-pdf/<slug>.pdf:
a clean, multi-page, paginated contract with a CyberSygn footer, a highlighted
"customizable starting template" callout, real numbered sections, and signature
lines CyberSygn's field detection recognizes.

These pre-rendered PDFs are what the site serves on download/email and what goes
into the reviewable zip. Pre-rendering (vs generating in the worker) gives us
full typographic control and keeps the heavy contracts off the request path.

Run: python3 scripts/render-templates.py
Defensive: a failure on one file is logged and skipped, never aborts the batch.
"""

import re
import sys
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, KeepTogether
)
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "templates-content"
OUT = ROOT / "web" / "templates-pdf"
OUT.mkdir(parents=True, exist_ok=True)

NAVY = HexColor("#011434")
ACCENT = HexColor("#0B5CD6")
PLACEHOLDER = HexColor("#B0006A")
CALLOUT_BG = HexColor("#FFF6E6")
CALLOUT_BORDER = HexColor("#E0A300")
MUTED = HexColor("#4F5874")
RULE = HexColor("#D7DBE6")

styles = getSampleStyleSheet()

TITLE = ParagraphStyle("CSTitle", parent=styles["Title"], fontName="Helvetica-Bold",
                       fontSize=20, leading=24, textColor=NAVY, spaceAfter=6, alignment=TA_LEFT)
SECTION = ParagraphStyle("CSSection", parent=styles["Heading2"], fontName="Helvetica-Bold",
                         fontSize=12.5, leading=16, textColor=NAVY, spaceBefore=12, spaceAfter=4)
BODY = ParagraphStyle("CSBody", parent=styles["BodyText"], fontName="Helvetica",
                      fontSize=9.7, leading=14, textColor=HexColor("#1A2233"), spaceAfter=5)
INTRO = ParagraphStyle("CSIntro", parent=BODY, fontSize=10, leading=14.5)
CALLOUT = ParagraphStyle("CSCallout", parent=BODY, fontSize=9.2, leading=13,
                         textColor=HexColor("#5A4500"))
FOOTER_NOTE = ParagraphStyle("CSFooterNote", parent=BODY, fontName="Helvetica-Oblique",
                             fontSize=8.2, leading=11, textColor=MUTED, spaceBefore=10)
SIG = ParagraphStyle("CSSig", parent=BODY, fontSize=9.5, leading=18)


def esc(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def inline(s):
    """Convert a subset of markdown inline syntax to reportlab markup."""
    plain = esc(s)
    # Break pathologically long unbroken tokens. reportlab's line breaker
    # infinite-loops when a single token is wider than the frame (a long
    # underscore run or an unspaced placeholder). A zero-width space gives it
    # a legal break point without changing how the text reads.
    plain = re.sub(r"(\S{35})(?=\S)", lambda m: m.group(1) + "​", plain)
    out = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", plain)            # bold
    out = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<i>\1</i>", out)  # italic
    out = re.sub(r"(\[[^\]]+\])", r'<font color="#B0006A">\1</font>', out)  # placeholders
    # If a stray single * or other artifact left the inline tags unbalanced,
    # reportlab will reject the whole paragraph (or hang). Fall back to plain
    # escaped text (still readable) rather than lose the paragraph.
    for tag in ("b", "i", "font"):
        if out.count("<%s" % tag) != out.count("</%s>" % tag):
            return plain
    return out


def safe_para(text, style, frame_w=None):
    """Build a Paragraph, falling back to plain escaped text if reportlab cannot
    parse the inline markup (improperly nested tags, etc.). The wrap() call forces
    the parser to run now so the failure is caught here, not at doc.build()."""
    if frame_w is None:
        frame_w = letter[0] - 1.6 * inch
    try:
        p = Paragraph(inline(text), style)
        p.wrap(frame_w, 100000)
        return p
    except Exception:
        safe = re.sub(r"(\S{28})(?=\S)", lambda m: m.group(1) + "​", esc(text))
        return Paragraph(safe, style)


def parse_blocks(md):
    """Yield (kind, payload) blocks from the markdown."""
    lines = md.split("\n")
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue
        # Title
        if stripped.startswith("# ") and not stripped.startswith("## "):
            yield ("title", stripped[2:].strip())
            i += 1
            continue
        # Section heading
        if stripped.startswith("## "):
            yield ("section", stripped[3:].strip())
            i += 1
            continue
        # Any other heading level (###, ####, or a stray leading #) — render as a
        # sub-section so the line is CONSUMED. Without this, a '### ' line matches
        # none of the handlers above and falls into the paragraph branch below,
        # whose while-loop refuses lines starting with '#', so i never advances
        # and parse_blocks spins forever (this is what stalled ~285 templates).
        if stripped.startswith("#"):
            yield ("section", stripped.lstrip("#").strip())
            i += 1
            continue
        # Horizontal rule
        if stripped == "---":
            yield ("rule", None)
            i += 1
            continue
        # Blockquote callout (collect consecutive > lines)
        if stripped.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip().lstrip(">").strip())
                i += 1
            yield ("callout", " ".join(x for x in buf if x))
            continue
        # Table (collect consecutive | lines)
        if stripped.startswith("|"):
            buf = []
            while i < n and lines[i].strip().startswith("|"):
                buf.append(lines[i].strip())
                i += 1
            yield ("table", buf)
            continue
        # Paragraph (collect until a blank line or the start of another block).
        # Always consume the current line FIRST so i advances by at least one no
        # matter what — a hard guarantee that this loop can never stall.
        buf = [stripped]
        i += 1
        while i < n and lines[i].strip() and not lines[i].strip().startswith(("#", ">", "|")) and lines[i].strip() != "---":
            buf.append(lines[i].strip())
            i += 1
        yield ("para", " ".join(buf))


def build_table(rows):
    """Build a reportlab Table from markdown table rows; drop the separator row."""
    parsed = []
    for r in rows:
        cells = [c.strip() for c in r.strip().strip("|").split("|")]
        # skip markdown header separator rows like |---|---|
        if all(set(c) <= set("-: ") and c for c in cells):
            continue
        parsed.append(cells)
    if not parsed:
        return None
    ncol = max(len(r) for r in parsed)
    data = []
    for r in parsed:
        r = r + [""] * (ncol - len(r))
        data.append([safe_para(c, SIG) for c in r])
    avail = letter[0] - 1.6 * inch
    col_w = avail / ncol
    t = Table(data, colWidths=[col_w] * ncol, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, RULE),
    ]))
    return t


def callout_flowable(text):
    p = safe_para(text, CALLOUT)
    t = Table([[p]], colWidths=[letter[0] - 1.6 * inch])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CALLOUT_BG),
        ("BOX", (0, 0), (-1, -1), 1, CALLOUT_BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return t


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(0.8 * inch, 0.62 * inch, letter[0] - 0.8 * inch, 0.62 * inch)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(0.8 * inch, 0.45 * inch,
                      "Template provided by CyberSygn  -  cybersygn.io  -  Not legal advice. Consult a licensed attorney.")
    canvas.drawRightString(letter[0] - 0.8 * inch, 0.45 * inch, "Page %d" % doc.page)
    canvas.restoreState()


def render(md_path, pdf_path):
    md = md_path.read_text(encoding="utf-8")
    story = []
    for kind, payload in parse_blocks(md):
        if kind == "title":
            story.append(safe_para(payload, TITLE))
            story.append(HRFlowable(width="100%", thickness=1.2, color=ACCENT,
                                    spaceBefore=2, spaceAfter=8))
        elif kind == "callout":
            story.append(callout_flowable(payload))
            story.append(Spacer(1, 8))
        elif kind == "section":
            story.append(safe_para(payload, SECTION))
        elif kind == "rule":
            story.append(Spacer(1, 4))
        elif kind == "table":
            t = build_table(payload)
            if t is not None:
                story.append(Spacer(1, 6))
                story.append(t)
        elif kind == "para":
            txt = payload
            # footer disclaimer line (italic single-* wrapped) -> footnote style
            if txt.startswith("*") and txt.endswith("*") and txt.count("*") == 2:
                story.append(HRFlowable(width="100%", thickness=0.5, color=RULE,
                                        spaceBefore=10, spaceAfter=6))
                story.append(safe_para(txt.strip("*"), FOOTER_NOTE))
            else:
                # First non-title paragraph reads as intro
                story.append(safe_para(txt, BODY))
    doc = SimpleDocTemplate(
        str(pdf_path), pagesize=letter,
        leftMargin=0.8 * inch, rightMargin=0.8 * inch,
        topMargin=0.8 * inch, bottomMargin=0.85 * inch,
        title=md_path.stem.replace("-", " ").title(),
        author="CyberSygn",
    )
    doc.build(story, onFirstPage=footer, onLaterPages=footer)


def _timeout(signum, frame):
    raise TimeoutError("render exceeded per-file budget")


def render_canvas_plain(md_path, pdf_path):
    """Guaranteed-terminating fallback renderer.

    A tiny subset of templates make reportlab's Paragraph line-breaker spin for
    30s+ (not markup, not tables — confirmed by bisecting against a same-shape
    file that renders in 0.1s). The full render runs each file in a forked
    subprocess with a hard kill; when that kill fires, we fall back to here.

    This path uses the low-level canvas with reportlab's simpleSplit word wrap
    (O(words), cannot loop) and no Paragraph flowables, so it ALWAYS terminates.
    Plainer than the full render, but a complete, readable, branded contract PDF
    with the same footer + not-legal-advice disclaimer.
    """
    from reportlab.pdfgen import canvas as _canvas
    from reportlab.lib.utils import simpleSplit

    c = _canvas.Canvas(str(pdf_path), pagesize=letter,
                       title=md_path.stem.replace("-", " ").title(), author="CyberSygn")
    W, H = letter
    LM, RM, TM, BM = 0.8 * inch, 0.8 * inch, 0.85 * inch, 0.85 * inch
    maxw = W - LM - RM
    state = {"y": H - TM}

    def footer_line():
        c.setStrokeColor(RULE); c.setLineWidth(0.5)
        c.line(0.8 * inch, 0.62 * inch, W - 0.8 * inch, 0.62 * inch)
        c.setFont("Helvetica", 7.5); c.setFillColor(MUTED)
        c.drawString(0.8 * inch, 0.45 * inch,
                     "Template provided by CyberSygn  -  cybersygn.io  -  Not legal advice. Consult a licensed attorney.")
        c.drawRightString(W - 0.8 * inch, 0.45 * inch, "Page %d" % c.getPageNumber())

    def newpage():
        footer_line(); c.showPage(); state["y"] = H - TM

    def write(text, font="Helvetica", size=9.7, color=HexColor("#1A2233"), gap=4, lead=14):
        c.setFont(font, size); c.setFillColor(color)
        for raw in str(text).split("\n"):
            t = re.sub(r"\*\*|\*|`", "", raw)                 # drop md emphasis markers
            for line in simpleSplit(t, font, size, maxw):
                if state["y"] < BM + 16:
                    newpage(); c.setFont(font, size); c.setFillColor(color)
                c.drawString(LM, state["y"], line); state["y"] -= lead
        state["y"] -= gap

    for kind, payload in parse_blocks(md_path.read_text(encoding="utf-8")):
        if kind == "title":
            write(payload, "Helvetica-Bold", 17, NAVY, gap=8, lead=21)
        elif kind == "section":
            write(payload, "Helvetica-Bold", 11.5, NAVY, gap=3, lead=15)
        elif kind == "callout":
            write(payload, "Helvetica-Oblique", 9, HexColor("#5A4500"), gap=6, lead=13)
        elif kind == "table":
            for r in payload:
                cells = [x.strip() for x in r.strip().strip("|").split("|")]
                if all(set(x) <= set("-: ") and x for x in cells):
                    continue
                write("   ".join(cells), "Helvetica", 9, gap=1, lead=12)
            state["y"] -= 3
        elif kind == "para":
            write(payload)
    footer_line(); c.save()


def render_with_timeout(md_path, pdf_path, budget=12):
    """Render in a forked child with a HARD wall-clock kill. Returns True if the
    full render finished cleanly, False if it timed out or errored (caller then
    uses render_canvas_plain). A hard kill is required because the reportlab spin
    is not reliably interruptible by SIGALRM."""
    import os, time
    pid = os.fork()
    if pid == 0:  # child
        try:
            render(md_path, pdf_path)
            os._exit(0)
        except Exception:
            os._exit(2)
    deadline = time.time() + budget
    while time.time() < deadline:
        wpid, status = os.waitpid(pid, os.WNOHANG)
        if wpid == pid:
            return os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
        time.sleep(0.05)
    try:
        os.kill(pid, 9); os.waitpid(pid, 0)
    except Exception:
        pass
    return False


def main():
    import signal, sys
    # Per-file timeout backstop: even if a pathological paragraph slips past the
    # inline() guards and hangs reportlab, the alarm fires, the file is recorded
    # as a failure, and the batch continues. No single file can stall the run.
    signal.signal(signal.SIGALRM, _timeout)

    # Optional sharding so several processes can render disjoint file sets in
    # parallel with NO races (each process owns files where idx % n == i):
    #   python render-templates.py <shardIndex> <shardCount> [--force]
    # Resumable by default: a PDF newer than its source .md is skipped.
    shard_i, shard_n = 0, 1
    if len(sys.argv) >= 3:
        try:
            shard_i, shard_n = int(sys.argv[1]), int(sys.argv[2])
        except ValueError:
            shard_i, shard_n = 0, 1
    force = "--force" in sys.argv

    files = sorted(SRC.glob("*.md"))
    ok, skip, fail, fellback = 0, 0, 0, 0
    failures = []
    fallbacks = []
    for idx, f in enumerate(files):
        if shard_n > 1 and idx % shard_n != shard_i:
            continue
        out = OUT / (f.stem + ".pdf")
        if not force and out.exists() and out.stat().st_mtime >= f.stat().st_mtime:
            skip += 1
            continue
        # Full render in a hard-killed subprocess; on timeout/error use the
        # guaranteed-terminating canvas fallback so EVERY template gets a PDF.
        if render_with_timeout(f, out, budget=12):
            ok += 1
        else:
            try:
                render_canvas_plain(f, out)
                fellback += 1
                fallbacks.append(f.name)
            except Exception as e:  # never abort the batch
                fail += 1
                failures.append((f.name, str(e)[:160]))
    print(f"[shard {shard_i}/{shard_n}] full {ok}, fallback {fellback}, skipped {skip}, failed {fail} (of {len(files)} sources)")
    if fallbacks:
        print(f"FALLBACK (canvas-plain) ({fellback}): " + ", ".join(fallbacks[:40]))
    if failures:
        print(f"FAILURES ({fail}):")
        for name, err in failures:
            print(f"  {name}: {err}")


if __name__ == "__main__":
    main()
