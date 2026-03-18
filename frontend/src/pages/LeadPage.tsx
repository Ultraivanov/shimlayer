import { Button, Card, Select, TextArea, TextInput } from "@gravity-ui/uikit";
import "../styles/lead.css";

export function LeadPage() {
  return (
    <main className="lead-root">
      <section className="lead-hero">
        <div className="lead-hero-copy">
          <span className="lead-pill">Early access whitelist</span>
          <h1>Recover agent failures in minutes, not days.</h1>
          <p className="lead-subtitle">
            ShimLayer turns OpenAI interruptions and stuck runs into structured human decisions with proof, audits,
            and a reliable push + pull delivery model.
          </p>
          <div className="lead-cta-row">
            <Button size="l" view="action">
              Join the whitelist
            </Button>
            <Button size="l" view="outlined">
              See how it works
            </Button>
          </div>
          <div className="lead-trust">
            <span>Decision SLAs</span>
            <span>Proof artifacts</span>
            <span>Manual review controls</span>
            <span>Audit trail</span>
          </div>
        </div>
        <Card className="lead-hero-card" view="raised">
          <h3>What you get</h3>
          <ul>
            <li>Approve/reject loops for OpenAI interruptions</li>
            <li>Human-in-the-loop rescue for stuck flows</li>
            <li>Deliveries that converge even when webhooks fail</li>
            <li>Ops visibility: locks, queues, refunds, audits</li>
          </ul>
        </Card>
      </section>

      <section className="lead-grid">
        <Card className="lead-metric" view="raised">
          <h4>Minutes to decision</h4>
          <p>Target SLAs with human operators who can take over fast.</p>
        </Card>
        <Card className="lead-metric" view="raised">
          <h4>Proof-first outcomes</h4>
          <p>Every decision includes proof artifacts and structured notes.</p>
        </Card>
        <Card className="lead-metric" view="raised">
          <h4>Reliable delivery</h4>
          <p>Push + pull fallback ensures your system always converges.</p>
        </Card>
      </section>

      <section className="lead-flow">
        <Card className="lead-flow-card" view="raised">
          <h3>How it works</h3>
          <ol>
            <li>Interruptions are ingested into ShimLayer as tasks.</li>
            <li>Operators claim, decide, and attach proof.</li>
            <li>You resume runs using a signed payload.</li>
          </ol>
        </Card>
        <Card className="lead-flow-card" view="raised">
          <h3>Best for</h3>
          <ul>
            <li>Agentic workflows with unpredictable edge cases</li>
            <li>High-stakes decisions that need audits</li>
            <li>Teams that want reliability without babysitting</li>
          </ul>
        </Card>
      </section>

      <section className="lead-form">
        <Card className="lead-form-card" view="raised">
          <h2>Join the whitelist</h2>
          <p>We reply within 2 business days. Early teams get priority onboarding.</p>
          <div className="lead-form-grid">
            <TextInput size="l" placeholder="Name" />
            <TextInput size="l" placeholder="Work email" />
            <TextInput size="l" placeholder="Company" />
            <TextInput size="l" placeholder="Role (optional)" />
            <Select
              size="l"
              placeholder="Monthly task volume"
              options={[
                { value: "lt-100", content: "Less than 100" },
                { value: "100-1000", content: "100 - 1,000" },
                { value: "1k-10k", content: "1,000 - 10,000" },
                { value: "gt-10k", content: "More than 10,000" }
              ]}
            />
            <Select
              size="l"
              placeholder="When do you want to start?"
              options={[
                { value: "now", content: "This month" },
                { value: "30d", content: "1-2 months" },
                { value: "90d", content: "3-6 months" },
                { value: "later", content: "Later" }
              ]}
            />
            <div className="lead-form-wide">
              <TextArea minRows={3} placeholder="Primary use case" />
            </div>
          </div>
          <div className="lead-form-actions">
            <Button size="l" view="action">
              Join whitelist
            </Button>
            <Button size="l" view="outlined">
              Contact sales
            </Button>
          </div>
        </Card>
      </section>
    </main>
  );
}
