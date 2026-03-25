import { useMemo, useRef, useState } from "react";
import { Button, Card, Select, TextArea, TextInput } from "@gravity-ui/uikit";
import { Api } from "../api";
import "../styles/lead.css";

export function LeadPage() {
  const [leadName, setLeadName] = useState("");
  const [leadEmail, setLeadEmail] = useState("");
  const [leadCompany, setLeadCompany] = useState("");
  const [leadRole, setLeadRole] = useState("");
  const [leadVolume, setLeadVolume] = useState("");
  const [leadTimeline, setLeadTimeline] = useState("");
  const [leadUsecase, setLeadUsecase] = useState("");
  const [leadContact, setLeadContact] = useState("");
  const [leadCompanySite, setLeadCompanySite] = useState("");
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitOk, setSubmitOk] = useState(false);

  const formRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<HTMLDivElement | null>(null);

  const pagePath = useMemo(() => {
    if (typeof window === "undefined") return "/lead";
    return window.location.pathname;
  }, []);
  const utmMeta = useMemo(() => {
    if (typeof window === "undefined") return {};
    const params = new URLSearchParams(window.location.search);
    const keys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
    const meta: Record<string, string> = {};
    keys.forEach((k) => {
      const value = params.get(k);
      if (value) meta[k] = value;
    });
    return meta;
  }, []);

  async function submitLead() {
    setSubmitError("");
    setSubmitOk(false);
    const name = leadName.trim();
    const email = leadEmail.trim();
    const company = leadCompany.trim();
    if (!name || !email || !company) {
      setSubmitError("Please add contact name, work email, and team/company.");
      return;
    }
    setSubmitBusy(true);
    try {
      await Api.createLead({
        name,
        email,
        company,
        role: leadRole.trim() || null,
        volume: leadVolume || null,
        timeline: leadTimeline || null,
        usecase: leadUsecase.trim() || null,
        contact: leadContact.trim() || null,
        source: "lead_page",
        page: pagePath,
        metadata: utmMeta,
        company_site: leadCompanySite.trim() || null
      });
      setSubmitOk(true);
      setLeadCompanySite("");
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitBusy(false);
    }
  }

  return (
    <main className="lead-root">
      <header className="lead-nav">
        <div className="lead-nav-inner">
          <div className="lead-brand">
            <span className="lead-brand-mark" />
            <span className="lead-brand-name">ShimLayer</span>
          </div>
          <nav className="lead-nav-links">
            <a href="#how">How it works</a>
            <a href="#scope">Scope</a>
            <a href="#pricing">Pricing</a>
            <a href="#alpha">Alpha</a>
          </nav>
          <Button size="m" view="action" onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            Request Alpha Access
          </Button>
        </div>
      </header>

      <section className="lead-section lead-hero" id="top">
        <div className="lead-hero-grid">
          <div className="lead-hero-copy">
            <div className="lead-chips">
              <span className="lead-chip">ALPHA</span>
              <span className="lead-chip">API‑FIRST</span>
              <span className="lead-chip">TRACEABLE</span>
            </div>
            <h1>Human recovery layer for AI agents</h1>
            <p className="lead-subtitle">
              When an agent gets stuck, uncertain, or reaches a risky action, ShimLayer routes the step to a human,
              returns a bounded intervention, and lets the agent continue.
            </p>
            <div className="lead-meta">API‑first · 1–3 min interventions · full trace</div>
            <div className="lead-cta-row">
              <Button size="l" view="action" onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                Request Alpha Access
              </Button>
              <Button size="l" view="outlined" onClick={() => flowRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                See how it works
              </Button>
            </div>
          </div>
          <Card className="lead-panel" view="raised">
            <div className="lead-panel-title">Runtime boundary</div>
            <ul className="lead-list">
              <li>Agent escalates only when stuck / low‑confidence / risky</li>
              <li>Human returns a minimal decision + traceable proof</li>
              <li>Structured output, replayable logs, audit trail</li>
              <li>Push + pull delivery for convergence</li>
            </ul>
          </Card>
        </div>
      </section>

      <section className="lead-section lead-audience">
        <div className="lead-section-label">01</div>
        <div className="lead-audience-grid">
          <Card className="lead-panel" view="raised">
            <div className="lead-panel-title">This is for</div>
            <ul className="lead-list">
              <li>Teams running agents in production or close to it</li>
              <li>Infra‑minded founders shipping autonomous workflows</li>
              <li>Developers who need recovery without manual babysitting</li>
            </ul>
          </Card>
          <Card className="lead-panel" view="raised">
            <div className="lead-panel-title">This is not for</div>
            <ul className="lead-list">
              <li>Prompt playgrounds or demo‑only experiments</li>
              <li>General consumer AI curiosity traffic</li>
              <li>Teams without production pain yet</li>
            </ul>
          </Card>
        </div>
      </section>

      <section className="lead-section lead-problem">
        <div className="lead-section-label">02</div>
        <div className="lead-split">
          <Card className="lead-panel" view="raised">
            <div className="lead-panel-title">Failure modes</div>
            <ul className="lead-list">
              <li>Stuck loops and retries that never converge</li>
              <li>UI or flow drift after a product change</li>
              <li>Low‑confidence decisions with no safe default</li>
              <li>Risky actions that must be approved</li>
            </ul>
          </Card>
          <Card className="lead-panel" view="raised">
            <div className="lead-panel-title">Solution boundary</div>
            <ol className="lead-steps">
              <li>Agent detects stuck / unsafe state</li>
              <li>ShimLayer packages context</li>
              <li>Human resolves the minimal missing piece</li>
              <li>Agent continues with structured output</li>
            </ol>
          </Card>
        </div>
      </section>

      <section className="lead-section lead-how" id="how" ref={flowRef}>
        <div className="lead-section-label">03</div>
        <Card className="lead-panel" view="raised">
          <div className="lead-panel-title">How it works</div>
          <div className="lead-how-grid">
            <div className="lead-code">
              <pre>
agent.run()

if stuck or low_confidence:
    result = shimlayer.resolve(context)
    agent.apply(result)
              </pre>
            </div>
            <div className="lead-io">
              <div className="lead-io-row">
                <span className="lead-io-label">input</span>
                <span className="lead-io-value">logs, state, screenshot / DOM snapshot</span>
              </div>
              <div className="lead-io-row">
                <span className="lead-io-label">output</span>
                <span className="lead-io-value">next action, structured result, trace</span>
              </div>
              <div className="lead-io-row">
                <span className="lead-io-label">delivery</span>
                <span className="lead-io-value">push + pull (convergent)</span>
              </div>
            </div>
          </div>
        </Card>
      </section>

      <section className="lead-section lead-scope" id="scope">
        <div className="lead-section-label">04</div>
        <Card className="lead-panel" view="raised">
          <div className="lead-panel-title">Alpha scope</div>
          <ul className="lead-list">
            <li>Stuck states and loops</li>
            <li>Broken or changed UI</li>
            <li>Binary decisions</li>
            <li>Explicit human approval for risky actions</li>
          </ul>
        </Card>
      </section>

      <section className="lead-section lead-proof">
        <div className="lead-section-label">05</div>
        <Card className="lead-panel" view="raised">
          <div className="lead-panel-title">Proof layer</div>
          <p className="lead-muted">
            Every intervention includes an execution log, timestamps, reason codes, and a replayable trace.
          </p>
          <div className="lead-proof-row">
            <span className="lead-chip">EXEC LOG</span>
            <span className="lead-chip">TIMESTAMPS</span>
            <span className="lead-chip">REASON CODES</span>
            <span className="lead-chip">TRACE</span>
          </div>
        </Card>
      </section>

      <section className="lead-section lead-pricing" id="pricing">
        <div className="lead-section-label">06</div>
        <Card className="lead-panel" view="raised">
          <div className="lead-panel-title">Pricing</div>
          <div className="lead-pricing-grid">
            <div className="lead-price-main">
              <div className="lead-price">$1.80 per recovery</div>
              <div className="lead-muted">Free tier: 50 per month</div>
            </div>
            <div className="lead-price-cards">
              <div className="lead-price-card">$49 · 25 recoveries</div>
              <div className="lead-price-card">$199 · 120 recoveries</div>
              <div className="lead-price-card">$999 · 600 recoveries</div>
            </div>
          </div>
        </Card>
      </section>

      <section className="lead-section lead-alpha" id="alpha">
        <div className="lead-section-label">07</div>
        <Card className="lead-panel" view="raised">
          <div className="lead-panel-title">Alpha program</div>
          <p className="lead-muted">
            Early alpha, limited capacity, manual onboarding, and a direct feedback loop with the founders.
          </p>
        </Card>
      </section>

      <section className="lead-section lead-form" ref={formRef}>
        <div className="lead-section-label">08</div>
        <Card className="lead-panel" view="raised">
          <div className="lead-panel-title">Request Alpha Access</div>
          <p className="lead-muted">We use this to qualify teams and prioritize onboarding.</p>
          <div className="lead-form-grid">
            <TextInput size="l" placeholder="Contact name" value={leadName} onUpdate={setLeadName} disabled={submitBusy} />
            <TextInput size="l" placeholder="Work email" value={leadEmail} onUpdate={setLeadEmail} disabled={submitBusy} />
            <TextInput size="l" placeholder="Team / company" value={leadCompany} onUpdate={setLeadCompany} disabled={submitBusy} />
            <TextInput size="l" placeholder="Role (optional)" value={leadRole} onUpdate={setLeadRole} disabled={submitBusy} />
            <Select
              size="l"
              placeholder="Monthly runs (approx)"
              value={leadVolume ? [leadVolume] : []}
              options={[
                { value: "lt-100", content: "Less than 100" },
                { value: "100-1000", content: "100 – 1,000" },
                { value: "1k-10k", content: "1,000 – 10,000" },
                { value: "gt-10k", content: "More than 10,000" }
              ]}
              onUpdate={(items) => setLeadVolume(String(items[0] ?? ""))}
              disabled={submitBusy}
            />
            <Select
              size="l"
              placeholder="Would you use human fallback today?"
              value={leadTimeline ? [leadTimeline] : []}
              options={[
                { value: "yes", content: "Yes, we need it now" },
                { value: "maybe", content: "Maybe in the next 1–2 months" },
                { value: "later", content: "Not yet, but soon" }
              ]}
              onUpdate={(items) => setLeadTimeline(String(items[0] ?? ""))}
              disabled={submitBusy}
            />
            <div className="lead-form-wide">
              <TextArea
                minRows={3}
                placeholder="What does your agent do?"
                value={leadUsecase}
                onUpdate={setLeadUsecase}
                disabled={submitBusy}
              />
            </div>
            <div className="lead-form-wide">
              <TextArea
                minRows={3}
                placeholder="Where does it fail today?"
                value={leadContact}
                onUpdate={setLeadContact}
                disabled={submitBusy}
              />
            </div>
            <div className="lead-honeypot">
              <TextInput
                size="l"
                placeholder="Company website"
                value={leadCompanySite}
                onUpdate={setLeadCompanySite}
                disabled={submitBusy}
              />
            </div>
          </div>
          {submitOk ? <p className="lead-success">Thanks — we’ll reach out soon.</p> : null}
          {submitError ? <p className="lead-error">{submitError}</p> : null}
          <div className="lead-form-actions">
            <Button size="l" view="action" onClick={() => void submitLead()} loading={submitBusy} disabled={submitBusy}>
              Request Alpha Access
            </Button>
          </div>
        </Card>
      </section>

      <footer className="lead-footer">
        <div className="lead-footer-inner">
          <span>Docs</span>
          <span>Contact</span>
          <span>Privacy</span>
        </div>
      </footer>
    </main>
  );
}
