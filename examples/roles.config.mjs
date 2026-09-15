// An app with sign-in and roles, captured once per role into one file.
//
//   node cli.mjs all --config examples/roles.config.mjs
//
// Each role is a variant: the crawl signs in as that role, records what it sees
// (including where the app redirects it away), and the file keeps all of them.
// The app's own sign-in form becomes the role switcher offline: its POST is
// emulated by `offline.post`, which picks the variant and where to land.

const ROLES = [
  ["admin", "Administrator"],
  ["editor", "Editor"],
  ["viewer", "Viewer"],
];

// Sign in through the real screen, as a person would. This runs before the
// crawl's write guard is installed, so it may POST.
function signInAs(role) {
  return async ({ context, origin }) => {
    const page = await context.newPage();
    await page.goto(`${origin}/signin`);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.startsWith("/signin")),
      page.locator(`form:has(input[name="role"][value="${role}"]) button[type="submit"]`).click(),
    ]);
    await page.close();
  };
}

export default {
  name: "my-app-roles",
  title: "My App",
  app: {
    cwd: "../../my-app",
    build: "npx next build",
    start: "npx next start -p {port}",
    port: 3217,
  },
  out: "./out/my-app-roles.html",
  seeds: ["/", "/signin"],
  defaultVariant: "signed-out",
  variants: [
    { id: "signed-out", label: "Signed out" },
    ...ROLES.map(([id, label]) => ({ id, label, login: signInAs(id) })),
  ],
  offline: {
    // The app's sign-in screen switches roles, so the badge does not need to.
    switcher: false,
    // Serialised into the file: arrow or function expressions only.
    post: {
      "/api/auth/signin": (form) => ({ variant: form.role || "viewer", location: form.next || "/" }),
      "/api/auth/signout": () => ({ variant: "signed-out", location: "/signin" }),
    },
    // Hide what means nothing offline.
    css: `[data-testid="account-menu"] { display: none !important; }`,
  },
};
