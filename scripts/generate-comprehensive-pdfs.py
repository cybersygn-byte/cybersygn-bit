"""
generate-comprehensive-pdfs.py — the full synthetic test suite for CyberSygn.

Produces 100 PDFs organized into 10 detection categories under test-pdfs/.
Each category isolates one detection concern, with 10 variations covering
the full range of how that pattern appears in real-world contracts.

Categories (10 PDFs each, 100 total):
  signatures/      every signature label variant we need to detect
  initials/        every initial pattern (single, per-page, per-clause)
  dates/           every date label format including international
  checkboxes/      every checkbox visual style
  text-fields/     every single-line text input pattern
  multi-signer/    every multi-party signing layout
  acroforms/       native PDF form field types
  international/   10 languages including Spanish/French/German/Russian/Japanese/Arabic
  positioning/     fields placed in every page position
  adversarial/     decoy patterns that try to fool the detector

Existing tests 01..20 in test-pdfs/ stay in place (text-layer + vision-fallback).

Run: python3 scripts/generate-comprehensive-pdfs.py
Verify: node scripts/probe-comprehensive-pdfs.mjs
"""

from pathlib import Path
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfform
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase import pdfmetrics

OUT_ROOT = Path(__file__).resolve().parent.parent / "test-pdfs"

PAGE_W, PAGE_H = letter
LEFT = 1 * inch
TOP = PAGE_H - 1 * inch
LINE_H = 14
BODY_FONT = ("Helvetica", 11)
HEAD_FONT = ("Helvetica-Bold", 14)


# ============================================================
# Drawing helpers
# ============================================================

def new_doc(category, name):
    """Open a canvas under test-pdfs/<category>/<name>."""
    folder = OUT_ROOT / category
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    c = canvas.Canvas(str(path), pagesize=letter)
    return c, path


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


def sig_line(c, y, label, line_width=3.0, gap=8, indent=0):
    """Label: __________ on a baseline."""
    c.setFont(*BODY_FONT)
    c.drawString(LEFT + indent, y, label)
    label_w = stringWidth(label, *BODY_FONT)
    x_start = LEFT + indent + label_w + gap
    x_end = x_start + line_width * inch
    c.line(x_start, y - 2, x_end, y - 2)
    return y - LINE_H


def checkbox(c, y, label, box_size=10, prefilled=False):
    c.setFont(*BODY_FONT)
    c.rect(LEFT, y - 2, box_size, box_size)
    if prefilled:
        # X inside the box
        c.line(LEFT, y - 2, LEFT + box_size, y - 2 + box_size)
        c.line(LEFT, y - 2 + box_size, LEFT + box_size, y - 2)
    c.drawString(LEFT + box_size + 6, y, label)
    return y - LINE_H


# ============================================================
# CATEGORY A: signatures/ (10 variants)
# ============================================================

