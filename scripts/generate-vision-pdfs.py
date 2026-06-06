"""
Generate ten VISION-FALLBACK synthetic PDFs for CyberSygn.

These PDFs are designed so the text-based detector in worker/src/detect.js
either returns zero signature/date/checkbox fields or returns the wrong
ones — which forces the vision-based detection path to kick in. They are
the regression suite for the vision fallback.

Each PDF mimics a real-world failure mode of text-layer detection:
  11 — blank lines only, no English labels
  12 — stylized X-marks instead of "Signature:" labels
  13 — page contents rotated 90 degrees (landscape baselines)
  14 — numbered blanks with no semantic labels
  15 — pure tabular signature block, columns headed Name / Title / Date
  16 — Spanish "Firma:" / "Fecha:" / "Iniciales:"
  17 — French "Signature:" + "Date:" + "Paraphe:" mixed
  18 — German "Unterschrift:" / "Datum:" / "Initialen:"
  19 — heavy DRAFT watermark + decorative borders obscuring labels
  20 — shape-only form (circles, lines) with no labels at all

Run: python3 scripts/generate-vision-pdfs.py
Output: test-pdfs/11-*.pdf through test-pdfs/20-*.pdf
"""

from pathlib import Path
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.pdfbase.pdfmetrics import stringWidth

OUT = Path(__file__).resolve().parent.parent / "test-pdfs"
OUT.mkdir(parents=True, exist_ok=True)

PAGE_W, PAGE_H = letter
LEFT = 1 * inch
TOP = PAGE_H - 1 * inch
LINE_H = 14
BODY_FONT = ("Helvetica", 11)
HEAD_FONT = ("Helvetica-Bold", 14)


def header(c, title):
    c.setFont(*HEAD_FONT)
    c.drawString(LEFT, TOP, title)
    c.setFont(*BODY_FONT)
    return TOP - LINE_H * 2


def para(c, y, lines, indent=0):
    c.setFont(*BODY_FONT)
    for line in lines:
        c.drawString(LEFT + indent, y, line)
        y -= LINE_H
    return y


def blank_line(c, y, x_start, length_inches=3.0):
    """Bare horizontal line, no label."""
    c.line(x_start, y - 2, x_start + length_inches * inch, y - 2)
    return y - LINE_H


def blank_box(c, y, x_start, length_inches=3.0, height=22):
    """Rectangle outline as a signature target — no horizontal line for the
    text detector to grab, but visually unmistakable to a vision model."""
    c.rect(x_start, y - height + 6, length_inches * inch, height)
    return y - LINE_H - 12


def doc_11_blank_lines_only():
    """No labels, no horizontal lines — just empty rectangles where a human
    signs. Vision sees the obvious signing areas; text walker finds nothing
    matchable."""
    path = OUT / "11-blank-lines-only.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Approval")
    y = para(c, y, [
        "The undersigned approves the attached proposal.",
        "",
    ])
    y -= LINE_H * 4
    y = blank_box(c, y, LEFT, 4.0)
    y -= LINE_H
    y = blank_box(c, y, LEFT, 4.0)
    y -= LINE_H
    y = blank_box(c, y, LEFT, 2.0)
    c.save()
    return path


def doc_12_stylized_x_marks():
    """X markers as decorative shapes beside empty rectangles. No text labels,
    no horizontal underlines for the text walker to grab."""
    path = OUT / "12-stylized-x-marks.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Quick Confirm")
    y = para(c, y, [
        "Mark the boxes below to confirm.",
        "",
    ])
    y -= LINE_H * 2
    for _ in range(3):
        # X glyph as two crossing strokes
        cx, cy = LEFT, y
        c.line(cx, cy - 6, cx + 10, cy + 4)
        c.line(cx, cy + 4, cx + 10, cy - 6)
        # Empty rectangle beside the X — vision sees a signing area
        c.rect(cx + 18, y - 16, 4 * inch, 22)
        y -= LINE_H * 3
    c.save()
    return path


