#!/usr/bin/env python3
"""ocr_batch.py — Push 0 of the ELJ Document Sift (docs/SPEC_Document_Sift.md).

Gives every PDF in a discovery set a text layer, on your own machine, before
ELJ sees any of it. Nothing here talks to ELJ, to Supabase or to the network;
it is a local pre-processing step, and the reason it is local is that sending
several thousand page images to a server is the transfer and storage cost the
whole Sift design exists to avoid.

What it does
------------
Walks an input tree for PDFs, runs each one through `ocrmypdf --skip-text`, and
writes the result into an output tree under the same relative path. Native PDFs
keep the text their producer gave them; only scanned pages are OCR'd. The
originals are opened read-only and are never written to.

Why it is safe to stop
----------------------
A set of several thousand files is an overnight run, possibly two. The script
skips any file whose output already exists and is no older than its input, so
Ctrl-C and re-run picks up where it left off. Progress lives in the output
tree, not in the log, so a lost log costs nothing.

The log
-------
`ocr_log.csv` is appended row by row and flushed after each one, because a
crash at file 3,000 must not take the record of the first 2,999 with it. Each
row carries the script version and the options it ran under: if a document's
text is ever questioned, the log says what produced it.

Outcomes: `native` (had text, passed straight through), `ocred`, `skipped`
(already done on an earlier run), `low_confidence` (OCR'd, but the text does
not read as language — see `assess_text`), `encrypted`, `failed`.

Usage
-----
    python3 ocr_batch.py
    python3 ocr_batch.py --input ~/Discovery/raw --output ~/Discovery/ocr
    python3 ocr_batch.py --rotate-pages --deskew

Requires `ocrmypdf` on the PATH:  brew install ocrmypdf
"""

from __future__ import annotations

import argparse
import csv
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SCRIPT_VERSION = "1.0"

LOG_COLUMNS = [
    "relative_path",
    "outcome",
    "pages",
    "characters",
    "seconds",
    "output_bytes",
    "script_version",
    "options",
    "message",
]

# ocrmypdf's documented exit codes. Only the ones we act on are named; anything
# else is reported as a plain failure with ocrmypdf's own message attached,
# which is more use than a guess at what an unfamiliar code meant.
EXIT_OK = 0
EXIT_INPUT_FILE = 2
EXIT_MISSING_DEPENDENCY = 3
EXIT_INVALID_OUTPUT_PDF = 4
EXIT_FILE_ACCESS = 5
EXIT_ENCRYPTED_PDF = 8
EXIT_CTRL_C = 130

# Thresholds for the "does this read as language" check. They are deliberately
# crude: the job is to produce a short list worth eyeballing, not to judge a
# document. Erring towards flagging is right — a false flag costs a glance, a
# missed one means a document is silently absent from the sift.
MIN_CHARS_TO_ASSESS = 200     # below this there is nothing to judge
MIN_CHARS_PER_PAGE = 50       # an OCR'd page yielding less than this read badly
MIN_ALPHA_RATIO = 0.65        # English prose sits well above this
MIN_MEAN_WORD_LENGTH = 3.0    # gibberish fragments average far shorter

