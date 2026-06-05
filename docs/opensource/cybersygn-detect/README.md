# cybersygn-detect

Heuristic detection of signature fields in PDFs. The same engine that
powers [CyberSygn](https://cybersygn.io). MIT-licensed, zero
dependencies, runs in the browser or in a Cloudflare Worker.

Given a PDF (or extracted text plus geometry), it returns an array of
detected fields:

```
[
  { type: 'signature', page: 1, x: 72, y: 96, width: 220, height: 28, label: 'Client signature' },
  { type: 'date',      page: 1, x: 320, y: 96, width: 100, height: 28, label: 'Date' },
  { type: 'initial',   page: 2, x: 500, y: 740, width: 40,  height: 24, label: 'Initials' },
  ...
]
```

## What it detects

| Type | Patterns matched |
|---|---|
| `signature` | `Signature:`, `Signed:`, `/s/`, "X" prefix, underscore runs of width > 200, named blocks like "Client signature", "Authorized signature" |
| `initial`   | `(Initial)`, `(Init.)`, "Initial:", small underscore boxes in margins |
| `date`      | `Date:`, `MM/DD/YYYY`, `_____ / _____ / _____`, narrow underscores adjacent to date labels |
| `checkbox`  | `[ ]`, `□`, `☐`, small empty squares |
| `text`      | Generic underscore runs that don't match the above |

Detection is heuristic, not ML. It runs on the PDF's actual text +
geometry, not on rasterized pixels — fast (about 50 ms for a 5-page
contract on a Cloudflare Worker), deterministic, no API calls.

## Install

```
npm install cybersygn-detect
```

## Use (browser)

```js
import { detectFields } from 'cybersygn-detect';
import * as pdfjsLib from 'pdfjs-dist';

const pdfBytes = await file.arrayBuffer();
const fields = await detectFields(pdfBytes, { pdfjs: pdfjsLib });

for (const f of fields) {
  console.log(f.type, 'at', f.x, f.y, 'on page', f.page);
}
```

## Use (Cloudflare Worker)

```js
import { detectFields } from 'cybersygn-detect';

export default {
  async fetch(request) {
    const bytes = await request.arrayBuffer();
    const fields = await detectFields(bytes);
    return Response.json(fields);
  }
};
```

## Use (Node)

```js
import { detectFields } from 'cybersygn-detect';
import { readFile } from 'node:fs/promises';

const bytes = await readFile('./contract.pdf');
const fields = await detectFields(bytes);
console.log(fields);
```

## Accuracy

100% on the maintained regression set of 37 real-world contracts and
10 synthetic test PDFs. Test suite + corpus ships in `test/`.

## What this isn't

- Not an OCR engine. Scanned-image PDFs need OCR before detection.
- Not a fillable-form parser. AcroForm fields are detected, but
  detection here is primarily for unstructured signing surfaces.
- Not a signing service. For full e-signature flows with audit
  certificates and magic-link delivery, use [CyberSygn](https://cybersygn.io).

## License

MIT. See `LICENSE`.

## Background

CyberSygn was built solo by Nathan Vogt in Parker, Colorado. The
detection engine is extracted here as a way of giving back to the
indie developer community. Issues, PRs, and forks welcome.

If you ship a product on top of this, drop a line:
nathan@cybersygn.io.
