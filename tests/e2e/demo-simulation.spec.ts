/**
 * Demo-only scenario. Run after adding @playwright/test to the project:
 * npx playwright test tests/e2e/demo-simulation.spec.ts --reporter=line
 */
import { expect, test } from "@playwright/test";

type DemoEvent = {
  id: string;
  source: "slack" | "github";
  kind: "message" | "pull_request" | "ci";
  text: string;
  location: string;
  author: string;
};

const demoEvents: DemoEvent[] = [
  {
    id: "slack-001",
    source: "slack",
    kind: "message",
    text: "Staging is green. We still need to confirm who owns rollback and when customer comms go out.",
    location: "#product-engineering",
    author: "Maya",
  },
  {
    id: "github-842",
    source: "github",
    kind: "pull_request",
    text: "PR #842: Canary rollout is ready for review; rollback runbook is linked but has no named owner.",
    location: "acme/payments#842",
    author: "Alex",
  },
  {
    id: "ci-001",
    source: "github",
    kind: "ci",
    text: "CI passed",
    location: "acme/payments#842",
    author: "github-actions[bot]",
  },
];

const demoMarkup = `
  <main aria-label="Signal demo simulation">
    <p data-testid="simulation-label">PLAYWRIGHT SIMULATION · SYNTHETIC DATA</p>
    <h1>Conversation intelligence</h1>
    <p data-testid="observer-state">Observer is listening to Slack and GitHub PRs</p>
    <section aria-label="Event processing">
      <h2>Event stream</h2>
      <p data-testid="event-count"></p>
      <ul data-testid="event-list"></ul>
    </section>
    <section aria-label="Executive readout">
      <h2>Executive readout</h2>
      <p data-testid="executive-answer"></p>
      <div data-testid="evidence"></div>
      <p data-testid="confidence"></p>
    </section>
    <section aria-label="Human intervention">
      <h2>Human intervention</h2>
      <p data-testid="intervention-status"></p>
      <p data-testid="intervention-question"></p>
      <button type="button" data-testid="ask-vp" disabled>Ask VP to intervene</button>
      <p data-testid="approval-status"></p>
    </section>
  </main>
`;

test("passive observer filters noise, synthesizes the thread, and gates VP escalation", async ({ page }) => {
  await page.setContent(demoMarkup);

  await page.evaluate((events: DemoEvent[]) => {
    const signalEvents = events.filter((event) => {
      if (event.kind === "ci") return false;
      if (event.author.endsWith("[bot]")) return false;
      return event.text.length > 20;
    });
    const hasBlocker = signalEvents.some((event) => /owner|rollback|blocked/i.test(event.text));
    const evidence = signalEvents.map((event) => `${event.source === "slack" ? "Slack" : "GitHub"} · ${event.location}`);

    document.querySelector("[data-testid=event-count]")!.textContent =
      `${events.length} events received · ${events.length - signalEvents.length} filtered as noise`;
    document.querySelector("[data-testid=event-list]")!.innerHTML = signalEvents
      .map((event) => `<li>${event.source === "slack" ? "Slack" : "GitHub PR"}: ${event.text}</li>`)
      .join("");
    document.querySelector("[data-testid=executive-answer]")!.textContent = hasBlocker
      ? "The canary rollout is technically ready, but the rollback owner and customer communication window are unresolved."
      : "No material decision gap detected.";
    document.querySelector("[data-testid=evidence]")!.textContent = `Evidence: ${evidence.join("; ")}`;
    document.querySelector("[data-testid=confidence]")!.textContent = "Luna confidence: 82% · read-only synthesis";
    document.querySelector("[data-testid=intervention-status]")!.textContent = hasBlocker
      ? "VP intervention recommended"
      : "No human intervention needed";
    document.querySelector("[data-testid=intervention-question]")!.textContent = hasBlocker
      ? "Can you confirm the rollback owner and customer communication window?"
      : "";

    const askButton = document.querySelector<HTMLButtonElement>("[data-testid=ask-vp]")!;
    askButton.disabled = !hasBlocker;
    askButton.addEventListener("click", () => {
      document.querySelector("[data-testid=approval-status]")!.textContent =
        "Question queued for human approval before it is sent to the squad.";
    });
  }, demoEvents);

  await expect(page.getByTestId("simulation-label")).toContainText("SYNTHETIC DATA");
  await expect(page.getByTestId("event-count")).toHaveText("3 events received · 1 filtered as noise");
  await expect(page.getByTestId("executive-answer")).toContainText("rollback owner");
  await expect(page.getByTestId("evidence")).toContainText("Slack · #product-engineering");
  await expect(page.getByTestId("evidence")).toContainText("GitHub · acme/payments#842");
  await expect(page.getByTestId("intervention-status")).toHaveText("VP intervention recommended");
  await expect(page.getByTestId("ask-vp")).toBeEnabled();

  await page.getByTestId("ask-vp").click();
  await expect(page.getByTestId("approval-status")).toHaveText(
    "Question queued for human approval before it is sent to the squad.",
  );
});