def sig_01_signature_colon():
    c, p = new_doc("signatures", "01-signature-colon.pdf")
    y = header(c, "Engagement Letter")
    y = para(c, y, ["The terms above are accepted by the signature below.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Signature:")
    y = sig_line(c, y, "Date:")
    c.save()
    return p


def sig_02_sign_here():
    c, p = new_doc("signatures", "02-sign-here.pdf")
    y = header(c, "Quick Approval")
    y = para(c, y, ["Sign on the line below to authorize.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Sign here:")
    y = sig_line(c, y, "Date:")
    c.save()
    return p


def sig_03_slash_s():
    c, p = new_doc("signatures", "03-slash-s-legal.pdf")
    y = header(c, "Settlement Agreement")
    y = para(c, y, ["Executed by counsel below.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "/s/", line_width=3.5)
    y = sig_line(c, y, "Name:")
    y = sig_line(c, y, "Date:")
    c.save()
    return p


def sig_04_x_marker():
    c, p = new_doc("signatures", "04-x-marker.pdf")
    y = header(c, "Quick Confirm")
    y = para(c, y, ["X below to confirm acceptance.", ""])
    y -= LINE_H * 3
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, y, "X")
    c.line(LEFT + 14, y - 2, LEFT + 14 + 4 * inch, y - 2)
    y -= LINE_H * 2
    c.drawString(LEFT, y, "X")
    c.line(LEFT + 14, y - 2, LEFT + 14 + 2 * inch, y - 2)
    c.drawString(LEFT + 2.5 * inch, y, "(date)")
    c.save()
    return p


def sig_05_authorize_label():
    c, p = new_doc("signatures", "05-authorize-label.pdf")
    y = header(c, "Authorization Form")
    y = para(c, y, ["I authorize the actions described above.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Authorized signature:")
    y = sig_line(c, y, "Date:")
    c.save()
    return p


def sig_06_by_label():
    c, p = new_doc("signatures", "06-by-label.pdf")
    y = header(c, "Corporate Authorization")
    y = para(c, y, ["ACME CORP, INC.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "By:")
    y = sig_line(c, y, "Name:")
    y = sig_line(c, y, "Title:")
    y = sig_line(c, y, "Date:")
    c.save()
    return p


def sig_07_witness_signature():
    c, p = new_doc("signatures", "07-witness-signature.pdf")
    y = header(c, "Witnessed Agreement")
    y = para(c, y, ["The undersigned signs in the presence of a witness.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Signatory:")
    y = sig_line(c, y, "Date:")
    y -= LINE_H
    y = sig_line(c, y, "Witness signature:")
    y = sig_line(c, y, "Witness printed name:")
    y = sig_line(c, y, "Witness date:")
    c.save()
    return p


def sig_08_print_and_sign():
    c, p = new_doc("signatures", "08-print-and-sign.pdf")
    y = header(c, "Acceptance")
    y = para(c, y, ["Print and sign your name below.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Printed name:")
    y = sig_line(c, y, "Signature:")
    y = sig_line(c, y, "Date:")
    c.save()
    return p


def sig_09_signature_with_title():
    c, p = new_doc("signatures", "09-signature-with-title.pdf")
    y = header(c, "Officer Acknowledgment")
    y = para(c, y, ["I confirm the above on behalf of the entity I represent.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Signature:")
    y = sig_line(c, y, "Printed name:")
    y = sig_line(c, y, "Title:")
    y = sig_line(c, y, "Entity:")
    y = sig_line(c, y, "Date:")
    c.save()
    return p


def sig_10_electronic_signature():
    c, p = new_doc("signatures", "10-electronic-signature.pdf")
    y = header(c, "Electronic Acknowledgment")
    y = para(c, y, ["By providing an electronic signature below I agree.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Electronic signature:")
    y = sig_line(c, y, "Date signed:")
    c.save()
    return p


# ============================================================
# CATEGORY B: initials/ (10 variants)
# ============================================================

def ini_01_single_initial():
    c, p = new_doc("initials", "01-single-initial.pdf")
    y = header(c, "Acknowledgment")
    y = para(c, y, ["Initial below to confirm receipt.", ""])
    y -= LINE_H * 4
    y = sig_line(c, y, "Initial:", line_width=1.5)
    c.save()
    return p


def ini_02_initials_plural():
    c, p = new_doc("initials", "02-initials-plural.pdf")
    y = header(c, "Joint Acknowledgment")
    y = para(c, y, ["Both parties initial below.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Party A initials:", line_width=1.5)
    y = sig_line(c, y, "Party B initials:", line_width=1.5)
    c.save()
    return p


def ini_03_corner_initial():
    c, p = new_doc("initials", "03-page-corner-initial.pdf")
    y = header(c, "Multi-Page Contract — Page Initial Required")
    y = para(c, y, ["Initial bottom-right of each page.", ""])
    # bottom-right initial line
    c.setFont(*BODY_FONT)
    c.drawString(PAGE_W - 1.5 * inch, 0.7 * inch, "Initial:")
    c.line(PAGE_W - 1 * inch + 30, 0.7 * inch - 2, PAGE_W - 0.5 * inch, 0.7 * inch - 2)
    c.save()
    return p


def ini_04_center_initial():
    c, p = new_doc("initials", "04-page-center-initial.pdf")
    y = header(c, "Multi-Page — Center Initial")
    y = para(c, y, ["Initial center bottom of each page.", ""])
    cx = PAGE_W / 2 - 50
    c.setFont(*BODY_FONT)
    c.drawString(cx, 0.7 * inch, "Initial:")
    c.line(cx + 40, 0.7 * inch - 2, cx + 130, 0.7 * inch - 2)
    c.save()
    return p


def ini_05_margin_per_clause():
    c, p = new_doc("initials", "05-margin-per-clause.pdf")
    y = header(c, "Rental Addendum")
    y = para(c, y, ["Initial each clause in the right margin.", ""])
    y -= LINE_H
    clauses = [
        "Pet policy: dogs under 40 pounds permitted",
        "Smoking: prohibited indoors",
        "Guests: maximum 14 consecutive nights",
        "Parking: assigned space 12 lower lot",
        "Maintenance: 24-hour notice required",
    ]
    for txt in clauses:
        c.drawString(LEFT, y, txt)
        c.line(PAGE_W - 1.5 * inch, y - 2, PAGE_W - 1 * inch, y - 2)
        c.drawString(PAGE_W - 1.5 * inch - 50, y, "Init:")
        y -= LINE_H * 2
    c.save()
    return p


def ini_06_section_initials():
    c, p = new_doc("initials", "06-section-initials.pdf")
    y = header(c, "Sectional Acknowledgment")
    y = para(c, y, ["Initial each section below.", ""])
    y -= LINE_H
    for sec in ["Section 1.", "Section 2.", "Section 3.", "Section 4."]:
        y = sig_line(c, y, f"Initial each section: {sec}", line_width=1.0)
        y -= LINE_H
    c.save()
    return p


def ini_07_parens_initial():
    c, p = new_doc("initials", "07-parens-initial.pdf")
    y = header(c, "Acknowledgment with Parens Initial")
    y = para(c, y, ["Initials in parentheses below.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "(Initial)", line_width=1.5)
    y = sig_line(c, y, "(Initial)", line_width=1.5)
    c.save()
    return p


def ini_08_witness_initials():
    c, p = new_doc("initials", "08-witness-initials.pdf")
    y = header(c, "Witnessed Page")
    y = para(c, y, ["Signer and witness initials on each page.", ""])
    y -= LINE_H * 4
    y = sig_line(c, y, "Signer initials:", line_width=1.0)
    y = sig_line(c, y, "Witness initials:", line_width=1.0)
    c.save()
    return p


def ini_09_both_parties_initial():
    c, p = new_doc("initials", "09-both-parties-initial.pdf")
    y = header(c, "Mutual Initial Block")
    y = para(c, y, ["Each party initials each page.", ""])
    y -= LINE_H * 2
    c.setFont(*BODY_FONT)
    # Side-by-side initial blocks
    c.drawString(LEFT, y, "Buyer initials:")
    c.line(LEFT + 75, y - 2, LEFT + 150, y - 2)
    c.drawString(LEFT + 220, y, "Seller initials:")
    c.line(LEFT + 295, y - 2, LEFT + 370, y - 2)
    c.save()
    return p


def ini_10_header_footer_initials():
    c, p = new_doc("initials", "10-header-footer-initials.pdf")
    y = header(c, "Header and Footer Initial Requirement")
    # Header initial
    c.setFont(*BODY_FONT)
    c.drawString(PAGE_W - 1.5 * inch, PAGE_H - 0.5 * inch, "Init:")
    c.line(PAGE_W - 1.5 * inch + 30, PAGE_H - 0.5 * inch - 2, PAGE_W - 0.5 * inch, PAGE_H - 0.5 * inch - 2)
    # Body
    y = para(c, y, ["Both header and footer require initials.", ""])
    # Footer initial
    c.drawString(LEFT, 0.5 * inch, "Initial:")
    c.line(LEFT + 40, 0.5 * inch - 2, LEFT + 140, 0.5 * inch - 2)
    c.save()
    return p


# ============================================================
# CATEGORY C: dates/ (10 variants)
# ============================================================

def dat_01_date_colon():
    c, p = new_doc("dates", "01-date-colon.pdf")
    y = header(c, "Date Colon")
    y = para(c, y, ["Standard date colon label.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Date:", line_width=2.0)
    c.save()
    return p


def dat_02_dated_this():
    c, p = new_doc("dates", "02-dated-this.pdf")
    y = header(c, "Old-Style Date Phrase")
    y = para(c, y, ["Traditional contract date language.", ""])
    y -= LINE_H * 2
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, y, "Dated this")
    c.line(LEFT + 75, y - 2, LEFT + 75 + 1 * inch, y - 2)
    c.drawString(LEFT + 75 + 1 * inch + 5, y, "day of")
    c.line(LEFT + 75 + 1 * inch + 5 + 40, y - 2, LEFT + 75 + 1 * inch + 5 + 40 + 1.5 * inch, y - 2)
    c.drawString(LEFT + 75 + 1 * inch + 5 + 40 + 1.5 * inch + 5, y, ", 20")
    c.line(LEFT + 75 + 1 * inch + 5 + 40 + 1.5 * inch + 5 + 25, y - 2, LEFT + 75 + 1 * inch + 5 + 40 + 1.5 * inch + 5 + 25 + 30, y - 2)
    c.save()
    return p


def dat_03_mmddyyyy_format():
    c, p = new_doc("dates", "03-mmddyyyy-format.pdf")
    y = header(c, "MM/DD/YYYY Date Field")
    y = para(c, y, ["US date format placeholder.", ""])
    y -= LINE_H * 2
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, y, "Date (MM/DD/YYYY):")
    c.line(LEFT + 130, y - 2, LEFT + 130 + 1.5 * inch, y - 2)
    c.save()
    return p


def dat_04_effective_date():
    c, p = new_doc("dates", "04-effective-date.pdf")
    y = header(c, "Effective Date")
    y = para(c, y, ["When does the contract take effect?", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Effective Date:", line_width=2.0)
    c.save()
    return p


def dat_05_execution_date():
    c, p = new_doc("dates", "05-execution-date.pdf")
    y = header(c, "Execution Date Block")
    y = para(c, y, ["Date the contract was signed.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Date of execution:", line_width=2.0)
    c.save()
    return p


def dat_06_todays_date():
    c, p = new_doc("dates", "06-todays-date.pdf")
    y = header(c, "Today's Date")
    y = para(c, y, ["Current date placeholder.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Today's date:", line_width=2.0)
    c.save()
    return p


def dat_07_as_of_date():
    c, p = new_doc("dates", "07-as-of-date.pdf")
    y = header(c, "As-Of Date")
    y = para(c, y, ["Effective-as-of placeholder.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "As of:", line_width=2.0)
    c.save()
    return p


def dat_08_date_signed():
    c, p = new_doc("dates", "08-date-signed.pdf")
    y = header(c, "Date Signed")
    y = para(c, y, ["Date the document was signed.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Date signed:", line_width=2.0)
    c.save()
    return p


def dat_09_european_format():
    c, p = new_doc("dates", "09-european-format.pdf")
    y = header(c, "European Date Format")
    y = para(c, y, ["DD/MM/YYYY format used in EU.", ""])
    y -= LINE_H * 2
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, y, "Date (DD/MM/YYYY):")
    c.line(LEFT + 130, y - 2, LEFT + 130 + 1.5 * inch, y - 2)
    c.save()
    return p


def dat_10_iso_format():
    c, p = new_doc("dates", "10-iso-format.pdf")
    y = header(c, "ISO 8601 Date Format")
    y = para(c, y, ["YYYY-MM-DD international standard.", ""])
    y -= LINE_H * 2
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, y, "Date (YYYY-MM-DD):")
    c.line(LEFT + 130, y - 2, LEFT + 130 + 1.5 * inch, y - 2)
    c.save()
    return p


# ============================================================
# CATEGORY D: checkboxes/ (10 variants)
# ============================================================

def cb_01_empty_square():
    c, p = new_doc("checkboxes", "01-empty-square.pdf")
    y = header(c, "Standard Acknowledgment")
    y = para(c, y, ["Check each statement to acknowledge.", ""])
    y -= LINE_H
    for label in ["I have read the terms.", "I agree to the policy.", "I authorize charges."]:
        y = checkbox(c, y, label)
    c.save()
    return p


def cb_02_parens_yes_no():
    c, p = new_doc("checkboxes", "02-parens-yes-no.pdf")
    y = header(c, "Parens Yes/No")
    y = para(c, y, ["Mark the appropriate option.", ""])
    y -= LINE_H
    questions = [
        "Are you a US citizen?", "Have you reviewed Section 5?", "Will you be paid by direct deposit?",
    ]
    c.setFont(*BODY_FONT)
    for q in questions:
        c.drawString(LEFT, y, q)
        c.drawString(LEFT + 3 * inch, y, "( ) Yes   ( ) No")
        y -= LINE_H * 2
    c.save()
    return p


def cb_03_square_brackets():
    c, p = new_doc("checkboxes", "03-square-brackets.pdf")
    y = header(c, "Bracket Checkboxes")
    y = para(c, y, ["Check brackets to confirm.", ""])
    y -= LINE_H
    c.setFont(*BODY_FONT)
    for label in ["[ ] I confirm my contact information.", "[ ] I authorize the disclosure.", "[ ] I consent to electronic delivery."]:
        c.drawString(LEFT, y, label)
        y -= LINE_H
    c.save()
    return p


def cb_04_circle_radio():
    c, p = new_doc("checkboxes", "04-circle-radio.pdf")
    y = header(c, "Radio Buttons (Single Choice)")
    y = para(c, y, ["Pick one option below.", ""])
    y -= LINE_H
    c.setFont(*BODY_FONT)
    for label in ["Monthly billing", "Quarterly billing", "Annual billing"]:
        c.circle(LEFT + 5, y + 2, 5)
        c.drawString(LEFT + 18, y, label)
        y -= LINE_H * 1.5
    c.save()
    return p


def cb_05_pre_checked():
    c, p = new_doc("checkboxes", "05-pre-checked.pdf")
    y = header(c, "Pre-Filled Acknowledgment")
    y = para(c, y, ["The default selections appear below.", ""])
    y -= LINE_H
    y = checkbox(c, y, "I have read the terms (pre-checked default)", prefilled=True)
    y = checkbox(c, y, "I want marketing emails", prefilled=False)
    y = checkbox(c, y, "I accept the privacy policy", prefilled=True)
    c.save()
    return p


def cb_06_multi_choice_column():
    c, p = new_doc("checkboxes", "06-multi-choice-column.pdf")
    y = header(c, "Multiple Choice Column")
    y = para(c, y, ["Select all that apply.", ""])
    y -= LINE_H
    for label in ["Bug report", "Feature request", "Billing question", "Account help", "Other"]:
        y = checkbox(c, y, label)
    c.save()
    return p


def cb_07_agree_disagree():
    c, p = new_doc("checkboxes", "07-agree-disagree.pdf")
    y = header(c, "Agree/Disagree Pair")
    y = para(c, y, ["Mark agreement on each statement.", ""])
    y -= LINE_H
    c.setFont(*BODY_FONT)
    for q in ["Project scope is clear.", "Timeline is acceptable.", "Fee structure is fair."]:
        c.drawString(LEFT, y, q)
        c.drawString(LEFT + 3.5 * inch, y, "[ ] Agree    [ ] Disagree")
        y -= LINE_H * 2
    c.save()
    return p


def cb_08_acknowledge_each():
    c, p = new_doc("checkboxes", "08-acknowledge-each.pdf")
    y = header(c, "Acknowledge Each Item")
    y = para(c, y, ["Check each acknowledgment.", ""])
    y -= LINE_H
    items = [
        "I have read the employee handbook.",
        "I understand the code of conduct.",
        "I agree to the at-will employment terms.",
        "I have completed safety training.",
        "I have set up direct deposit.",
        "I have reviewed the benefits guide.",
        "I have completed the privacy training.",
    ]
    for label in items:
        y = checkbox(c, y, label)
    c.save()
    return p


def cb_09_large_boxes():
    c, p = new_doc("checkboxes", "09-large-boxes.pdf")
    y = header(c, "Large-Format Boxes")
    y = para(c, y, ["Larger boxes for accessible review.", ""])
    y -= LINE_H * 2
    for label in ["I confirm receipt.", "I accept the terms.", "I authorize the action."]:
        y = checkbox(c, y, label, box_size=18)
        y -= LINE_H
    c.save()
    return p


def cb_10_checkbox_table():
    c, p = new_doc("checkboxes", "10-checkbox-table.pdf")
    y = header(c, "Tabular Checkbox Grid")
    y = para(c, y, ["Mark cells where applicable.", ""])
    y -= LINE_H * 2
    c.setFont("Helvetica-Bold", 10)
    # Header row
    cells = ["Module", "Required", "Completed", "Verified"]
    col_w = 1.2 * inch
    for i, h in enumerate(cells):
        c.drawString(LEFT + i * col_w, y, h)
    y -= LINE_H
    c.setFont(*BODY_FONT)
    # Data rows
    rows = ["Safety", "Compliance", "Security", "Privacy"]
    for r in rows:
        c.drawString(LEFT, y, r)
        for i in range(1, 4):
            c.rect(LEFT + i * col_w + 10, y - 2, 12, 12)
        y -= LINE_H * 1.5
    c.save()
    return p


# ============================================================
# CATEGORY E: text-fields/ (10 variants)
# ============================================================

def tx_01_name_field():
    c, p = new_doc("text-fields", "01-name-field.pdf")
    y = header(c, "Name Capture")
    y = para(c, y, ["Enter your full legal name.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "First name:", line_width=2.5)
    y = sig_line(c, y, "Last name:", line_width=2.5)
    c.save()
    return p


def tx_02_address_multiline():
    c, p = new_doc("text-fields", "02-address-multiline.pdf")
    y = header(c, "Mailing Address")
    y = para(c, y, ["Provide complete mailing address.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Street address:", line_width=3.5)
    y = sig_line(c, y, "Apartment/unit:", line_width=1.5)
    y = sig_line(c, y, "City:", line_width=2.5)
    y = sig_line(c, y, "State:", line_width=0.5)
    y = sig_line(c, y, "ZIP:", line_width=0.8)
    c.save()
    return p


def tx_03_phone():
    c, p = new_doc("text-fields", "03-phone.pdf")
    y = header(c, "Contact Numbers")
    y = para(c, y, ["Phone numbers for reachback.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Primary phone:", line_width=2.0)
    y = sig_line(c, y, "Mobile phone:", line_width=2.0)
    y = sig_line(c, y, "Work phone:", line_width=2.0)
    c.save()
    return p


def tx_04_email():
    c, p = new_doc("text-fields", "04-email.pdf")
    y = header(c, "Email Capture")
    y = para(c, y, ["Provide email for electronic delivery.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Email:", line_width=3.5)
    y = sig_line(c, y, "Confirm email:", line_width=3.5)
    c.save()
    return p


def tx_05_ssn():
    c, p = new_doc("text-fields", "05-ssn.pdf")
    y = header(c, "Taxpayer Identification")
    y = para(c, y, ["For 1099/W-9 reporting.", ""])
    y -= LINE_H * 2
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, y, "SSN (XXX-XX-XXXX):")
    c.line(LEFT + 130, y - 2, LEFT + 130 + 2 * inch, y - 2)
    y -= LINE_H * 2
    c.drawString(LEFT, y, "EIN (XX-XXXXXXX):")
    c.line(LEFT + 130, y - 2, LEFT + 130 + 2 * inch, y - 2)
    c.save()
    return p


def tx_06_amount():
    c, p = new_doc("text-fields", "06-amount.pdf")
    y = header(c, "Payment Amount")
    y = para(c, y, ["Amounts to be paid under this agreement.", ""])
    y -= LINE_H * 2
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, y, "Total amount: $")
    c.line(LEFT + 100, y - 2, LEFT + 100 + 2 * inch, y - 2)
    y -= LINE_H * 2
    c.drawString(LEFT, y, "Deposit amount: $")
    c.line(LEFT + 105, y - 2, LEFT + 105 + 2 * inch, y - 2)
    c.save()
    return p


def tx_07_company():
    c, p = new_doc("text-fields", "07-company.pdf")
    y = header(c, "Company Information")
    y = para(c, y, ["Entity details.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Company:", line_width=3.5)
    y = sig_line(c, y, "DBA:", line_width=3.0)
    y = sig_line(c, y, "State of incorporation:", line_width=1.5)
    c.save()
    return p


def tx_08_title_role():
    c, p = new_doc("text-fields", "08-title-role.pdf")
    y = header(c, "Title and Role")
    y = para(c, y, ["Your position with the entity.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Title:", line_width=3.0)
    y = sig_line(c, y, "Role:", line_width=3.0)
    y = sig_line(c, y, "Department:", line_width=3.0)
    c.save()
    return p


def tx_09_comments_long():
    c, p = new_doc("text-fields", "09-comments-long.pdf")
    y = header(c, "Open Comments")
    y = para(c, y, ["Provide additional context. Multi-line.", ""])
    y -= LINE_H * 2
    # Multi-line text box
    c.rect(LEFT, y - 100, PAGE_W - 2 * inch, 100)
    c.setFont(*BODY_FONT)
    c.drawString(LEFT + 5, y - 12, "Comments:")
    c.save()
    return p


def tx_10_account_number():
    c, p = new_doc("text-fields", "10-account-number.pdf")
    y = header(c, "Account Capture")
    y = para(c, y, ["For direct deposit setup.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Bank name:", line_width=2.5)
    y = sig_line(c, y, "Routing number:", line_width=2.0)
    y = sig_line(c, y, "Account number:", line_width=2.5)
    y = sig_line(c, y, "Account type:", line_width=1.5)
    c.save()
    return p


# ============================================================
# CATEGORY F: multi-signer/ (10 variants)
# ============================================================

def ms_01_two_parties_side_by_side():
    c, p = new_doc("multi-signer", "01-two-parties-side-by-side.pdf")
    y = header(c, "Mutual NDA — Two Parties")
    y = para(c, y, ["Each party signs in the column for that party.", ""])
    y -= LINE_H * 2
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, y, "Disclosing party:")
    c.drawString(LEFT + 3.5 * inch, y, "Receiving party:")
    y -= LINE_H
    for label in ["Signature:", "Name:", "Title:", "Date:"]:
        c.drawString(LEFT, y, label)
        c.line(LEFT + 60, y - 2, LEFT + 60 + 2.5 * inch, y - 2)
        c.drawString(LEFT + 3.5 * inch, y, label)
        c.line(LEFT + 3.5 * inch + 60, y - 2, LEFT + 3.5 * inch + 60 + 2.5 * inch, y - 2)
        y -= LINE_H * 1.5
    c.save()
    return p


def ms_02_three_parties_stacked():
    c, p = new_doc("multi-signer", "02-three-parties-stacked.pdf")
    y = header(c, "Three-Party Agreement")
    y = para(c, y, ["Each party signs below in sequence.", ""])
    y -= LINE_H
    for party in ["Party A — Consultant:", "Party B — Client:", "Party C — Witness:"]:
        y = para(c, y, [party])
        y = sig_line(c, y, "Signature:")
        y = sig_line(c, y, "Date:")
        y -= LINE_H
    c.save()
    return p


def ms_03_buyer_seller_witness():
    c, p = new_doc("multi-signer", "03-buyer-seller-witness.pdf")
    y = header(c, "Asset Purchase — Buyer, Seller, Witness")
    y = para(c, y, ["Sale closes when all three sign.", ""])
    y -= LINE_H
    for party in ["Buyer:", "Seller:", "Witness:"]:
        y = para(c, y, [party])
        y = sig_line(c, y, "Signature:")
        y = sig_line(c, y, "Printed name:")
        y = sig_line(c, y, "Date:")
        y -= LINE_H
    c.save()
    return p


def ms_04_cofounders_safe():
    c, p = new_doc("multi-signer", "04-cofounders-safe.pdf")
    y = header(c, "SAFE — Co-Founder + Investor")
    y = para(c, y, ["Both co-founders countersign the SAFE.", ""])
    y -= LINE_H
    for party in ["Investor:", "Co-Founder 1 — Company representative:", "Co-Founder 2 — Company representative:"]:
        y = para(c, y, [party])
        y = sig_line(c, y, "Signature:")
        y = sig_line(c, y, "Date:")
        y -= LINE_H
    c.save()
    return p


def ms_05_co_tenants():
    c, p = new_doc("multi-signer", "05-co-tenants.pdf")
    y = header(c, "Residential Lease — Co-Tenants")
    y = para(c, y, ["All tenants and landlord sign below.", ""])
    y -= LINE_H
    for party in ["Tenant 1:", "Tenant 2:", "Tenant 3:", "Landlord:"]:
        y = para(c, y, [party])
        y = sig_line(c, y, "Signature:")
        y = sig_line(c, y, "Date:")
        y -= LINE_H * 0.5
    c.save()
    return p


def ms_06_board_officers():
    c, p = new_doc("multi-signer", "06-board-officers.pdf")
    y = header(c, "Board Resolution — Officer Signatures")
    y = para(c, y, ["Officers sign in their capacities.", ""])
    y -= LINE_H
    for party in ["Chairman of the Board:", "Chief Executive Officer:", "Chief Financial Officer:", "Corporate Secretary:"]:
        y = para(c, y, [party])
        y = sig_line(c, y, "Signature:")
        y = sig_line(c, y, "Date:")
        y -= LINE_H * 0.5
    c.save()
    return p


def ms_07_husband_wife():
    c, p = new_doc("multi-signer", "07-husband-wife.pdf")
    y = header(c, "Joint Filing — Spousal Signatures")
    y = para(c, y, ["Both spouses must sign jointly.", ""])
    y -= LINE_H * 2
    for party in ["Spouse A:", "Spouse B:"]:
        y = para(c, y, [party])
        y = sig_line(c, y, "Signature:")
        y = sig_line(c, y, "Printed name:")
        y = sig_line(c, y, "Date:")
        y -= LINE_H
    c.save()
    return p


def ms_08_employer_employee():
    c, p = new_doc("multi-signer", "08-employer-employee.pdf")
    y = header(c, "Employment Agreement")
    y = para(c, y, ["Employer and employee both sign.", ""])
    y -= LINE_H * 2
    y = para(c, y, ["Employer — Acme Corp, Inc.:"])
    y = sig_line(c, y, "By:")
    y = sig_line(c, y, "Title:")
    y = sig_line(c, y, "Date:")
    y -= LINE_H
    y = para(c, y, ["Employee:"])
    y = sig_line(c, y, "Signature:")
    y = sig_line(c, y, "Printed name:")
    y = sig_line(c, y, "Date:")
    c.save()
    return p


def ms_09_coach_client():
    c, p = new_doc("multi-signer", "09-coach-client.pdf")
    y = header(c, "Coaching Agreement")
    y = para(c, y, ["Coach and client both sign.", ""])
    y -= LINE_H * 2
    for party in ["Coach:", "Client:"]:
        y = para(c, y, [party])
        y = sig_line(c, y, "Signature:")
        y = sig_line(c, y, "Date:")
        y -= LINE_H
    c.save()
    return p


def ms_10_grantor_grantee_witness():
    c, p = new_doc("multi-signer", "10-grantor-grantee-witness.pdf")
    y = header(c, "Real Property Conveyance")
    y = para(c, y, ["Grantor, grantee, and witness sign at closing.", ""])
    y -= LINE_H
    for party in ["Grantor:", "Grantee:", "Witness 1:", "Witness 2:"]:
        y = para(c, y, [party])
        y = sig_line(c, y, "Signature:")
        y = sig_line(c, y, "Date:")
        y -= LINE_H * 0.5
    c.save()
    return p


# ============================================================
# CATEGORY G: acroforms/ (10 variants)
# ============================================================

def af_01_text_field():
    c, p = new_doc("acroforms", "01-text-field.pdf")
    y = header(c, "AcroForm Text Field")
    y = para(c, y, ["Native PDF text input.", ""])
    y -= LINE_H * 2
    c.drawString(LEFT, y, "Full name:")
    pdfform.textFieldRelative(c, "full_name", LEFT + 80, y - 4, 200, 14)
    c.save()
    return p


def af_02_checkbox_field():
    c, p = new_doc("acroforms", "02-checkbox-field.pdf")
    y = header(c, "AcroForm Checkbox")
    y = para(c, y, ["Native PDF checkbox.", ""])
    y -= LINE_H * 2
    c.drawString(LEFT, y, "I agree:")
    pdfform.buttonFieldRelative(c, "agreement", "Off", LEFT + 60, y - 2)
    c.save()
    return p


def af_03_radio_group():
    c, p = new_doc("acroforms", "03-radio-group.pdf")
    y = header(c, "AcroForm Radio Group (Simulated)")
    y = para(c, y, ["Pick one option (simulated as buttons since reportlab radios are limited).", ""])
    y -= LINE_H * 2
    for opt in ["Option A", "Option B", "Option C"]:
        c.drawString(LEFT, y, opt)
        pdfform.buttonFieldRelative(c, opt.lower().replace(' ', '_'), "Off", LEFT + 200, y - 2)
        y -= LINE_H * 2
    c.save()
    return p


def af_04_signature_field():
    c, p = new_doc("acroforms", "04-signature-field.pdf")
    y = header(c, "AcroForm Signature (Simulated as Text)")
    y = para(c, y, ["Signature field rendered as text input.", ""])
    y -= LINE_H * 2
    c.drawString(LEFT, y, "Signature:")
    pdfform.textFieldRelative(c, "signature", LEFT + 80, y - 4, 300, 24)
    c.save()
    return p


def af_05_dropdown_list():
    c, p = new_doc("acroforms", "05-dropdown-list.pdf")
    y = header(c, "AcroForm Choice (Simulated)")
    y = para(c, y, ["Choice field shown as text input.", ""])
    y -= LINE_H * 2
    c.drawString(LEFT, y, "Country:")
    pdfform.textFieldRelative(c, "country", LEFT + 70, y - 4, 200, 14)
    c.save()
    return p


def af_06_listbox():
    c, p = new_doc("acroforms", "06-listbox.pdf")
    y = header(c, "AcroForm Multi-Choice")
    y = para(c, y, ["Multi-line text simulating a listbox.", ""])
    y -= LINE_H * 2
    c.drawString(LEFT, y, "Selected items:")
    pdfform.textFieldRelative(c, "selected", LEFT + 120, y - 60, 200, 60)
    c.save()
    return p


def af_07_button():
    c, p = new_doc("acroforms", "07-button.pdf")
    y = header(c, "AcroForm Reset Button")
    y = para(c, y, ["Form with a non-text button field.", ""])
    y -= LINE_H * 2
    c.drawString(LEFT, y, "Name:")
    pdfform.textFieldRelative(c, "name", LEFT + 60, y - 4, 200, 14)
    y -= LINE_H * 2
    pdfform.buttonFieldRelative(c, "reset", "Off", LEFT, y - 2)
    c.drawString(LEFT + 20, y, "Reset form")
    c.save()
    return p


def af_08_mixed_form():
    c, p = new_doc("acroforms", "08-mixed-form.pdf")
    y = header(c, "Mixed AcroForm")
    y = para(c, y, ["Mix of text, checkbox, signature in one form.", ""])
    y -= LINE_H * 2
    c.drawString(LEFT, y, "Name:")
    pdfform.textFieldRelative(c, "mixed_name", LEFT + 80, y - 4, 200, 14)
    y -= LINE_H * 2
    c.drawString(LEFT, y, "Confirmed:")
    pdfform.buttonFieldRelative(c, "mixed_confirmed", "Off", LEFT + 80, y - 2)
    y -= LINE_H * 2
    c.drawString(LEFT, y, "Date:")
    pdfform.textFieldRelative(c, "mixed_date", LEFT + 80, y - 4, 100, 14)
    y -= LINE_H * 2
    c.drawString(LEFT, y, "Signature:")
    pdfform.textFieldRelative(c, "mixed_sig", LEFT + 80, y - 4, 250, 22)
    c.save()
    return p


def af_09_required_fields():
    c, p = new_doc("acroforms", "09-required-fields.pdf")
    y = header(c, "AcroForm With Required-Style Fields")
    y = para(c, y, ["Asterisk-marked required fields.", ""])
    y -= LINE_H * 2
    for label, key in [("Name*", "req_name"), ("Email*", "req_email"), ("Phone (optional)", "req_phone")]:
        c.drawString(LEFT, y, label + ":")
        pdfform.textFieldRelative(c, key, LEFT + 130, y - 4, 200, 14)
        y -= LINE_H * 2
    c.save()
    return p


def af_10_large_form():
    c, p = new_doc("acroforms", "10-large-form.pdf")
    y = header(c, "Large AcroForm — Many Fields")
    y = para(c, y, ["Comprehensive intake form with many fields.", ""])
    y -= LINE_H * 2
    fields = [
        ("First name:", "lg_first"), ("Last name:", "lg_last"),
        ("Email:", "lg_email"), ("Phone:", "lg_phone"),
        ("Company:", "lg_company"), ("Title:", "lg_title"),
        ("Address line 1:", "lg_addr1"), ("Address line 2:", "lg_addr2"),
        ("City:", "lg_city"), ("State:", "lg_state"), ("ZIP:", "lg_zip"),
    ]
    for label, key in fields:
        c.drawString(LEFT, y, label)
        pdfform.textFieldRelative(c, key, LEFT + 120, y - 4, 200, 12)
        y -= LINE_H * 1.5
    c.save()
    return p


# ============================================================
# CATEGORY H: international/ (10 languages)
# ============================================================

def intl_doc(category, name, title, body_lines, label_pairs):
    """Helper for an international label doc."""
    c, p = new_doc(category, name)
    y = header(c, title)
    y = para(c, y, body_lines + [""])
    y -= LINE_H * 2
    for label in label_pairs:
        c.setFont(*BODY_FONT)
        c.drawString(LEFT, y, label)
        label_w = stringWidth(label, *BODY_FONT)
        c.line(LEFT + label_w + 10, y - 2, LEFT + label_w + 10 + 3 * inch, y - 2)
        y -= LINE_H * 1.5
    c.save()
    return p


def intl_01_spanish():
    return intl_doc(
        "international", "01-spanish.pdf",
        "Acuerdo de Servicios Profesionales",
        ["Las partes firman a continuacion para aceptar.",
         "Cada parte declara haber leido y comprendido los terminos."],
        ["Firma:", "Nombre impreso:", "Cargo:", "Fecha:"],
    )


def intl_02_french():
    return intl_doc(
        "international", "02-french.pdf",
        "Contrat de Prestation de Services",
        ["Les parties signent ci-dessous pour accepter les termes."],
        ["Signature:", "Nom imprime:", "Fonction:", "Date:"],
    )


def intl_03_german():
    return intl_doc(
        "international", "03-german.pdf",
        "Dienstleistungsvertrag",
        ["Die Parteien unterschreiben unten zur Annahme der Bedingungen."],
        ["Unterschrift:", "Name in Druckbuchstaben:", "Funktion:", "Datum:"],
    )


def intl_04_italian():
    return intl_doc(
        "international", "04-italian.pdf",
        "Contratto di Servizi Professionali",
        ["Le parti firmano qui sotto per accettare i termini."],
        ["Firma:", "Nome stampato:", "Posizione:", "Data:"],
    )


def intl_05_portuguese():
    return intl_doc(
        "international", "05-portuguese.pdf",
        "Acordo de Servicos Profissionais",
        ["As partes assinam abaixo para aceitar os termos."],
        ["Assinatura:", "Nome impresso:", "Cargo:", "Data:"],
    )


def intl_06_dutch():
    return intl_doc(
        "international", "06-dutch.pdf",
        "Overeenkomst voor Professionele Diensten",
        ["De partijen ondertekenen hieronder ter aanvaarding."],
        ["Handtekening:", "Naam in blokletters:", "Functie:", "Datum:"],
    )


def intl_07_polish():
    return intl_doc(
        "international", "07-polish.pdf",
        "Umowa o Swiadczenie Uslug",
        ["Strony podpisuja ponizej na znak akceptacji warunkow."],
        ["Podpis:", "Imie i nazwisko:", "Stanowisko:", "Data:"],
    )


def intl_08_russian():
    # Note: Cyrillic in reportlab requires a font that supports it.
    # Helvetica may not render Cyrillic correctly. We use the Latin
    # transliteration as a safe fallback so the file still renders.
    return intl_doc(
        "international", "08-russian-translit.pdf",
        "Soglashenie ob Okazanii Uslug (transliterated)",
        ["Storony podpisyvayut nizhe v znak prinyatiya uslovii."],
        ["Podpis:", "Familiya:", "Dolzhnost:", "Data:"],
    )


def intl_09_japanese_translit():
    # Same caveat re: Japanese rendering.
    return intl_doc(
        "international", "09-japanese-translit.pdf",
        "Service Agreement (Romaji)",
        ["Tojisha ga shomei suru koto de joken o juyo shimasu."],
        ["Shomei:", "Inkan:", "Yakushoku:", "Hizuke:"],
    )


def intl_10_arabic_translit():
    return intl_doc(
        "international", "10-arabic-translit.pdf",
        "Etifaqiya Khedmat (transliterated Arabic)",
        ["Yuwaqi'a al-tarafan adnah li-qabool al-shurout."],
        ["Tawqee':", "Al-ism:", "Al-mansab:", "Al-tarikh:"],
    )


# ============================================================
# CATEGORY I: positioning/ (10 variants)
# ============================================================

def pos_01_top_of_page():
    c, p = new_doc("positioning", "01-top-of-page.pdf")
    # Signature block at top, body below
    y = PAGE_H - 0.7 * inch
    y = sig_line(c, y, "Signature:")
    y = sig_line(c, y, "Date:")
    y -= LINE_H
    y = header(c, "Body Content Below")
    y = para(c, y, ["The signature block is at the very top of the page.", ""])
    c.save()
    return p


def pos_02_bottom_of_page():
    c, p = new_doc("positioning", "02-bottom-of-page.pdf")
    y = header(c, "Body Content Above")
    y = para(c, y, ["The signature block is at the very bottom.", ""])
    # Signature block at bottom
    y = 1 * inch
    y = sig_line(c, y, "Signature:")
    y = sig_line(c, y, "Date:")
    c.save()
    return p


def pos_03_left_margin():
    c, p = new_doc("positioning", "03-left-margin.pdf")
    y = header(c, "Left-Margin Signatures")
    y = para(c, y, ["Signature fields are in the left margin column.", ""])
    y -= LINE_H * 2
    for i in range(5):
        c.setFont(*BODY_FONT)
        # narrow signature line in the left margin
        c.drawString(0.3 * inch, y, "Sig:")
        c.line(0.3 * inch + 25, y - 2, 0.3 * inch + 25 + 80, y - 2)
        # body text on the right
        c.drawString(LEFT + 100, y, f"Section {i+1} content goes to the right.")
        y -= LINE_H * 2
    c.save()
    return p


def pos_04_right_margin():
    c, p = new_doc("positioning", "04-right-margin.pdf")
    y = header(c, "Right-Margin Signatures")
    y = para(c, y, ["Signature fields are in the right margin column.", ""])
    y -= LINE_H * 2
    for i in range(5):
        c.setFont(*BODY_FONT)
        # body text on the left
        c.drawString(LEFT, y, f"Section {i+1} content stays on the left.")
        # signature on the right
        c.drawString(PAGE_W - 1.5 * inch, y, "Sig:")
        c.line(PAGE_W - 1.5 * inch + 25, y - 2, PAGE_W - 0.5 * inch, y - 2)
        y -= LINE_H * 2
    c.save()
    return p


def pos_05_table_cell():
    c, p = new_doc("positioning", "05-table-cell.pdf")
    y = header(c, "Signatures Inside Table Cells")
    y = para(c, y, ["Two columns, each with a signature block.", ""])
    y -= LINE_H * 2
    # Two-column table with signatures inside cells
    cell_w = (PAGE_W - 2 * LEFT) / 2
    cell_h = 100
    for col in range(2):
        x = LEFT + col * cell_w
        c.rect(x, y - cell_h, cell_w, cell_h)
        c.setFont("Helvetica-Bold", 10)
        c.drawString(x + 8, y - 18, ["Party A", "Party B"][col])
        c.setFont(*BODY_FONT)
        c.drawString(x + 8, y - 40, "Signature:")
        c.line(x + 65, y - 42, x + cell_w - 8, y - 42)
        c.drawString(x + 8, y - 65, "Date:")
        c.line(x + 35, y - 67, x + cell_w - 8, y - 67)
    c.save()
    return p


def pos_06_mid_page():
    c, p = new_doc("positioning", "06-mid-page.pdf")
    y = header(c, "Mid-Page Signature")
    y = para(c, y, [
        "Body content before signature.", "Continues for several lines.", "And keeps going.",
        "", "", "",
    ])
    # Mid-page signature
    y = sig_line(c, y, "Signature:")
    y = sig_line(c, y, "Date:")
    y -= LINE_H
    y = para(c, y, ["Body content continues after the signature.", ""])
    c.save()
    return p


def pos_07_header():
    c, p = new_doc("positioning", "07-header.pdf")
    # Signature in header area
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, PAGE_H - 0.5 * inch, "Header signature:")
    c.line(LEFT + 110, PAGE_H - 0.5 * inch - 2, LEFT + 110 + 3 * inch, PAGE_H - 0.5 * inch - 2)
    y = header(c, "Body Begins Below Header")
    y = para(c, y, ["Body content below the header signature.", ""])
    c.save()
    return p


def pos_08_footer():
    c, p = new_doc("positioning", "08-footer.pdf")
    y = header(c, "Footer Signature")
    y = para(c, y, ["Body content above the footer.", ""])
    # Signature in footer
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, 0.4 * inch, "Footer signature:")
    c.line(LEFT + 110, 0.4 * inch - 2, LEFT + 110 + 3 * inch, 0.4 * inch - 2)
    c.save()
    return p


def pos_09_floating_overlay():
    c, p = new_doc("positioning", "09-floating-overlay.pdf")
    y = header(c, "Floating Signature Box")
    y = para(c, y, ["Body content with floating overlay block.", ""])
    # Draw a "floating" signature card with border
    bx, by, bw, bh = LEFT + 1 * inch, PAGE_H - 4 * inch, 3 * inch, 1.5 * inch
    c.rect(bx, by, bw, bh)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(bx + 10, by + bh - 18, "Sign here")
    c.setFont(*BODY_FONT)
    c.drawString(bx + 10, by + 50, "Signature:")
    c.line(bx + 70, by + 48, bx + bw - 10, by + 48)
    c.drawString(bx + 10, by + 20, "Date:")
    c.line(bx + 40, by + 18, bx + bw - 10, by + 18)
    c.save()
    return p


def pos_10_near_page_break():
    c, p = new_doc("positioning", "10-near-page-break.pdf")
    y = header(c, "Page 1 — Signature Spans Page Break")
    y = para(c, y, ["Signature partway down page 1, continues on page 2.", ""])
    y -= LINE_H * 25
    y = sig_line(c, y, "Signature:")
    c.showPage()
    y = header(c, "Page 2 — Continuation")
    y = sig_line(c, y, "Date:")
    c.save()
    return p


# ============================================================
# CATEGORY J: adversarial/ (10 decoy cases)
# ============================================================

def adv_01_signature_in_body():
    c, p = new_doc("adversarial", "01-signature-in-body-text.pdf")
    y = header(c, "Adversarial — Signature Word in Body")
    y = para(c, y, [
        "The word Signature appears in this paragraph as part",
        "of the narrative description, not as a label for a field.",
        "Detector should NOT tag this as a signature field.",
        "",
        "The real signature block is below.",
    ])
    y -= LINE_H * 2
    y = sig_line(c, y, "Signature:")
    c.save()
    return p


def adv_02_date_in_clause():
    c, p = new_doc("adversarial", "02-date-in-clause.pdf")
    y = header(c, "Adversarial — Date Word in Clauses")
    y = para(c, y, [
        "The Effective Date and the Termination Date are determined",
        "as described in Section 4. The Date of execution will be",
        "the date appearing on the final signature page.",
        "",
        "Only ONE date field exists below.",
    ])
    y -= LINE_H * 2
    y = sig_line(c, y, "Date:", line_width=2.0)
    c.save()
    return p


def adv_03_fake_checkboxes():
    c, p = new_doc("adversarial", "03-fake-checkboxes.pdf")
    y = header(c, "Adversarial — Decorative Box Bullets")
    y = para(c, y, ["The boxes below are decorative bullets, not checkboxes.", ""])
    y -= LINE_H
    c.setFont(*BODY_FONT)
    for label in ["Bullet point one", "Bullet point two", "Bullet point three"]:
        c.rect(LEFT, y - 2, 10, 10, fill=1)  # filled — clearly decorative
        c.drawString(LEFT + 18, y, label)
        y -= LINE_H
    y -= LINE_H
    y = para(c, y, ["Real signature below."])
    y = sig_line(c, y, "Signature:")
    c.save()
    return p


def adv_04_horizontal_rule():
    c, p = new_doc("adversarial", "04-horizontal-rule.pdf")
    y = header(c, "Adversarial — Horizontal Rule Decoy")
    y = para(c, y, ["The rule below is a section divider, not a signature line.", ""])
    y -= LINE_H
    # Full-width horizontal rule
    c.line(LEFT, y, PAGE_W - LEFT, y)
    y -= LINE_H * 2
    y = para(c, y, ["Real signature block below."])
    y = sig_line(c, y, "Signature:")
    c.save()
    return p


def adv_05_toc_dotted_leaders():
    c, p = new_doc("adversarial", "05-toc-dotted-leaders.pdf")
    y = header(c, "Adversarial — Table of Contents")
    y = para(c, y, ["The dotted leaders below are TOC, not blank lines.", ""])
    y -= LINE_H
    sections = [("Section 1. Definitions", "3"), ("Section 2. Services", "5"), ("Section 3. Payment", "8")]
    for title, page in sections:
        c.drawString(LEFT, y, title)
        # dotted leader
        dot_x = LEFT + stringWidth(title, *BODY_FONT) + 10
        while dot_x < PAGE_W - 1 * inch:
            c.drawString(dot_x, y, ".")
            dot_x += 4
        c.drawString(PAGE_W - 0.7 * inch, y, page)
        y -= LINE_H * 1.5
    y -= LINE_H
    y = para(c, y, ["Real signature below."])
    y = sig_line(c, y, "Signature:")
    c.save()
    return p


def adv_06_page_number_line():
    c, p = new_doc("adversarial", "06-page-number-line.pdf")
    y = header(c, "Adversarial — Page Number Underline")
    y = para(c, y, ["Page number underline at bottom, not a signature line.", ""])
    y -= LINE_H * 2
    y = sig_line(c, y, "Signature:")
    # Page-number footer underline
    c.line(PAGE_W / 2 - 30, 0.7 * inch, PAGE_W / 2 + 30, 0.7 * inch)
    c.setFont(*BODY_FONT)
    c.drawCentredString(PAGE_W / 2, 0.5 * inch, "1 of 1")
    c.save()
    return p


def adv_07_quote_block_frame():
    c, p = new_doc("adversarial", "07-quote-block-frame.pdf")
    y = header(c, "Adversarial — Decorative Quote Frame")
    y = para(c, y, ["The frame below is a stylized quote, not a signature box.", ""])
    y -= LINE_H
    # Decorative frame with text inside
    fx, fy, fw, fh = LEFT, y - 60, 5 * inch, 60
    c.rect(fx, fy, fw, fh)
    c.setFont("Helvetica-Oblique", 11)
    c.drawString(fx + 10, fy + fh - 18, "An ounce of prevention is worth")
    c.drawString(fx + 10, fy + fh - 32, "a pound of cure. — Benjamin Franklin")
    c.setFont(*BODY_FONT)
    y -= 70
    y = para(c, y, ["Real signature below."])
    y = sig_line(c, y, "Signature:")
    c.save()
    return p


def adv_08_list_bullets_as_checkbox():
    c, p = new_doc("adversarial", "08-list-bullets-as-checkbox.pdf")
    y = header(c, "Adversarial — Bullets That Look Like Checkboxes")
    y = para(c, y, ["The hollow circles are bullets, not radio buttons.", ""])
    y -= LINE_H
    c.setFont(*BODY_FONT)
    for label in ["Decorative bullet one", "Decorative bullet two", "Decorative bullet three"]:
        c.circle(LEFT + 5, y + 2, 3)
        c.drawString(LEFT + 18, y, label)
        y -= LINE_H
    y -= LINE_H
    y = sig_line(c, y, "Signature:")
    c.save()
    return p


def adv_09_footnote_line():
    c, p = new_doc("adversarial", "09-footnote-line.pdf")
    y = header(c, "Adversarial — Footnote Separator Line")
    y = para(c, y, ["Footnote separator at bottom, not a signature line.", ""])
    y -= LINE_H * 3
    y = sig_line(c, y, "Signature:")
    # Footnote separator
    c.line(LEFT, 1.2 * inch, LEFT + 2 * inch, 1.2 * inch)
    c.setFont("Helvetica", 8)
    c.drawString(LEFT, 1.0 * inch, "1. Footnote text appears below the separator line.")
    c.save()
    return p


def adv_10_already_signed():
    c, p = new_doc("adversarial", "10-already-signed.pdf")
    y = header(c, "Adversarial — Looks Pre-Signed")
    y = para(c, y, ["A cursive squiggle is on the line below, looking like a signature.", ""])
    y -= LINE_H * 2
    # Draw a fake cursive signature (just decorative curves)
    c.setStrokeColorRGB(0.1, 0.1, 0.4)
    c.setLineWidth(1.2)
    c.bezier(LEFT + 5, y, LEFT + 30, y + 12, LEFT + 60, y - 8, LEFT + 90, y + 5)
    c.bezier(LEFT + 90, y + 5, LEFT + 120, y + 12, LEFT + 150, y - 6, LEFT + 180, y + 3)
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(1)
    c.line(LEFT, y - 8, LEFT + 4 * inch, y - 8)
    c.setFont(*BODY_FONT)
    c.drawString(LEFT, y - 22, "Signature:")
    y -= LINE_H * 3
    y = para(c, y, ["The squiggle above is decorative — the real expected", "signature would be added by the actual signer."])
    c.save()
    return p


# ============================================================
# Main: collect all generators by category
# ============================================================

CATEGORIES = {
    "signatures": [
        sig_01_signature_colon, sig_02_sign_here, sig_03_slash_s, sig_04_x_marker, sig_05_authorize_label,
        sig_06_by_label, sig_07_witness_signature, sig_08_print_and_sign, sig_09_signature_with_title, sig_10_electronic_signature,
    ],
    "initials": [
        ini_01_single_initial, ini_02_initials_plural, ini_03_corner_initial, ini_04_center_initial, ini_05_margin_per_clause,
        ini_06_section_initials, ini_07_parens_initial, ini_08_witness_initials, ini_09_both_parties_initial, ini_10_header_footer_initials,
    ],
    "dates": [
        dat_01_date_colon, dat_02_dated_this, dat_03_mmddyyyy_format, dat_04_effective_date, dat_05_execution_date,
        dat_06_todays_date, dat_07_as_of_date, dat_08_date_signed, dat_09_european_format, dat_10_iso_format,
    ],
    "checkboxes": [
        cb_01_empty_square, cb_02_parens_yes_no, cb_03_square_brackets, cb_04_circle_radio, cb_05_pre_checked,
        cb_06_multi_choice_column, cb_07_agree_disagree, cb_08_acknowledge_each, cb_09_large_boxes, cb_10_checkbox_table,
    ],
    "text-fields": [
        tx_01_name_field, tx_02_address_multiline, tx_03_phone, tx_04_email, tx_05_ssn,
        tx_06_amount, tx_07_company, tx_08_title_role, tx_09_comments_long, tx_10_account_number,
    ],
    "multi-signer": [
        ms_01_two_parties_side_by_side, ms_02_three_parties_stacked, ms_03_buyer_seller_witness, ms_04_cofounders_safe, ms_05_co_tenants,
        ms_06_board_officers, ms_07_husband_wife, ms_08_employer_employee, ms_09_coach_client, ms_10_grantor_grantee_witness,
    ],
    "acroforms": [
        af_01_text_field, af_02_checkbox_field, af_03_radio_group, af_04_signature_field, af_05_dropdown_list,
        af_06_listbox, af_07_button, af_08_mixed_form, af_09_required_fields, af_10_large_form,
    ],
    "international": [
        intl_01_spanish, intl_02_french, intl_03_german, intl_04_italian, intl_05_portuguese,
        intl_06_dutch, intl_07_polish, intl_08_russian, intl_09_japanese_translit, intl_10_arabic_translit,
    ],
    "positioning": [
        pos_01_top_of_page, pos_02_bottom_of_page, pos_03_left_margin, pos_04_right_margin, pos_05_table_cell,
        pos_06_mid_page, pos_07_header, pos_08_footer, pos_09_floating_overlay, pos_10_near_page_break,
    ],
    "adversarial": [
        adv_01_signature_in_body, adv_02_date_in_clause, adv_03_fake_checkboxes, adv_04_horizontal_rule, adv_05_toc_dotted_leaders,
        adv_06_page_number_line, adv_07_quote_block_frame, adv_08_list_bullets_as_checkbox, adv_09_footnote_line, adv_10_already_signed,
    ],
}


def main():
    total = 0
    for category, generators in CATEGORIES.items():
        print(f"  {category}/")
        for gen in generators:
            path = gen()
            print(f"    wrote {path.name}")
            total += 1
    print(f"Generated {total} comprehensive synthetic PDFs across {len(CATEGORIES)} categories.")


if __name__ == "__main__":
    main()
