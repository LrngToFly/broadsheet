import { describe, expect, it } from "vitest";
import { readerUrlFromRemote } from "../src/setup.ts";

describe("setting up a new copy", () => {
  it("works out the reader's address from the fork's GitHub remote", () => {
    expect(readerUrlFromRemote("https://github.com/SomeOne/broadsheet.git")).toBe("https://someone.github.io/broadsheet/");
    expect(readerUrlFromRemote("git@github.com:SomeOne/my-paper.git")).toBe("https://someone.github.io/my-paper/");
    expect(readerUrlFromRemote("https://github.com/someone/broadsheet")).toBe("https://someone.github.io/broadsheet/");
    expect(readerUrlFromRemote("https://gitlab.com/someone/broadsheet.git")).toBeNull();
  });
});