def doc_13_rotated_landscape():
    """Rotated 90 degrees and rendered with no text — only shapes. Vision
    sees the layout; text walker finds nothing because there is no text
    content stream in the page."""
    path = OUT / "13-rotated-landscape.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    c.saveState()
    # Rotate to landscape coordinate space
    c.translate(PAGE_W, 0)
    c.rotate(90)
    # Decorative bar at top (no text)
    c.setFillColorRGB(0.2, 0.2, 0.3)
    c.rect(72, PAGE_W - 100, PAGE_H - 144, 30, fill=1, stroke=0)
    c.setFillColorRGB(0, 0, 0)
    # Three rectangular signature areas
    cy = PAGE_W - 200
    for _ in range(3):
        c.rect(72, cy - 22, 300, 30)
        cy -= 60
    c.restoreState()
    c.save()
    return path


def doc_14_numbered_blanks():
    """Blanks labeled with numbers only, no signature semantic."""
    path = OUT / "14-numbered-blanks.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Intake")
    y = para(c, y, [
        "Complete each item below.",
        "",
    ])
    y -= LINE_H
    for n in range(1, 6):
        c.drawString(LEFT, y, f"{n})")
        c.line(LEFT + 20, y - 2, LEFT + 20 + 4 * inch, y - 2)
        y -= LINE_H * 2
    c.save()
    return path


def doc_15_tabular_signature():
    """Two-row table with header Name/Title/Date — no 'Signature' text."""
    path = OUT / "15-tabular-signature.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Acceptance Record")
    y = para(c, y, [
        "Both parties record acceptance in the table below.",
        "",
    ])
    y -= LINE_H * 2
    table_left = LEFT
    col_width = 1.7 * inch
    row_height = 30
    c.setFont("Helvetica-Bold", 10)
    # Header row
    for i, head in enumerate(["Name", "Title", "Date"]):
        x = table_left + i * col_width
        c.rect(x, y - row_height, col_width, row_height)
        c.drawString(x + 6, y - row_height + 18, head)
    y -= row_height
    c.setFont(*BODY_FONT)
    # Data rows (empty for signing)
    for _ in range(2):
        for i in range(3):
            x = table_left + i * col_width
            c.rect(x, y - row_height, col_width, row_height)
        y -= row_height
    c.save()
    return path


def doc_16_spanish_form():
    """Pure Spanish labels: Firma, Fecha, Iniciales."""
    path = OUT / "16-spanish-form.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Acuerdo de Servicios")
    y = para(c, y, [
        "Las partes firman a continuacion para aceptar los terminos del",
        "acuerdo. Las iniciales en cada seccion confirman la revision.",
        "",
    ])
    y -= LINE_H * 2
    for label in ["Firma:", "Nombre impreso:", "Cargo:", "Fecha:"]:
        c.drawString(LEFT, y, label)
        label_w = stringWidth(label, *BODY_FONT)
        c.line(LEFT + label_w + 10, y - 2, LEFT + label_w + 10 + 3 * inch, y - 2)
        y -= LINE_H * 2
    y = para(c, y, ["Iniciales:"])
    c.line(LEFT + 60, y - 2 + LINE_H, LEFT + 60 + 60, y - 2 + LINE_H)
    c.save()
    return path


def doc_17_french_form():
    """French labels: Signature is shared with English; Date too. Paraphe is the trap."""
    path = OUT / "17-french-form.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Contrat de Prestation de Services")
    y = para(c, y, [
        "Les parties signent ci-dessous pour accepter les termes du contrat.",
        "Le paraphe sur chaque page confirme la lecture du document.",
        "",
    ])
    y -= LINE_H * 2
    for label in ["Signature:", "Nom imprime:", "Fonction:", "Date:"]:
        c.drawString(LEFT, y, label)
        label_w = stringWidth(label, *BODY_FONT)
        c.line(LEFT + label_w + 10, y - 2, LEFT + label_w + 10 + 3 * inch, y - 2)
        y -= LINE_H * 2
    y = para(c, y, ["Paraphe sur chaque page :"])
    c.line(LEFT + 150, y - 2 + LINE_H, LEFT + 150 + 60, y - 2 + LINE_H)
    c.save()
    return path


