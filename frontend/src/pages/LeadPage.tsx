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
      setSubmitError("Заполните имя, рабочий email и компанию.");
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
      <section className="lead-hero">
        <div className="lead-hero-copy">
          <span className="lead-pill">Ранний доступ · вайтлист</span>
          <h1>Возвращайте агентные сбои в строй за минуты, а не дни.</h1>
          <p className="lead-subtitle">
            ShimLayer превращает прерывания OpenAI и «зависшие» прогоны в структурированные решения с доказательствами,
            аудитом и надежной доставкой через push + pull.
          </p>
          <div className="lead-cta-row">
            <Button
              size="l"
              view="action"
              onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              Войти в вайтлист
            </Button>
            <Button
              size="l"
              view="outlined"
              onClick={() => flowRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            >
              Посмотреть как работает
            </Button>
          </div>
          <div className="lead-trust">
            <span>SLA по решениям</span>
            <span>Артефакты доказательств</span>
            <span>Manual review</span>
            <span>Audit trail</span>
          </div>
        </div>
        <Card className="lead-hero-card" view="raised">
          <h3>Что вы получаете</h3>
          <ul>
            <li>Approve/Reject для прерываний OpenAI</li>
            <li>HITL-спасение «зависших» флоу</li>
            <li>Доставка, которая сходится даже при сбоях вебхуков</li>
            <li>Ops‑контроль: locks, queues, refunds, audits</li>
          </ul>
        </Card>
      </section>

      <section className="lead-proof">
        <div className="lead-proof-head">
          <h3>Нам доверяют команды, которые не могут ждать</h3>
          <p>Вы первые — мы даем приоритет в онбординге и вместе формируем продукт.</p>
        </div>
        <div className="lead-logos">
          <span className="logo-pill">Fintech</span>
          <span className="logo-pill">E‑commerce</span>
          <span className="logo-pill">Logistics</span>
          <span className="logo-pill">Travel</span>
          <span className="logo-pill">Security</span>
        </div>
        <div className="lead-quote">
          <p>“Нужен был контроль над решениями агента — за 1 день получили прозрачно работающий контур.”</p>
          <span>Ops Lead, design partner</span>
        </div>
      </section>

      <section className="lead-grid">
        <Card className="lead-metric" view="raised">
          <h4>Минуты до решения</h4>
          <p>Прозрачные SLA и быстрые операторы для критичных кейсов.</p>
        </Card>
        <Card className="lead-metric" view="raised">
          <h4>Proof‑first результат</h4>
          <p>Каждое решение сопровождается доказательствами и заметками.</p>
        </Card>
        <Card className="lead-metric" view="raised">
          <h4>Надежная доставка</h4>
          <p>Push + pull обеспечивает сходимость даже при сбоях.</p>
        </Card>
      </section>

      <section className="lead-flow" ref={flowRef}>
        <Card className="lead-flow-card" view="raised">
          <h3>Как это работает</h3>
          <ol>
            <li>Прерывание превращается в задачу ShimLayer.</li>
            <li>Оператор принимает решение и прикладывает proof.</li>
            <li>Вы возобновляете ран с подписанным payload.</li>
          </ol>
        </Card>
        <Card className="lead-flow-card" view="raised">
          <h3>Идеально для</h3>
          <ul>
            <li>Агентных флоу с непредсказуемыми edge‑кейcами</li>
            <li>Высокорисковых решений с аудитом</li>
            <li>Команд, которым нужна надежность без ручного контроля</li>
          </ul>
        </Card>
      </section>

      <section className="lead-form" ref={formRef}>
        <Card className="lead-form-card" view="raised">
          <h2>Войти в вайтлист</h2>
          <p>Ответим в течение 2 рабочих дней. Ранние команды получают приоритетный онбординг.</p>
          <div className="lead-form-grid">
            <TextInput size="l" placeholder="Имя" value={leadName} onUpdate={setLeadName} disabled={submitBusy} />
            <TextInput size="l" placeholder="Рабочий email" value={leadEmail} onUpdate={setLeadEmail} disabled={submitBusy} />
            <TextInput size="l" placeholder="Компания" value={leadCompany} onUpdate={setLeadCompany} disabled={submitBusy} />
            <TextInput size="l" placeholder="Роль (опционально)" value={leadRole} onUpdate={setLeadRole} disabled={submitBusy} />
            <Select
              size="l"
              placeholder="Объем задач в месяц"
              value={leadVolume ? [leadVolume] : []}
              options={[
                { value: "lt-100", content: "Меньше 100" },
                { value: "100-1000", content: "100 - 1 000" },
                { value: "1k-10k", content: "1 000 - 10 000" },
                { value: "gt-10k", content: "Больше 10 000" }
              ]}
              onUpdate={(items) => setLeadVolume(String(items[0] ?? ""))}
              disabled={submitBusy}
            />
            <Select
              size="l"
              placeholder="Когда хотите начать?"
              value={leadTimeline ? [leadTimeline] : []}
              options={[
                { value: "now", content: "В этом месяце" },
                { value: "30d", content: "Через 1–2 месяца" },
                { value: "90d", content: "Через 3–6 месяцев" },
                { value: "later", content: "Позже" }
              ]}
              onUpdate={(items) => setLeadTimeline(String(items[0] ?? ""))}
              disabled={submitBusy}
            />
            <div className="lead-form-wide">
              <TextArea
                minRows={3}
                placeholder="Основной кейс использования"
                value={leadUsecase}
                onUpdate={setLeadUsecase}
                disabled={submitBusy}
              />
            </div>
            <div className="lead-form-wide">
              <TextArea
                minRows={2}
                placeholder="Контакты или детали (опционально)"
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
          {submitOk ? <p className="lead-success">Спасибо! Мы свяжемся в ближайшее время.</p> : null}
          {submitError ? <p className="lead-error">{submitError}</p> : null}
          <div className="lead-form-actions">
            <Button size="l" view="action" onClick={() => void submitLead()} loading={submitBusy} disabled={submitBusy}>
              Войти в вайтлист
            </Button>
            <Button size="l" view="outlined" onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
              Связаться с нами
            </Button>
          </div>
        </Card>
      </section>
    </main>
  );
}