# A sidecar line that is nothing but a bracketed note is ocrmypdf's own marker
# (e.g. a skipped page), not document text.
MARKER_LINE = re.compile(r"^\s*\[[^\]]*\]\s*$")
WORD = re.compile(r"[A-Za-z]+")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Give every PDF in a discovery set a text layer, locally.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--input", type=Path, default=Path.home() / "Discovery" / "raw",
        help="Folder to read PDFs from (default: ~/Discovery/raw). Copy the USB "
             "here first; running against the USB is slow and risks the set if "
             "the drive disconnects.",
    )
    parser.add_argument(
        "--output", type=Path, default=Path.home() / "Discovery" / "ocr",
        help="Folder to write processed PDFs to (default: ~/Discovery/ocr).",
    )
    parser.add_argument(
        "--log", type=Path, default=None,
        help="Path for the CSV log (default: ocr_log.csv inside the output folder).",
    )
    # Both image corrections are off by default. They help a genuinely crooked
    # or sideways scan and can mildly spoil a page that was already straight,
    # and they rewrite the page image, so the processed copy is no longer a
    # faithful reproduction of the produced document. Decide from the 20-file
    # sample, where a sideways page is obvious at a glance, rather than in
    # advance across several thousand files.
    parser.add_argument(
        "--rotate-pages", action="store_true",
        help="Let ocrmypdf correct pages scanned sideways or upside down. Costs "
             "an extra orientation pass per page.",
    )
    parser.add_argument(
        "--deskew", action="store_true",
        help="Let ocrmypdf straighten slightly tilted pages.",
    )
    parser.add_argument(
        "--timeout", type=int, default=1800,
        help="Seconds to allow one file before giving up on it (default: 1800). "
             "A single pathological PDF must not stall an unattended run.",
    )
    parser.add_argument(
        "--limit", type=int, default=0,
        help="Process at most this many files, then stop. Use it for the 20-file "
             "check before committing to the whole set.",
    )
    return parser.parse_args()


def preflight(args: argparse.Namespace) -> None:
    """Fail now, with something actionable, rather than on the first file."""
    if shutil.which("ocrmypdf") is None:
        sys.exit(
            "ocrmypdf is not on your PATH.\n"
            "  Install it with:  brew install ocrmypdf\n"
            "  (and Homebrew itself from brew.sh, if you have not got it)"
        )
    if not args.input.is_dir():
        sys.exit(f"Input folder does not exist: {args.input}")

    in_resolved = args.input.resolve()
    out_resolved = args.output.resolve()
    if in_resolved == out_resolved:
        sys.exit(
            "Input and output folders are the same. That would write over your "
            "originals, so refusing. Give --output a separate folder."
        )
    if in_resolved in out_resolved.parents:
        # Allowed, but the walk must not pick its own results back up. find_pdfs
        # handles that; say so plainly rather than letting it look like magic.
        print(
            f"Note: the output folder sits inside the input folder. Files already "
            f"written to {args.output} will be left out of the walk.\n"
        )


def find_pdfs(input_dir: Path, output_dir: Path) -> list[Path]:
    """Every PDF under input_dir, in a stable order, excluding our own output."""
    out_resolved = output_dir.resolve()
    found = []
    for path in sorted(input_dir.rglob("*")):
        if not path.is_file() or path.suffix.lower() != ".pdf":
            continue
        resolved = path.resolve()
        if resolved == out_resolved or out_resolved in resolved.parents:
            continue
        found.append(path)
    return found


def already_done(source: Path, target: Path) -> bool:
    """True if a previous run produced this file and the source has not moved on."""
    try:
        if not target.is_file() or target.stat().st_size == 0:
            return False
        return target.stat().st_mtime >= source.stat().st_mtime
    except OSError:
        return False


def read_sidecar(sidecar: Path) -> tuple[str, int]:
    """Return (text ocrmypdf actually read, pages seen).

    The sidecar holds the OCR output, one page per form feed, with a bracketed
    marker standing in for any page ocrmypdf skipped because it already had
    text. Stripping those markers leaves the text OCR came up with — so an
    empty result means every page was native and nothing needed OCR at all.

    Page count is best effort: it comes from the sidecar, so a file that failed
    before producing one reports nothing rather than a guess.
    """
    try:
        raw = sidecar.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "", 0

    pages = raw.split("\f")
    kept = []
    for page in pages:
        lines = [line for line in page.splitlines() if not MARKER_LINE.match(line)]
        kept.append("\n".join(lines))
    return "\n".join(kept).strip(), len([p for p in pages if p.strip()])


