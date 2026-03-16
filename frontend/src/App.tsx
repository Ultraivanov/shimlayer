import { useState } from "react";
import { Button } from "@gravity-ui/uikit";

import { config, getAdminUser } from "./api";
import { OperatorPage } from "./pages/OperatorPage";
import { OpsPage } from "./pages/OpsPage";
import { RequesterPage } from "./pages/RequesterPage";
import type { Task } from "./types";

type Tab = "requester" | "operator" | "ops";

export default function App() {
  const [tab, setTab] = useState<Tab>("requester");
  const [, setTasks] = useState<Task[]>([]);

  function upsert(task: Task) {
    setTasks((prev) => {
      const exists = prev.find((t) => t.id === task.id);
      if (!exists) return [task, ...prev];
      return prev.map((t) => (t.id === task.id ? task : t));
    });
  }

  const headerInfo = `API ${config.baseUrl} | Key ${config.apiKey} | Admin ${config.adminKey} | Role ${config.adminRole} | User ${getAdminUser()}`;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="kicker">ShimLayer</p>
          <h1>Human Escalation Console</h1>
        </div>
        <p className="meta mono">{headerInfo}</p>
      </header>

      <nav className="tabbar">
        <Button view={tab === "requester" ? "action" : "flat"} onClick={() => setTab("requester")}>
          Requester
        </Button>
        <Button view={tab === "operator" ? "action" : "flat"} onClick={() => setTab("operator")}>
          Operator
        </Button>
        <Button qa="tab-ops" view={tab === "ops" ? "action" : "flat"} onClick={() => setTab("ops")}>
          Ops
        </Button>
      </nav>

      <section className="workspace">
        {tab === "requester" ? <RequesterPage pushTask={upsert} /> : null}
        {tab === "operator" ? <OperatorPage /> : null}
        {tab === "ops" ? <OpsPage /> : null}
      </section>
    </main>
  );
}
