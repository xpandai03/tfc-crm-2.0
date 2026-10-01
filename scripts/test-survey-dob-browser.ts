/**
 * The survey's date of birth in a real browser at phone width: Chromium as an
 * Android phone (Pixel 7) and WebKit as an iPhone (iPhone 13).
 *
 * WebKit here is the Safari engine, NOT the iPhone's system date picker, which
 * no test can drive. That is why the field is now three plain number boxes:
 * what this script drives is what the phone runs.
 *
 * Playwright is not a dependency. Run it through npx, against a survey that is
 * running (local build or the live site). Nothing is ever submitted:
 *   NODE_PATH=$(dirname $(npx -y -p playwright@1.63.0 node -p "require.resolve('playwright')"))/.. \
 *     npx tsx scripts/test-survey-dob-browser.ts http://localhost:5191/survey/in-person
 *
 * Fixture identity only. No real name, date of birth, email or phone.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { chromium, webkit, devices } = require("playwright");

const URL = process.argv[2] ?? "http://localhost:5191/survey/in-person";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

type Page = any;
const box = (p: Page, part: "month" | "day" | "year") => p.locator(`input[name="dob-${part}"]`);
const boxes = async (p: Page) =>
  [await box(p, "month").inputValue(), await box(p, "day").inputValue(), await box(p, "year").inputValue()].join("/");
/** What the form will submit: the draft it mirrors to sessionStorage. */
const stored = (p: Page) => p.evaluate(() => {
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i)!;
    if (k.startsWith("tfc-survey-draft-")) return JSON.parse(sessionStorage.getItem(k)!).client?.dateOfBirth ?? "";
  }
  return "";
});
const error = (p: Page) => p.locator("[data-dob] [role=alert]").textContent({ timeout: 300 }).catch(() => null);
const fillOthers = async (p: Page) => {
  await p.locator("input.input").first().fill("Example Person");
  await p.locator("input[type=email]").fill("example@example.invalid");
  await p.locator("input[type=tel]").fill("5055550142");
};

async function suite(label: string, browserType: any, device: any) {
  console.log(`\n== ${label}`);
  const browser = await browserType.launch();
  const fresh = async () => {
    const ctx = await browser.newContext({ ...device });
    const p = await ctx.newPage();
    await p.goto(URL);
    await box(p, "month").waitFor();
    return p;
  };
  try {
    let p = await fresh();
    ok("there is no native date picker on the form", (await p.locator("input[type=date]").count()) === 0);
    ok("three boxes bring up the number keypad",
      (await p.locator('[data-dob] input[inputmode="numeric"]').count()) === 3);

    // Typing digit by digit, the way a thumb does: focus moves on by itself.
    await box(p, "month").focus();
    await p.keyboard.type("06151985", { delay: 40 });
    eq("typed 06 15 1985 in one go", await boxes(p), "06/15/1985");
    eq("the form will submit 1985-06-15", await stored(p), "1985-06-15");

    // A half-typed year is left exactly as typed, and is not yet a date.
    await box(p, "year").fill("");
    await box(p, "year").focus();
    await p.keyboard.type("19", { delay: 40 });
    eq("a half-typed year stays 19", await boxes(p), "06/15/19");
    eq("  no error while still in the field", await error(p), null);
    await p.locator("input[type=email]").focus();
    ok("  leaving with a half year says so", ((await error(p)) ?? "").includes("real date"));
    eq("  and the year is still 19 after leaving", await boxes(p), "06/15/19");
    await box(p, "year").focus();
    await p.keyboard.press("End");
    await p.keyboard.type("85", { delay: 40 });
    eq("finishing the year gives 1985", await boxes(p), "06/15/1985");
    eq("  stored 1985-06-15", await stored(p), "1985-06-15");
    eq("  and the error is gone", await error(p), null);

    // Changing only the year: select it and type over it.
    await box(p, "year").fill("2026");
    await box(p, "year").selectText();
    await p.keyboard.type("1990", { delay: 40 });
    eq("typing over 2026 gives 1990", await boxes(p), "06/15/1990");
    eq("  stored 1990-06-15", await stored(p), "1990-06-15");

    // Deleting digits and retyping.
    await box(p, "year").focus();
    await p.keyboard.press("End");
    for (let i = 0; i < 2; i++) await p.keyboard.press("Backspace");
    await p.keyboard.type("72", { delay: 40 });
    eq("backspace twice and type 72 gives 1972", await boxes(p), "06/15/1972");

    // Arrow keys do nothing harmful in a text box.
    await p.keyboard.press("ArrowUp"); await p.keyboard.press("ArrowDown");
    eq("arrow keys leave the year alone", await boxes(p), "06/15/1972");

    // Autofill / paste: a value set all at once.
    await box(p, "month").fill("6"); await box(p, "day").fill("5"); await box(p, "year").fill("1985");
    eq("filled at once, one-digit month and day", await boxes(p), "6/5/1985");
    eq("  stored zero-padded", await stored(p), "1985-06-05");

    // Letters are refused.
    await box(p, "year").fill("19a8b5");
    eq("letters do not reach the year", await box(p, "year").inputValue(), "1985");

    // Any year: oldest allowed, a child's, this year.
    for (const y of ["1907", "2017", "2026"]) {
      await box(p, "year").fill(y);
      eq(`year ${y} is kept`, await box(p, "year").inputValue(), y);
      eq(`  and is accepted`, await error(p), null);
    }

    // A future year is refused, with the client-facing message.
    await box(p, "year").fill("2027");
    await p.locator("input[type=email]").focus();
    eq("a future year asks for the year of birth", await error(p), "Please check the year of birth.");
    await fillOthers(p);
    ok("  and Continue stays off", await p.getByRole("button", { name: /Continue/i }).isDisabled());

    // Switching language halfway through the year keeps every digit.
    p = await fresh();
    await box(p, "month").fill("06"); await box(p, "day").fill("15"); await box(p, "year").fill("19");
    await p.getByRole("button", { name: /Español/i }).first().click();
    eq("switch to Spanish mid-year: boxes kept", await boxes(p), "06/15/19");
    ok("  labels are Spanish", (await p.locator("[data-dob]").textContent()).includes("Año"));
    await box(p, "year").focus(); await p.keyboard.press("End"); await p.keyboard.type("85", { delay: 40 });
    await p.getByRole("button", { name: /English/i }).first().click();
    eq("finish in Spanish, switch back: 1985 kept", await boxes(p), "06/15/1985");
    eq("  stored 1985-06-15", await stored(p), "1985-06-15");

    // Forward to step 2 and back.
    await fillOthers(p);
    await p.getByRole("button", { name: /Continue/i }).click();
    await p.getByRole("button", { name: /Back/i }).waitFor();
    await p.getByRole("button", { name: /Back/i }).click();
    await box(p, "year").waitFor();
    eq("Continue then Back: still 1985", await boxes(p), "06/15/1985");

    // A reload restores the draft.
    await p.reload();
    await box(p, "year").waitFor();
    eq("a reload restores the date", await boxes(p), "06/15/1985");
  } catch (e: any) {
    ok(`${label} ran to the end`, false, e.message.split("\n")[0]);
  } finally {
    await browser.close();
  }
}

(async () => {
  await suite("Android phone: Chromium, Pixel 7", chromium, devices["Pixel 7"]);
  await suite("iPhone: WebKit, iPhone 13", webkit, devices["iPhone 13"]);
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
  if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
})();
