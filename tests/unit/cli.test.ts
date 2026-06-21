import { describe, expect, test } from "vitest";
import { type Io, parseArgs, run, SUBCOMMANDS, usage } from "../../src/cli.ts";

/** Collect stdout/stderr from a {@link run} call. */
async function capture(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: Io = {
    out: (line) => (out += line + "\n"),
    err: (line) => (err += line + "\n"),
  };
  const code = await run(argv, io);
  return { code, out, err };
}

/** The subcommands still reporting "not implemented yet" (replay is implemented). */
const STUB_SUBCOMMANDS = ["run", "dry-run", "preflight"] as const;

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
  test("--help prints usage listing every subcommand and exits 0", async () => {
    const { code, out } = await capture(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Usage:");
    for (const cmd of SUBCOMMANDS) expect(out).toContain(cmd);
  });

  test("--help output matches usage()", async () => {
    const { out } = await capture(["--help"]);
    expect(out.trim()).toBe(usage());
  });

  test("no command exits non-zero and prints usage to stderr", async () => {
    const { code, err } = await capture([]);
    expect(code).not.toBe(0);
    expect(err).toContain("Usage:");
  });

  test("unknown command exits non-zero and names the bad arg", async () => {
    const { code, err } = await capture(["frobnicate"]);
    expect(code).not.toBe(0);
    expect(err).toContain("frobnicate");
    expect(err).toContain("Usage:");
  });

  test.each(STUB_SUBCOMMANDS)("%s stub prints not-implemented and exits 0", async (cmd) => {
    const { code, out } = await capture([cmd]);
    expect(code).toBe(0);
    expect(out).toContain("not implemented yet");
  });

  test("replay with no stateDir errors and prints usage", async () => {
    const { code, err } = await capture(["replay"]);
    expect(code).not.toBe(0);
    expect(err).toContain("replay requires a <stateDir>");
    expect(err).toContain("Usage:");
  });

  test("replay of an empty/absent state dir prints (no events) and exits 0", async () => {
    const { code, out } = await capture(["replay", "/no/such/state/dir/dev3-loop"]);
    expect(code).toBe(0);
    expect(out).toContain("(no events)");
  });
});
