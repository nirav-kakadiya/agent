// Tenant — multi-tenant system
// Each tenant = a brand/client with own config, memory, credentials, and content

import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { Memory } from "./memory";
import { Executor } from "./executor";

export interface TenantConfig {
  id: string;
  name: string;
  slug: string;                     // url-friendly name
  brand: {
    voice: string;
    tone: string;
    audience: string;
    industry: string;
    keywords: string[];
    avoidWords: string[];
  };
  platforms: {                       // per-tenant platform credentials
    wordpress?: Record<string, string>;
    twitter?: Record<string, string>;
    linkedin?: Record<string, string>;
    medium?: Record<string, string>;
    devto?: Record<string, string>;
  };
  settings: {
    defaultType: "blog+social" | "blog" | "social";
    defaultModel?: string;
    autoPublish: boolean;            // auto-publish or save as draft
    platforms: string[];             // which platforms to publish to by default
  };
  createdAt: string;
  updatedAt: string;
}

export class TenantManager {
  private tenants: Map<string, TenantConfig> = new Map();
  private dataDir: string;
  private memories: Map<string, Memory> = new Map();
  private executors: Map<string, Executor> = new Map();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    await this.loadTenants();
    console.log(`👥 Tenants: ${this.tenants.size} loaded`);
  }

  private async loadTenants() {
    const filePath = join(this.dataDir, "tenants.json");
    try {
      const data = await readFile(filePath, "utf-8");
      const tenants: TenantConfig[] = JSON.parse(data);
      for (const t of tenants) {
        this.tenants.set(t.id, t);
        await this.initTenantResources(t);
      }
    } catch {}
  }

  private async saveTenants() {
    const filePath = join(this.dataDir, "tenants.json");
    await writeFile(filePath, JSON.stringify(Array.from(this.tenants.values()), null, 2));
  }

  private async initTenantResources(tenant: TenantConfig) {
    // Each tenant gets own memory
    const memDir = join(this.dataDir, tenant.id, "memory");
    const mem = new Memory(memDir);
    await mem.init();
    this.memories.set(tenant.id, mem);

    // Each tenant gets own executor with their credentials
    const exec = new Executor();
    const platforms = tenant.platforms || {};
    for (const [platform, creds] of Object.entries(platforms)) {
      for (const [key, value] of Object.entries(creds)) {
        exec.setCredential(key, value);
      }
    }
    this.executors.set(tenant.id, exec);

    // Create tenant output dir
    await mkdir(join(this.dataDir, tenant.id, "output"), { recursive: true });
  }

  // Create a new tenant
  async create(config: Partial<TenantConfig> & { name: string }): Promise<TenantConfig> {
    const id = `tenant_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const slug = config.slug || config.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const tenant: TenantConfig = {
      id,
      name: config.name,
      slug,
      brand: {
        voice: config.brand?.voice || "professional yet approachable",
        tone: config.brand?.tone || "authoritative but friendly",
        audience: config.brand?.audience || "general",
        industry: config.brand?.industry || "technology",
        keywords: config.brand?.keywords || [],
        avoidWords: config.brand?.avoidWords || [],
      },
      platforms: config.platforms || {},
      settings: {
        defaultType: config.settings?.defaultType || "blog+social",
        defaultModel: config.settings?.defaultModel,
        autoPublish: config.settings?.autoPublish ?? false,
        platforms: config.settings?.platforms || ["local-file"],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.tenants.set(id, tenant);
    await this.initTenantResources(tenant);
    await this.saveTenants();

    // Store brand in tenant memory
    const mem = this.memories.get(id)!;
    await mem.set("brand_voice", tenant.brand.voice, "brand-manager", ["brand"]);
    await mem.set("brand_tone", tenant.brand.tone, "brand-manager", ["brand"]);
    await mem.set("brand_audience", tenant.brand.audience, "brand-manager", ["brand"]);
    await mem.set(`brand:${slug}`, tenant.brand, "brand-manager", ["brand"]);

    console.log(`👥 Tenant created: ${tenant.name} (${id})`);
    return tenant;
  }

  // Update tenant
  async update(id: string, updates: Partial<TenantConfig>): Promise<TenantConfig | null> {
    const tenant = this.tenants.get(id);
    if (!tenant) return null;

    if (updates.name) tenant.name = updates.name;
    if (updates.brand) tenant.brand = { ...tenant.brand, ...updates.brand };
    if (updates.platforms) {
      tenant.platforms = { ...tenant.platforms, ...updates.platforms };
      // Reinit executor with new creds
      await this.initTenantResources(tenant);
    }
    if (updates.settings) tenant.settings = { ...tenant.settings, ...updates.settings };
    tenant.updatedAt = new Date().toISOString();

    await this.saveTenants();
    return tenant;
  }

  // Delete tenant
  async delete(id: string): Promise<boolean> {
    const deleted = this.tenants.delete(id);
    this.memories.delete(id);
    this.executors.delete(id);
    if (deleted) await this.saveTenants();
    return deleted;
  }

  // Get tenant
  get(id: string): TenantConfig | undefined {
    return this.tenants.get(id);
  }

  // Find by slug
  getBySlug(slug: string): TenantConfig | undefined {
    return Array.from(this.tenants.values()).find((t) => t.slug === slug);
  }

  // List all tenants
  list(): TenantConfig[] {
    return Array.from(this.tenants.values());
  }

  // Get tenant's memory
  getMemory(tenantId: string): Memory | undefined {
    return this.memories.get(tenantId);
  }

  // Get tenant's executor
  getExecutor(tenantId: string): Executor | undefined {
    return this.executors.get(tenantId);
  }

  // Get tenant's output dir
  getOutputDir(tenantId: string): string {
    return join(this.dataDir, tenantId, "output");
  }

  // Get brand guidelines for a tenant (formatted for LLM)
  getBrandGuidelines(tenantId: string): string {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return "";

    let g = `## Brand Writing Guidelines — ${tenant.name}\n\n`;
    g += `**Voice:** ${tenant.brand.voice}\n`;
    g += `**Tone:** ${tenant.brand.tone}\n`;
    g += `**Target Audience:** ${tenant.brand.audience}\n`;
    g += `**Industry:** ${tenant.brand.industry}\n`;

    if (tenant.brand.keywords.length) {
      g += `**Include keywords:** ${tenant.brand.keywords.join(", ")}\n`;
    }
    if (tenant.brand.avoidWords.length) {
      g += `**NEVER use:** ${tenant.brand.avoidWords.join(", ")}\n`;
    }

    // Add learnings from memory
    const mem = this.memories.get(tenantId);
    if (mem) {
      const learnings = mem.byAgent("brand-manager");
      if (learnings.length) {
        g += `\n**Learned preferences:**\n`;
        learnings.slice(-10).forEach((l) => { g += `- ${l.key}: ${l.value}\n`; });
      }
    }

    return g;
  }
}
