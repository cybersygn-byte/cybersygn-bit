# Pathological stress PDF: many pages, each dense with lines + labels, plus one
# absurdly dense page, to exercise the detector's caps, budget, and min/max guards.
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from pathlib import Path
OUT = Path(__file__).resolve().parent.parent / "web" / "templates-pdf" / "_stress-huge.pdf"
c = canvas.Canvas(str(OUT), pagesize=letter)
W, H = letter
# 60 dense pages
for pg in range(60):
    c.setFont("Helvetica", 6)
    y = H - 20
    for i in range(120):
        c.drawString(30, y, f"Signature {i}:")
        c.line(90, y-1, 320, y-1)
        c.drawString(330, y, "Date:")
        c.line(360, y-1, 470, y-1)
        y -= 6
        if y < 20: break
    c.showPage()
# one absurdly dense page (3000 lines) to hit per-page caps
c.setFont("Helvetica", 3)
y = H - 10
for i in range(3000):
    c.line(20, y, 580, y)
    y -= 0.25
    if y < 5:
        c.showPage(); c.setFont("Helvetica", 3); y = H - 10
c.save()
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