def assess_text(text: str, pages: int) -> str | None:
    """Return a reason the OCR text does not read as language, or None.

    Crude on purpose. Two signals, either of which is enough to earn a glance:
    how much of the text is letters at all, and how long its words run. Prose
    sits comfortably above both thresholds; OCR over a page the engine could
    not read — a faint scan, or a script it has no model for — falls below.

    The Tianrui set is being OCR'd in English only, on the footing that every
    Chinese passage carries a translation. This check is what catches it if
    that turns out not to hold for some page: the file is flagged rather than
    scoring near zero in triage and disappearing quietly into `not_relevant`.
    """
    if pages > 0 and len(text) < MIN_CHARS_PER_PAGE * pages:
        return "very little text per page"
    if len(text) < MIN_CHARS_TO_ASSESS:
        return None  # too short to judge; a cover sheet is not a problem

    non_space = [c for c in text if not c.isspace()]
    if not non_space:
        return "no text"
    alpha_ratio = sum(c.isalpha() for c in non_space) / len(non_space)
    if alpha_ratio < MIN_ALPHA_RATIO:
        return f"only {alpha_ratio:.0%} of characters are letters"

    words = WORD.findall(text)
    if not words:
        return "no words"
    mean_length = sum(len(w) for w in words) / len(words)
    if mean_length < MIN_MEAN_WORD_LENGTH:
        return f"mean word length {mean_length:.1f}"
    return None


def run_ocrmypdf(source: Path, target: Path, sidecar: Path,
                 args: argparse.Namespace) -> subprocess.CompletedProcess:
    command = ["ocrmypdf", "--skip-text", "--sidecar", str(sidecar)]
    # --output-type pdf keeps ocrmypdf from converting to PDF/A. The conversion
    # rewrites more of the file than we need and takes longer, and the point of
    # this step is a text layer, not a change of format.
    command += ["--output-type", "pdf"]
    if args.rotate_pages:
        command.append("--rotate-pages")
    if args.deskew:
        command.append("--deskew")
    command += [str(source), str(target)]
    return subprocess.run(
        command, capture_output=True, text=True, timeout=args.timeout, check=False
    )


def tidy_message(completed: subprocess.CompletedProcess) -> str:
    """ocrmypdf's own last word on a file, trimmed to fit a CSV cell."""
    stderr = (completed.stderr or "").strip().splitlines()
    for line in reversed(stderr):
        if line.strip():
            return line.strip()[:300]
    return ""


def process(source: Path, args: argparse.Namespace) -> dict:
    """Run one file and describe what happened to it."""
    relative = source.relative_to(args.input)
    target = args.output / relative
    row = {
        "relative_path": str(relative),
        "outcome": "failed",
        "pages": "",
        "characters": "",
        "seconds": "",
        "output_bytes": "",
        "script_version": SCRIPT_VERSION,
        "options": describe_options(args),
        "message": "",
    }

    if already_done(source, target):
        row["outcome"] = "skipped"
        row["output_bytes"] = target.stat().st_size
        row["message"] = "done on an earlier run"
        return row

    target.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()

    # The sidecar goes to a temp file: we want what it tells us about the text,
    # not several thousand .txt files sitting beside the PDFs.
    with tempfile.TemporaryDirectory() as workspace:
        sidecar = Path(workspace) / "sidecar.txt"
        try:
            completed = run_ocrmypdf(source, target, sidecar, args)
        except subprocess.TimeoutExpired:
            row["seconds"] = f"{time.monotonic() - started:.1f}"
            row["message"] = f"gave up after {args.timeout}s"
            return row
        except OSError as error:
            row["seconds"] = f"{time.monotonic() - started:.1f}"
            row["message"] = str(error)[:300]
            return row

        row["seconds"] = f"{time.monotonic() - started:.1f}"
        row["message"] = tidy_message(completed)

        if completed.returncode != EXIT_OK:
            if completed.returncode == EXIT_ENCRYPTED_PDF:
                row["outcome"] = "encrypted"
            elif completed.returncode == EXIT_CTRL_C:
                raise KeyboardInterrupt
            elif completed.returncode == EXIT_MISSING_DEPENDENCY:
                # Nothing later will succeed either; let the caller stop.
                raise MissingDependency(row["message"])
            elif completed.returncode == EXIT_INPUT_FILE:
                row["message"] = row["message"] or "not a readable PDF"
            elif completed.returncode == EXIT_INVALID_OUTPUT_PDF:
                row["message"] = row["message"] or "produced an invalid PDF"
            elif completed.returncode == EXIT_FILE_ACCESS:
                row["message"] = row["message"] or "could not read or write the file"
            # A failed run may still have left a stub behind. Remove it, or the
            # next run would mistake it for work already done.
            target.unlink(missing_ok=True)
            return row

        text, pages = read_sidecar(sidecar)

    if target.is_file():
        row["output_bytes"] = target.stat().st_size
    row["pages"] = pages or ""
    row["characters"] = len(text)

    if not text:
        # Nothing came back from OCR, which with --skip-text means every page
        # already had text and was passed through untouched.
        row["outcome"] = "native"
        row["message"] = "already had a text layer"
        return row

    concern = assess_text(text, pages)
    if concern:
        row["outcome"] = "low_confidence"
        row["message"] = concern
    else:
        row["outcome"] = "ocred"
        row["message"] = ""
    return row