def doc_18_german_form():
    """Pure German labels: Unterschrift, Datum, Initialen."""
    path = OUT / "18-german-form.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Dienstleistungsvertrag")
    y = para(c, y, [
        "Die Parteien unterschreiben unten zur Annahme der Vertragsbedingungen.",
        "Die Initialen auf jeder Seite bestaetigen die Lektuere.",
        "",
    ])
    y -= LINE_H * 2
    for label in ["Unterschrift:", "Name in Druckbuchstaben:", "Funktion:", "Datum:"]:
        c.drawString(LEFT, y, label)
        label_w = stringWidth(label, *BODY_FONT)
        c.line(LEFT + label_w + 10, y - 2, LEFT + label_w + 10 + 3 * inch, y - 2)
        y -= LINE_H * 2
    y = para(c, y, ["Initialen:"])
    c.line(LEFT + 60, y - 2 + LINE_H, LEFT + 60 + 60, y - 2 + LINE_H)
    c.save()
    return path


def doc_19_watermark_decorative():
    """Standard signature block buried under heavy DRAFT watermark + ornaments."""
    path = OUT / "19-watermark-decorative.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    # Decorative border
    c.setStrokeColorRGB(0.5, 0.5, 0.6)
    c.setLineWidth(2)
    c.rect(36, 36, PAGE_W - 72, PAGE_H - 72)
    c.setLineWidth(0.5)
    c.rect(45, 45, PAGE_W - 90, PAGE_H - 90)
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(1)
    # Big DRAFT watermark across the page diagonally
    c.saveState()
    c.setFillColorRGB(0.85, 0.85, 0.85)
    c.translate(PAGE_W / 2, PAGE_H / 2)
    c.rotate(45)
    c.setFont("Helvetica-Bold", 120)
    c.drawCentredString(0, 0, "DRAFT")
    c.restoreState()
    c.setFillColorRGB(0, 0, 0)
    # Content over the watermark
    y = header(c, "Letter of Intent")
    y = para(c, y, [
        "This letter sets out the principal terms of the proposed engagement.",
        "Signature below indicates intent to proceed.",
        "",
    ])
    y -= LINE_H * 3
    for label in ["Signature:", "Date:"]:
        c.drawString(LEFT, y, label)
        label_w = stringWidth(label, *BODY_FONT)
        c.line(LEFT + label_w + 10, y - 2, LEFT + label_w + 10 + 3 * inch, y - 2)
        y -= LINE_H * 2
    c.save()
    return path


def doc_20_shape_only_form():
    """Pure shapes — circles, rectangles. No text, no horizontal lines that
    the text detector could match as signature underlines."""
    path = OUT / "20-shape-only-form.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    # Decorative banner at top
    c.setFillColorRGB(0.2, 0.2, 0.3)
    c.rect(LEFT, PAGE_H - 1.5 * inch, PAGE_W - 2 * inch, 0.4 * inch, fill=1, stroke=0)
    c.setFillColorRGB(0, 0, 0)
    y = PAGE_H - 2.3 * inch
    # Three rows: circle marker + empty rectangle (signature area)
    for _ in range(3):
        c.circle(LEFT + 8, y, 6)
        c.rect(LEFT + 22, y - 16, 4 * inch, 22)
        y -= LINE_H * 3
    y -= LINE_H
    # Two checkbox-style empty squares + adjacent rectangles
    for _ in range(2):
        c.rect(LEFT, y - 6, 12, 12)
        c.rect(LEFT + 22, y - 16, 3 * inch, 22)
        y -= LINE_H * 3
    c.save()
    return path


def main():
    generators = [
        doc_11_blank_lines_only,
        doc_12_stylized_x_marks,
        doc_13_rotated_landscape,
        doc_14_numbered_blanks,
        doc_15_tabular_signature,
        doc_16_spanish_form,
        doc_17_french_form,
        doc_18_german_form,
        doc_19_watermark_decorative,
        doc_20_shape_only_form,
    ]
    for gen in generators:
        path = gen()
        print(f"  wrote {path.name}")
    print(f"Generated {len(generators)} vision-fallback PDFs in {OUT}")


if __name__ == "__main__":
    main()
