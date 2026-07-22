// ABOUTME: Incremental UTF-8 and SSE event decoder over raw provider stream chunks.
// ABOUTME: Follows standard SSE line rules; does not interpret provider JSON payloads.
import type { SseEvent } from "./types";

/** Decode UTF-8 bytes incrementally across chunk boundaries. */
export class Utf8StreamDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });

  push(bytes: Uint8Array): string {
    return this.decoder.decode(bytes, { stream: true });
  }

  finish(): string {
    return this.decoder.decode();
  }
}

/** Incremental Server-Sent Events parser over decoded text chunks. */
export class SseEventDecoder {
  private buffer = "";
  private eventName: string | null = null;
  private dataLines: string[] = [];

  push(text: string): SseEvent[] {
    this.buffer += text;
    const events: SseEvent[] = [];
    // Normalize CRLF to LF for line splitting.
    this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const event = this.consumeLine(line);
      if (event) {
        events.push(event);
      }
    }
    return events;
  }

  /** Flush a trailing event when the stream ends without a final blank line. */
  finish(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const event = this.consumeLine(this.buffer);
      this.buffer = "";
      if (event) {
        events.push(event);
      }
    }
    const trailing = this.dispatchEvent();
    if (trailing) {
      events.push(trailing);
    }
    return events;
  }

  private consumeLine(line: string): SseEvent | null {
    if (line.startsWith(":")) {
      // Comment / keepalive.
      return null;
    }
    if (line === "") {
      return this.dispatchEvent();
    }
    const colonIndex = line.indexOf(":");
    let field: string;
    let value: string;
    if (colonIndex < 0) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colonIndex);
      value = line.slice(colonIndex + 1);
      if (value.startsWith(" ")) {
        value = value.slice(1);
      }
    }
    if (field === "event") {
      this.eventName = value;
    } else if (field === "data") {
      this.dataLines.push(value);
    }
    return null;
  }

  private dispatchEvent(): SseEvent | null {
    if (this.dataLines.length === 0 && this.eventName === null) {
      return null;
    }
    const event: SseEvent = {
      event: this.eventName,
      data: this.dataLines.join("\n"),
    };
    this.eventName = null;
    this.dataLines = [];
    return event;
  }
}
