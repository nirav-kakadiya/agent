// ARISE Server — HTTP API + Web UI
// Exposes the agent pipeline via REST API

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { join } from "path";
import { readdir, readFile } from "fs/promises";

import { MessageBus } from "./core/bus";
import { Memory } from "./core/memory";
import { LLM } from "./core/llm";
import { Executor } from "./core/executor";
import { createMessage } from "./core/message";

import { OrchestratorAgent } from "./agents/orchestrator";
import { ResearcherAgent } from "./agents/researcher";
import { WriterAgent } from "./agents/writer";
import { EditorAgent } from "./agents/editor";
import { PublisherAgent } from "./agents/publisher";
import { SkillBuilderAgent } from "./agents/skill-builder";
import { SocialWriterAgent } from "./agents/social-writer";
import { BrandManagerAgent } from "./agents/brand-manager";

const ROOT = import.meta.dir || __dirname;

// --- Config ---
const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || "";
const provider = process.env.LLM_PROVIDER || (process.env.OPENROUTER_API_KEY ? "openrouter" : process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.GEMINI_API_KEY ? "gemini" : "openai");
const model = process.env.LLM_MODEL || undefined;
const baseUrl = process.env.LLM_BASE_URL || undefined;
const PORT = parseInt(process.env.PORT || "3000");

if (!apiKey) {
  console.error("❌ Set LLM_API_KEY");
  process.exit(1);
}

// --- Initialize ---
const integrationsDir = join(ROOT, "integrations");
const memoryDir = join(ROOT, "memory");
const outputDir = join(ROOT, "output");

const llm = new LLM({ provider, apiKey, model, baseUrl });
const memory = new Memory(memoryDir);
const executor = new Executor();
const bus = new MessageBus();

await memory.init();

const orchestrator = new OrchestratorAgent(llm, bus, memory);
const researcher = new ResearcherAgent(llm);
const writer = new WriterAgent(llm, memory);
const editor = new EditorAgent(llm);
const publisher = new PublisherAgent(executor, integrationsDir, outputDir);
const skillBuilder = new SkillBuilderAgent(llm, executor, integrationsDir);
const socialWriter = new SocialWriterAgent(llm, memory);
const brandManager = new BrandManagerAgent(llm, memory);

await publisher.init();

bus.register(orchestrator);
bus.register(researcher);
bus.register(writer);
bus.register(editor);
bus.register(publisher);
bus.register(skillBuilder);
bus.register(socialWriter);
bus.register(brandManager);

// Load credentials
for (const [key, value] of Object.entries(process.env)) {
  if (value && ["WORDPRESS_", "TWITTER_", "LINKEDIN_", "GITHUB_"].some((p) => key.startsWith(p))) {
    executor.setCredential(key, value);
  }
}

// --- Track jobs ---
interface Job {
  id: string;
  status: "running" | "done" | "error";
  request: string;
  type: string;
  createdAt: string;
  completedAt?: string;
  result?: any;
  error?: string;
  steps: { agent: string; status: string; time?: number }[];
}

const jobs: Map<string, Job> = new Map();

// --- API ---
const app = new Hono();

app.use("/*", cors());

// Serve static UI
app.use("/ui/*", serveStatic({ root: "./public/" }));
app.get("/", (c) => c.redirect("/ui/index.html"));

// Health
app.get("/api/health", (c) =>
  c.json({ status: "ok", agents: bus.listAgentNames(), provider, model })
);

// List agents
app.get("/api/agents", (c) =>
  c.json({
    agents: bus.getAllAgents().map((a) => ({
      name: a.name,
      description: a.description,
      capabilities: a.capabilities,
      version: a.version,
    })),
  })
);

// List integrations
app.get("/api/integrations", async (c) => {
  const msg = createMessage("api", "publisher", "task", { action: "list-platforms", input: {} });
  const result = await bus.send(msg);
  return c.json(result.payload?.output || { platforms: [] });
});

