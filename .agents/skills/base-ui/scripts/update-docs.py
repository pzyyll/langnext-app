# ABOUTME: Vendors Base UI's LLM documentation for offline skill use.
# ABOUTME: Recursively downloads Markdown pages and rewrites their links locally.

from __future__ import annotations

import re
import shutil
import sys
import tempfile
from collections import deque
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError, URLError
from urllib.parse import urldefrag, urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen

DOCUMENTATION_ORIGIN = "https://base-ui.com"
INDEX_URL = f"{DOCUMENTATION_ORIGIN}/llms.txt"
MAX_PAGES = 500
USER_AGENT = "langnext-app-base-ui-docs-updater"
MARKDOWN_LINK = re.compile(r"(\]\()(<[^>]+>|[^)\s]+)(\s+[^)]*)?(\))")

SCRIPT_DIRECTORY = Path(__file__).resolve().parent
SKILL_DIRECTORY = SCRIPT_DIRECTORY.parent
REFERENCE_DIRECTORY = SKILL_DIRECTORY / "references"


def documentation_url(destination: str, base_url: str) -> str | None:
    unwrapped_destination = destination.strip("<>")
    resolved_url, _ = urldefrag(urljoin(base_url, unwrapped_destination))
    parsed_url = urlparse(resolved_url)

    if (
        f"{parsed_url.scheme}://{parsed_url.netloc}" != DOCUMENTATION_ORIGIN
        or not parsed_url.path.endswith(".md")
    ):
        return None

    return urlunparse(parsed_url._replace(query="", fragment=""))


def markdown_destinations(markdown: str) -> list[str]:
    return [match.group(2) for match in MARKDOWN_LINK.finditer(markdown)]


def relative_document_path(url: str) -> PurePosixPath:
    return PurePosixPath(urlparse(url).path.lstrip("/"))


def rewrite_links(
    markdown: str,
    source_url: str,
    source_path: PurePosixPath,
    known_pages: set[str],
) -> str:
    def replace_link(match: re.Match[str]) -> str:
        destination = match.group(2)
        title = match.group(3) or ""
        original_destination = destination.strip("<>")
        fragment = urlparse(urljoin(source_url, original_destination)).fragment
        target_url = documentation_url(original_destination, source_url)

        if target_url is None or target_url not in known_pages:
            return match.group(0)

        target_path = relative_document_path(target_url)
        source_parts = source_path.parent.parts
        target_parts = target_path.parts
        common_length = 0
        for source_part, target_part in zip(source_parts, target_parts):
            if source_part != target_part:
                break
            common_length += 1

        relative_parts = [".."] * (len(source_parts) - common_length)
        relative_parts.extend(target_parts[common_length:])
        relative_path = "/".join(relative_parts)
        if not relative_path.startswith("."):
            relative_path = f"./{relative_path}"
        if fragment:
            relative_path = f"{relative_path}#{fragment}"

        return f"{match.group(1)}{relative_path}{title}{match.group(4)}"

    return MARKDOWN_LINK.sub(replace_link, markdown)


def fetch_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urlopen(request, timeout=60) as response:
            return response.read().decode("utf-8")
    except (HTTPError, URLError, TimeoutError) as error:
        raise RuntimeError(f"Failed to download {url}: {error}") from error


def download_documentation(index: str) -> dict[str, str]:
    pages: dict[str, str] = {}
    queued: set[str] = set()
    queue: deque[str] = deque()

    def enqueue_from(markdown: str, base_url: str) -> None:
        for destination in markdown_destinations(markdown):
            url = documentation_url(destination, base_url)
            if url is not None and url not in queued:
                queued.add(url)
                queue.append(url)

    enqueue_from(index, INDEX_URL)

    while queue:
        if len(pages) >= MAX_PAGES:
            raise RuntimeError(
                f"Aborted after {MAX_PAGES} pages; check the upstream documentation graph."
            )

        url = queue.popleft()
        print(f"Downloading {urlparse(url).path}")
        markdown = fetch_text(url)
        pages[url] = markdown
        enqueue_from(markdown, url)

    return pages


def write_documentation(index: str, pages: dict[str, str]) -> None:
    staging_directory = Path(
        tempfile.mkdtemp(prefix="base-ui-references-", dir=SKILL_DIRECTORY)
    )
    known_pages = set(pages)

    try:
        local_index = rewrite_links(
            index,
            INDEX_URL,
            PurePosixPath("index.md"),
            known_pages,
        )
        (staging_directory / "index.md").write_text(local_index, encoding="utf-8")

        for source_url, markdown in pages.items():
            document_path = relative_document_path(source_url)
            output_path = staging_directory.joinpath(*document_path.parts)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(
                rewrite_links(markdown, source_url, document_path, known_pages),
                encoding="utf-8",
            )

        shutil.rmtree(REFERENCE_DIRECTORY, ignore_errors=True)
        shutil.copytree(staging_directory, REFERENCE_DIRECTORY)
    finally:
        shutil.rmtree(staging_directory, ignore_errors=True)


def main() -> int:
    try:
        index = fetch_text(INDEX_URL)
        pages = download_documentation(index)
        write_documentation(index, pages)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 1

    print(f"Vendored {len(pages)} Base UI Markdown pages.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
