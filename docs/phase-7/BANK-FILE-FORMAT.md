# Bank-file format: EstatePro CSV v1

The format for importing receipts from a bank statement (Phase 7 L3, P7-D7; wireframe RP-3).

## The file

- **Encoding:** UTF-8 text (a byte-order mark is allowed). No other control characters than tab and line breaks: a file that is not plain text fails the security check.
- **Separator:** comma. Fields with commas, quotes or line breaks are quoted (RFC 4180); a quote inside a quoted field is doubled.
- **Size:** at most 5 MB and 5,000 lines.
- **Upload:** as a document of the bank account, type "Bank statement file" (`bank_statement`), content type `text/csv`. The file is scanned before it can be imported, and kept with the account.

## The header row

One header row names the columns, in any order and any case:

| Column | Required | Content |
|---|---|---|
| `date` | Yes | The day the money arrived, `YYYY-MM-DD` |
| `amount` | Yes | A positive amount with a full stop and no thousands separators, at most four decimals: `6000.00` |
| `currency` | Yes | The ISO code, which must be the bank account's: `GHS` |
| `reference` | Yes | The payment reference the payer gave (may be empty) |
| `description` | No | The bank's description of the line |
| `transaction_id` | No | The bank's own identifier for the line, when the statement has one |

Other columns are ignored.

## Example

```csv
date,amount,currency,reference,description,transaction_id
2026-02-02,6000.00,GHS,LSE-2026-000031,Rent February,FT26033ABC
2026-02-02,1200.00,GHS,JAN RENT FLAT2,"Transfer, from ""Kofi""",FT26033ABD
```

## What happens to each line

| Outcome | When |
|---|---|
| **Matched** | The reference or description names exactly one lease (e.g. `LSE-2026-000031`) that is signed and in the account's currency: the payer is its primary tenant |
| **Unmatched** | No lease, or more than one, is named: a person chooses the payer when committing, or the line waits in the queue until matched |
| **Duplicate** | The line was imported, or is waiting in the queue, already (any file): skipped |
| **Error** | Wrong number of fields, a date that is not real, an amount that is not positive, or a currency that is not the account's: not imported |

A line's identity is the bank's `transaction_id` when the file has one; otherwise its date, amount, currency, reference and description, with its position among identical lines of the same file. Importing the same file again therefore adds nothing.

Committing creates one **cleared** receipt per matched or chosen line, by bank transfer into the account, dated the line's date. Nothing is allocated by an import: allocation is confirmed by a person (P7-D8).
