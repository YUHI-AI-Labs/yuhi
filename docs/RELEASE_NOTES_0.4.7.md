# Yuhi v0.4.7 — Document/PDF privacy pipeline

Document companions (PDF/DOCX/PPTX) now go through the same de-identification
taxonomy, registry, and independent verification 0.4.6 established for tabular data.
Previously (issue #21), a document companion's pseudonymizer only understood
delimited tables — extracted prose threw, the catch silently returned an empty
forbidden list, and the companion published completely unmasked while labelled
"Verified".

## What changed

- A personal name backed by a matching business key (student id, employee id, …)
  present in the SAME document reuses the exact token a table in the same run already
  minted for that person. A name with no such key mints its own token instead of
  merging onto an unrelated entity.
- Every direct identifier and CJK name-shaped candidate the detector recognizes is
  masked before delivery. Operational identifiers (student id, course code, …) are
  preserved, exactly as in CSV/XLSX.
- Independent, structurally-separate verification runs before publish.

## Known limitations

- Name detection covers 2–4 character CJK sequences only. A single-character, 5+
  character, or non-CJK (Latin-script) personal name is not detected.
- The private pseudonym registry stores matchable (not one-way-hashed) values,
  required for substring matching against document text; it is protected by file
  location and permissions (`.internal/`, private, never agent-visible), not by
  encryption.

Full design record and the permitted/prohibited claims for this feature:
`docs/design/0.4.7_document_privacy.md`.

## Not claimed

Document Privacy does not remove all personal information from a document, does not
detect every personal name, and does not guarantee full anonymization.
