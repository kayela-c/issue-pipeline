import { describe, expect, it } from "vitest";
import { renderFileList, routedPaths } from "./budget";

const files = [
  { path: "README.md", size: 100 },
  { path: "app/Http/Controllers/Auth/PasswordResetController.php", size: 2400 },
  { path: "resources/views/welcome.blade.php", size: 700 },
  { path: "routes/web.php", size: 1800 },
];

describe("renderFileList", () => {
  it("lists everything with sizes when it fits", () => {
    expect(renderFileList(files, "notes", 10_000)).toMatchObject({ mode: "sizes", shown: 4, total: 4 });
  });

  it("drops sizes before dropping files", () => {
    const listing = renderFileList(files, "notes", 120);
    expect(listing).toMatchObject({ mode: "paths", shown: 4 });
    expect(listing.text).not.toContain("bytes");
  });

  it("keeps the best name matches for the notes when even paths do not fit", () => {
    const listing = renderFileList(files, "The password reset link 404s", 70);
    expect(listing.mode).toBe("ranked");
    expect(listing.text.split("\n")).toContain("app/Http/Controllers/Auth/PasswordResetController.php");
    expect(listing.text.length).toBeLessThanOrEqual(70);
    expect(listing.shown).toBeLessThan(listing.total);
  });
});

describe("routedPaths and routing-aware ranking", () => {
  const routing = [
    "# Routing",
    "- Password reset: `app/Http/Controllers/Auth/` and `routes/web.php`",
    "- Admin panel: app/Filament/**/*.php",
    "- Docs: https://example.com/guide (not a repo path)",
  ].join("\n");

  it("extracts directories, files, and glob prefixes", () => {
    const paths = routedPaths(routing);
    expect(paths).toEqual(expect.arrayContaining(["app/http/controllers/auth/", "routes/web.php", "app/filament/"]));
  });

  it("keeps routed files ahead of name matches when the list must be cut", () => {
    const tree = [
      { path: "app/Http/Controllers/Auth/ForgotController.php", size: 10 },
      { path: "resources/views/reset-password-widget.blade.php", size: 10 },
      { path: "app/Filament/Resources/UserResource.php", size: 10 },
      ...Array.from({ length: 50 }, (_, i) => ({ path: `app/Services/Other${i}.php`, size: 10 })),
    ];
    const listing = renderFileList(tree, "reset password", 100, routing);
    expect(listing.mode).toBe("ranked");
    expect(listing.text).toContain("app/Http/Controllers/Auth/ForgotController.php");
    expect(listing.text).toContain("app/Filament/Resources/UserResource.php");
    expect(listing.text).not.toContain("reset-password-widget");
  });
});
