import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MobileNav } from "../client/src/components/MobileNav";

// Role-dependent contents are unit-tested independently of Radix's browser
// portal; the real mobile browser suite verifies opening and clicking the sheet.
vi.mock("../client/src/components/ui/sheet", () => {
  const Part = ({ children }: { children?: React.ReactNode }) => createElement("div", null, children);
  return { Sheet: Part, SheetContent: Part, SheetFooter: Part, SheetHeader: Part, SheetTitle: Part, SheetTrigger: Part };
});

vi.stubGlobal("React", React);
afterAll(() => vi.unstubAllGlobals());

function markup(role?: string) {
  return renderToStaticMarkup(createElement(Router, { ssrPath: "/" },
    createElement(MobileNav, { user: { name: "Test operator", role }, onLogout: () => {} })));
}

describe("manager review mobile entry", () => {
  it("exposes the existing founder portal to an admin without a hard reload", () => {
    expect(markup("admin")).toContain('href="/founder"');
    expect(markup("admin")).toContain("VA Management");
  });

  it.each(["worker", "user", undefined])("does not expose founder entry for %s", role => {
    expect(markup(role)).not.toContain('href="/founder"');
    expect(markup(role)).toContain('href="/aptlss"');
  });
});
