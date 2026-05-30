"""
Generate ten test PDFs for CyberSygn field-detection prototype.

Each PDF represents a realistic field layout we expect to encounter.
Generator is deterministic so test output stays stable across runs.
"""

from pathlib import Path
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfform
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


def para(c, y, text, indent=0, lines=None):
    c.setFont(*BODY_FONT)
    for line in (lines or [text]):
        c.drawString(LEFT + indent, y, line)
        y -= LINE_H
    return y


def sig_line(c, y, label, line_width=3.0, gap=8):
    """Draw 'Label: __________' on a baseline."""
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, y, label)
    label_w = stringWidth(label, *BODY_FONT)
    x_start = LEFT + label_w + gap
    x_end = x_start + line_width * inch
    c.line(x_start, y - 2, x_end, y - 2)
    return y - LINE_H


def checkbox(c, y, label):
    c.setFont(*BODY_FONT)
    # draw an unchecked box
    c.rect(LEFT, y - 2, 10, 10)
    c.drawString(LEFT + 16, y, label)
    return y - LINE_H


def doc_01_simple_signature():
    path = OUT / "01-simple-signature.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Consulting Engagement Letter")
    y = para(c, y, "", lines=[
        "This engagement letter confirms the terms of the consulting",
        "services described in the attached scope of work. By signing",
        "below, you accept the terms and authorize payment per the",
        "schedule on page two.",
    ])
    y -= LINE_H
    y = sig_line(c, y, "Signature:")
    y = sig_line(c, y, "Printed name:")
    y = sig_line(c, y, "Date:")
    c.save()
    return path


def doc_02_legal_slash_s():
    path = OUT / "02-legal-slash-s.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Settlement Agreement")
    y = para(c, y, "", lines=[
        "The parties having reached agreement on all material terms,",
        "execute this settlement on the date indicated below.",
        "",
        "Executed by counsel for plaintiff:",
    ])
    y -= LINE_H * 2
    y = sig_line(c, y, "/s/", line_width=3.5)
    y = sig_line(c, y, "Name:")
    y -= LINE_H
    y = para(c, y, "Executed by counsel for defendant:")
    y -= LINE_H
    y = sig_line(c, y, "/s/", line_width=3.5)
    y = sig_line(c, y, "Name:")
    c.save()
    return path


def doc_03_multi_party():
    path = OUT / "03-multi-party.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Mutual Non-Disclosure Agreement")
    y = para(c, y, "", lines=[
        "Each party signs below to acknowledge the obligations described",
        "in Sections 1 through 7 of this agreement.",
    ])
    y -= LINE_H * 2
    y = para(c, y, "Disclosing party:")
    y = sig_line(c, y, "Signature:")
    y = sig_line(c, y, "Printed name:")
    y = sig_line(c, y, "Title:")
    y = sig_line(c, y, "Date:")
    y -= LINE_H
    y = para(c, y, "Receiving party:")
    y = sig_line(c, y, "Signature:")
    y = sig_line(c, y, "Printed name:")
    y = sig_line(c, y, "Title:")
    y = sig_line(c, y, "Date:")
    c.save()
    return path


def doc_04_initials_margins():
    path = OUT / "04-initials-margins.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Rental Agreement Addendum")
    y = para(c, y, "", lines=[
        "Tenant initials each section below to confirm understanding",
        "of the terms in that section. Sections must be initialed",
        "individually; a single signature at the end is insufficient.",
    ])
    y -= LINE_H
    for n, txt in enumerate([
        "Section 1, pet policy: dogs under 40 pounds are permitted with a",
        "Section 2, smoking: indoor smoking is prohibited on the property",
        "Section 3, guests: stays beyond 14 nights require written consent",
        "Section 4, parking: assigned space is space 12 in the lower lot",
    ], start=1):
        c.drawString(LEFT, y, txt)
        # initials line at right margin
        c.line(PAGE_W - 1.5 * inch, y - 2, PAGE_W - 1 * inch, y - 2)
        c.drawString(PAGE_W - 1.5 * inch - 60, y, "Initial:")
        y -= LINE_H * 2
    y -= LINE_H
    y = sig_line(c, y, "Tenant signature:")
    y = sig_line(c, y, "Date:")
    c.save()
    return path


def doc_05_checkboxes():
    path = OUT / "05-checkboxes.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Onboarding Acknowledgment")
    y = para(c, y, "Check each item below before signing.")
    y -= LINE_H
    for label in [
        "I have read the employee handbook.",
        "I understand the code of conduct.",
        "I agree to the at-will employment terms.",
        "I have completed safety training.",
        "I have set up direct deposit.",
    ]:
        y = checkbox(c, y, label)
    y -= LINE_H
    y = sig_line(c, y, "Employee signature:")
    y = sig_line(c, y, "Date:")
    c.save()
    return path


def doc_06_date_fields():
    path = OUT / "06-date-fields.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Statement of Work")
    y = para(c, y, "", lines=[
        "Project milestones and the dates by which each is to be",
        "completed are listed below. Sender and signer agree to the",
        "dates as written.",
    ])
    y -= LINE_H
    for n, label in enumerate([
        "Kickoff date:",
        "Mid-project review date:",
        "Delivery date:",
        "Final acceptance date:",
    ], start=1):
        y = sig_line(c, y, label, line_width=2.0)
    y -= LINE_H
    y = sig_line(c, y, "Client signature:")
    y = sig_line(c, y, "Date signed:")
    c.save()
    return path