// Generate content (async — returns job ID)
app.post("/api/generate", async (c) => {
  const body = await c.req.json();
  const { topic, type = "blog+social", platforms } = body;

  if (!topic) return c.json({ error: "topic is required" }, 400);

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  let request = "";
  if (type === "blog") {
    request = `Write a blog about: ${topic}`;
  } else if (type === "social") {
    request = `Create social media posts about: ${topic} for Twitter, LinkedIn, Instagram, and Facebook`;
  } else {
    request = `Write a blog about: ${topic}, then create social media posts for Twitter, LinkedIn, Instagram, and Facebook`;
  }

  if (platforms?.length) {
    request += `. Publish to: ${platforms.join(", ")}`;
  }

  const job: Job = {
    id: jobId,
    status: "running",
    request,
    type,
    createdAt: new Date().toISOString(),
    steps: [],
  };
  jobs.set(jobId, job);

  // Run async
  (async () => {
    try {
      const msg = createMessage("api", "orchestrator", "task", {
        action: "orchestrate",
        input: { request },
      });
      const result = await bus.send(msg);

      if (result.type === "result" && result.payload?.output) {
        job.status = "done";
        job.result = result.payload.output;
      } else {
        job.status = "error";
        job.error = result.payload?.message || "Unknown error";
      }
    } catch (err: any) {
      job.status = "error";
      job.error = err.message;
    }
    job.completedAt = new Date().toISOString();
  })();

  return c.json({ jobId, status: "running" });
});

// Get job status/result
app.get("/api/jobs/:id", (c) => {
  const job = jobs.get(c.req.param("id"));
  if (!job) return c.json({ error: "Job not found" }, 404);
  return c.json(job);
});

// List all jobs
app.get("/api/jobs", (c) => {
  const allJobs = Array.from(jobs.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50);
  return c.json({ jobs: allJobs });
});

// List generated content
app.get("/api/content", async (c) => {
  try {
    const files = await readdir(outputDir);
    const content = [];
    for (const file of files.filter((f) => f.endsWith(".md")).sort().reverse()) {
      const text = await readFile(join(outputDir, file), "utf-8");
      const titleMatch = text.match(/title:\s*"([^"]+)"/);
      const dateMatch = text.match(/date:\s*(.+)/);
      content.push({
        filename: file,
        title: titleMatch?.[1] || file,
        date: dateMatch?.[1]?.trim() || "",
        preview: text.slice(0, 500),
        fullContent: text,
      });
    }
    return c.json({ content });
  } catch {
    return c.json({ content: [] });
  }
});

// Get specific content file
app.get("/api/content/:filename", async (c) => {
  try {
    const text = await readFile(join(outputDir, c.req.param("filename")), "utf-8");
    return c.json({ content: text });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

// Build integration
app.post("/api/integrations/build", async (c) => {
  const { service } = await c.req.json();
  if (!service) return c.json({ error: "service is required" }, 400);

  const msg = createMessage("api", "skill-builder", "task", {
    action: "build-integration",
    input: { service },
  });
  const result = await bus.send(msg);
  await publisher.reload();

  return c.json(result.payload);
});

// Brand management
app.get("/api/brand", async (c) => {
  const msg = createMessage("api", "brand-manager", "task", {
    action: "get-brand-context",
    input: { brandName: c.req.query("name") || "default" },
  });
  const result = await bus.send(msg);
  return c.json(result.payload?.output || {});
});

app.post("/api/brand", async (c) => {
  const body = await c.req.json();
  const msg = createMessage("api", "brand-manager", "task", {
    action: "set-brand",
    input: body,
  });
  const result = await bus.send(msg);
  return c.json(result.payload?.output || {});
});

app.post("/api/brand/feedback", async (c) => {
  const body = await c.req.json();
  const msg = createMessage("api", "brand-manager", "task", {
    action: "learn-from-feedback",
    input: body,
  });
  const result = await bus.send(msg);
  return c.json(result.payload?.output || {});
});

app.post("/api/brand/analyze", async (c) => {
  const body = await c.req.json();
  const msg = createMessage("api", "brand-manager", "task", {
    action: "analyze-sample",
    input: body,
  });
  const result = await bus.send(msg);
  return c.json(result.payload?.output || {});
});

// Memory
app.get("/api/memory", (c) => {
  return c.json({ memory: memory.summary() });
});

// --- Start ---
console.log(`\n🌐 ARISE Server running on http://localhost:${PORT}`);
console.log(`   Dashboard: http://localhost:${PORT}/`);
console.log(`   API: http://localhost:${PORT}/api/health\n`);

export default {
  port: PORT,
  fetch: app.fetch,
};
