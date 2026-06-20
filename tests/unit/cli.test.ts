import { describe, expect, test } from "vitest";
import { type Io, parseArgs, run, SUBCOMMANDS, usage } from "../../src/cli.ts";

/** Collect stdout/stderr from a {@link run} call. */
function capture(argv: readonly string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const io: Io = {
    out: (line) => (out += line + "\n"),
    err: (line) => (err += line + "\n"),
  };
  const code = run(argv, io);
  return { code, out, err };
}

describe("parseArgs", () => {
  test("no args → none", () => {
    expect(parseArgs([])).toEqual({ kind: "none" });
  });

  test("-h / --help → help", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
  });

  test("-v / --version → version", () => {
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
  });

  test.each(SUBCOMMANDS)("%s → command", (cmd) => {
    expect(parseArgs([cmd])).toEqual({ kind: "command", command: cmd });
  });

  test("unknown token → unknown", () => {
    expect(parseArgs(["wat"])).toEqual({ kind: "unknown", arg: "wat" });
  });
});

describe("run", () => {
  test("--help prints usage listing every subcommand and exits 0", () => {
    const { code, out } = capture(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage:");
    for (const cmd of SUBCOMMANDS) expect(out).toContain(cmd);
  });

  test("--help output matches usage()", () => {
    const { out } = capture(["--help"]);
    expect(out.trim()).toBe(usage());
  });

  test("no command exits non-zero and prints usage to stderr", () => {
    const { code, err } = capture([]);
    expect(code).not.toBe(0);
    expect(err).toContain("Usage:");
  });

  test("unknown command exits non-zero and names the bad arg", () => {
    const { code, err } = capture(["frobnicate"]);
    expect(code).not.toBe(0);
    expect(err).toContain("frobnicate");
    expect(err).toContain("Usage:");
  });

  test.each(SUBCOMMANDS)("%s stub prints not-implemented and exits 0", (cmd) => {
    const { code, out } = capture([cmd]);
    expect(code).toBe(0);
    expect(out).toContain("not implemented yet");
  });
});