def doc_07_acroform():
    """Real AcroForm fields, the easiest case for detection."""
    path = OUT / "07-acroform.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Vendor Intake Form")
    y = para(c, y, "Please complete the fields below.")
    y -= LINE_H

    c.drawString(LEFT, y, "Vendor name:")
    pdfform.textFieldRelative(c, "vendor_name", LEFT + 100, y - 4, 200, 14)
    y -= LINE_H * 2

    c.drawString(LEFT, y, "Tax ID:")
    pdfform.textFieldRelative(c, "tax_id", LEFT + 100, y - 4, 200, 14)
    y -= LINE_H * 2

    c.drawString(LEFT, y, "W-9 on file:")
    pdfform.buttonFieldRelative(c, "w9_on_file", "Off", LEFT + 100, y - 2)
    y -= LINE_H * 2

    c.drawString(LEFT, y, "Authorized signature:")
    pdfform.textFieldRelative(c, "auth_signature", LEFT + 130, y - 4, 200, 14)
    y -= LINE_H * 2

    c.drawString(LEFT, y, "Date:")
    pdfform.textFieldRelative(c, "date", LEFT + 100, y - 4, 100, 14)

    c.save()
    return path


def doc_08_multi_page():
    """Fields appear across three pages."""
    path = OUT / "08-multi-page.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)

    # Page 1: introduction with initial at bottom
    y = header(c, "Master Services Agreement, Page 1 of 3")
    y = para(c, y, "", lines=[
        "This Master Services Agreement governs all services provided",
        "by the Provider to the Client under any Statement of Work",
        "referencing this agreement. Capitalized terms are defined in",
        "Section 12.",
    ])
    y -= LINE_H * 6
    y = sig_line(c, y, "Initial here to confirm page reviewed:", line_width=1.5)
    c.showPage()

    # Page 2: terms with initial at bottom
    y = header(c, "Master Services Agreement, Page 2 of 3")
    y = para(c, y, "", lines=[
        "Section 4, Payment Terms. Invoices are due net 30 from the",
        "date of receipt. Late payments accrue interest at 1.5 percent",
        "per month or the maximum allowed by law, whichever is lower.",
        "",
        "Section 5, Termination. Either party may terminate this",
        "agreement on 30 days written notice.",
    ])
    y -= LINE_H * 4
    y = sig_line(c, y, "Initial here to confirm page reviewed:", line_width=1.5)
    c.showPage()

    # Page 3: signatures
    y = header(c, "Master Services Agreement, Page 3 of 3")
    y = para(c, y, "Both parties execute this agreement as of the date below.")
    y -= LINE_H * 2
    y = sig_line(c, y, "Provider signature:")
    y = sig_line(c, y, "Printed name:")
    y = sig_line(c, y, "Date:")
    y -= LINE_H
    y = sig_line(c, y, "Client signature:")
    y = sig_line(c, y, "Printed name:")
    y = sig_line(c, y, "Date:")

    c.save()
    return path


def doc_09_mixed():
    """Signature + initial + date + checkbox in one document."""
    path = OUT / "09-mixed.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Client Agreement")
    y = para(c, y, "", lines=[
        "This agreement combines acknowledgment, payment authorization,",
        "and signature in a single document.",
    ])
    y -= LINE_H
    y = para(c, y, "Acknowledgments, check each:")
    y = checkbox(c, y, "I authorize charges to the card on file.")
    y = checkbox(c, y, "I understand the cancellation policy.")
    y = checkbox(c, y, "I have received a copy of the privacy notice.")
    y -= LINE_H
    y = sig_line(c, y, "Initial:", line_width=1.5)
    y = sig_line(c, y, "Signature:")
    y = sig_line(c, y, "Printed name:")
    y = sig_line(c, y, "Date:")
    c.save()
    return path


def doc_10_no_label():
    """Signature line indicated only by an 'X' prefix, no explicit label."""
    path = OUT / "10-no-label.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    y = header(c, "Quick Approval")
    y = para(c, y, "", lines=[
        "Approve the attached proposal by signing on the line below.",
        "No additional information is required.",
    ])
    y -= LINE_H * 3
    # Just an X and a line
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, y, "X")
    c.line(LEFT + 14, y - 2, LEFT + 4 * inch, y - 2)
    y -= LINE_H * 2
    c.drawString(LEFT, y, "X")
    c.line(LEFT + 14, y - 2, LEFT + 2 * inch, y - 2)
    c.drawString(LEFT + 2.2 * inch, y, "(date)")
    c.save()
    return path


def main():
    generators = [
        doc_01_simple_signature,
        doc_02_legal_slash_s,
        doc_03_multi_party,
        doc_04_initials_margins,
        doc_05_checkboxes,
        doc_06_date_fields,
        doc_07_acroform,
        doc_08_multi_page,
        doc_09_mixed,
        doc_10_no_label,
    ]
    for gen in generators:
        path = gen()
        print(f"  wrote {path.name}")
    print(f"Generated {len(generators)} PDFs in {OUT}")


if __name__ == "__main__":
    main()
