// ARISE — AI Agent System
// Future-proof message bus architecture
// Add agent #N = create a folder, register it. Zero changes to anything else.

import { join } from "path";
import { MessageBus } from "./core/bus";
import { Memory } from "./core/memory";
import { LLM } from "./core/llm";
import { Executor } from "./core/executor";

// Agents
import { OrchestratorAgent } from "./agents/orchestrator";
import { ResearcherAgent } from "./agents/researcher";
import { WriterAgent } from "./agents/writer";
import { EditorAgent } from "./agents/editor";
import { PublisherAgent } from "./agents/publisher";
import { SkillBuilderAgent } from "./agents/skill-builder";

const ROOT = import.meta.dir || __dirname;

async function main() {
  console.log("🚀 ARISE — AI Agent System");
  console.log("Future-proof architecture with message bus\n");

  // --- Config ---
  const apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || "";
  const provider = process.env.LLM_PROVIDER || (process.env.OPENROUTER_API_KEY ? "openrouter" : process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.GEMINI_API_KEY ? "gemini" : "openai");
  const model = process.env.LLM_MODEL || undefined;
  const baseUrl = process.env.LLM_BASE_URL || undefined;

  if (!apiKey) {
    console.error("❌ Set LLM_API_KEY (or OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY)");
    process.exit(1);
  }

  // --- Initialize core ---
  const integrationsDir = join(ROOT, "integrations");
  const memoryDir = join(ROOT, "memory");

  const llm = new LLM({ provider, apiKey, model, baseUrl });
  const memory = new Memory(memoryDir);
  const executor = new Executor();
  const bus = new MessageBus();

  await memory.init();

  // --- Register agents ---
  // To add a new agent: create folder in agents/, import it, register it. Done.
  const orchestrator = new OrchestratorAgent(llm, bus, memory);
  const researcher = new ResearcherAgent(llm);
  const writer = new WriterAgent(llm, memory);
  const editor = new EditorAgent(llm);
  const outputDir = join(ROOT, "output");
  const publisher = new PublisherAgent(executor, integrationsDir, outputDir);

  // Load credentials from environment
  const credentialPrefixes = ["WORDPRESS_", "TWITTER_", "LINKEDIN_", "GITHUB_"];
  for (const [key, value] of Object.entries(process.env)) {
    if (value && credentialPrefixes.some((p) => key.startsWith(p))) {
      executor.setCredential(key, value);
    }
  }
  const skillBuilder = new SkillBuilderAgent(llm, executor, integrationsDir);

  await publisher.init();

  bus.register(orchestrator);
  bus.register(researcher);
  bus.register(writer);
  bus.register(editor);
  bus.register(publisher);
  bus.register(skillBuilder);

  // --- Add logging middleware ---
  bus.use(async (message, next) => {
    const start = Date.now();
    const result = await next();
    const ms = Date.now() - start;
    console.log(`  ⏱️  ${message.from} → ${message.to} (${ms}ms)`);
    return result;
  });

  // --- Handle input ---
  const args = process.argv.slice(2);
  const request = args.join(" ");

  if (!request) {
    console.log("\n📖 Usage:");
    console.log('  bun run index.ts "Write a blog about AI trends"');
    console.log('  bun run index.ts --agents          List all agents');
    console.log('  bun run index.ts --build wordpress  Build an integration');
    console.log('  bun run index.ts --memory           Show memory');
    console.log('  bun run index.ts --integrations     List integrations');
    return;
  }

  // Special commands
  if (request === "--agents") {
    console.log("\n🤖 Registered Agents:\n");
    console.log(bus.describeAll());
    return;
  }

  if (request === "--memory") {
    console.log("\n🧠 Memory:\n");
    console.log(memory.summary());
    return;
  }

  if (request === "--integrations") {
    const { createMessage } = await import("./core/message");
    const msg = createMessage("cli", "publisher", "task", { action: "list-platforms", input: {} });
    const result = await bus.send(msg);
    console.log("\n📤 Available Integrations:\n");
    const platforms = result.payload?.output?.platforms || [];
    console.log(platforms.length ? platforms.join(", ") : "None yet. Use --build <service> to create one.");
    return;
  }

  if (request.startsWith("--build ")) {
    const service = request.replace("--build ", "").trim();
    const { createMessage } = await import("./core/message");
    const msg = createMessage("cli", "skill-builder", "task", {
      action: "build-integration",
      input: { service },
    });
    console.log(`\n🔨 Building integration: ${service}\n`);
    const result = await bus.send(msg);
    if (result.type === "result") {
      console.log(`\n✅ Done! ${result.payload.output.name}`);
      console.log(`   ${result.payload.output.description || ""}`);
    } else {
      console.log(`\n❌ Failed: ${result.payload.message}`);
    }
    return;
  }

  // Regular request → orchestrator handles it
  const { createMessage } = await import("./core/message");
  console.log("─".repeat(50));

  const msg = createMessage("cli", "orchestrator", "task", {
    action: "orchestrate",
    input: { request },
  });

  const result = await bus.send(msg);

  console.log("\n" + "─".repeat(50));
  if (result.type === "result" && result.payload?.output) {
    const output = result.payload.output;
    console.log("\n📄 RESULT:\n");
    if (output.title) console.log(`Title: ${output.title}\n`);
    console.log(output.finalContent || JSON.stringify(output, null, 2));
    console.log("\n📊 Steps:");
    console.log(output.summary);
  } else {
    console.log("\n❌ Error:", result.payload?.message || "Unknown error");
  }
}

main().catch(console.error);