class MissingDependency(RuntimeError):
    """ocrmypdf is missing something it needs; every later file would fail too."""


def describe_options(args: argparse.Namespace) -> str:
    """What this run did, recorded on every row so the log explains itself."""
    flags = ["skip-text", "output-type=pdf"]
    if args.rotate_pages:
        flags.append("rotate-pages")
    if args.deskew:
        flags.append("deskew")
    return " ".join(flags)


def main() -> int:
    args = parse_args()
    preflight(args)

    args.output.mkdir(parents=True, exist_ok=True)
    log_path = args.log or (args.output / "ocr_log.csv")

    sources = find_pdfs(args.input, args.output)
    if args.limit:
        sources = sources[: args.limit]
    if not sources:
        print(f"No PDFs found under {args.input}")
        return 0

    print(f"{len(sources)} PDF(s) under {args.input}")
    print(f"Writing to {args.output}")
    print(f"Logging to {log_path}")
    print(f"Options: {describe_options(args)}\n")

    tally: dict[str, int] = {}
    interrupted = False
    fresh_log = not log_path.exists()

    # Line-buffered and flushed per row: a run that dies at file 3,000 must not
    # take the record of the first 2,999 with it.
    with log_path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=LOG_COLUMNS)
        if fresh_log:
            writer.writeheader()
            handle.flush()

        for index, source in enumerate(sources, start=1):
            try:
                row = process(source, args)
            except KeyboardInterrupt:
                interrupted = True
                break
            except MissingDependency as error:
                print(f"\nocrmypdf is missing a dependency: {error}")
                print("Stopping: every remaining file would fail the same way.")
                break

            writer.writerow(row)
            handle.flush()
            tally[row["outcome"]] = tally.get(row["outcome"], 0) + 1

            note = f" — {row['message']}" if row["message"] else ""
            print(f"[{index}/{len(sources)}] {row['outcome']:<15} "
                  f"{row['relative_path']}{note}")

    print()
    if interrupted:
        print("Stopped. Run the same command again to carry on where it left off.")
    print("Summary")
    for outcome in sorted(tally):
        print(f"  {outcome:<15} {tally[outcome]}")
    done = sum(tally.values())
    if done < len(sources):
        print(f"  {'not reached':<15} {len(sources) - done}")
    print(f"\nLog: {log_path}")

    if tally.get("failed") or tally.get("encrypted") or tally.get("low_confidence"):
        print("Some files need a look. Filter the log by outcome to find them; "
              "nothing has been lost, and they can be handled by hand.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(130)
