// Analytics Agent — tracks content performance and provides insights
// Learns what topics, styles, and platforms perform best

import { BaseAgent } from "../../core/agent";
import { createMessage, type Message, type TaskPayload, type ResultPayload } from "../../core/message";
import type { Memory } from "../../core/memory";

export interface ContentMetrics {
  id: string;
  title: string;
  topic: string;
  createdAt: string;
  platforms: string[];
  metrics: {
    [platform: string]: {
      views?: number;
      likes?: number;
      shares?: number;
      comments?: number;
      clicks?: number;
      impressions?: number;
      engagement?: number;
      updatedAt: string;
    };
  };
  tags: string[];
}

export class AnalyticsAgent extends BaseAgent {
  private memory: Memory;

  constructor(memory: Memory) {
    super({
      name: "analytics",
      description: "Tracks content performance, provides insights, and learns what works best",
      version: "1.0.0",
      capabilities: [
        {
          name: "track",
          description: "Record metrics for a piece of content",
          inputSchema: { contentId: "string", platform: "string", metrics: "object" },
          outputSchema: { tracked: "boolean" },
        },
        {
          name: "report",
          description: "Get performance report for recent content",
          inputSchema: { days: "number?", platform: "string?" },
          outputSchema: { report: "object" },
        },
        {
          name: "insights",
          description: "Get insights on what content performs best",
          inputSchema: {},
          outputSchema: { insights: "string[]" },
        },
        {
          name: "top-content",
          description: "Get top performing content",
          inputSchema: { limit: "number?", metric: "string?" },
          outputSchema: { content: "object[]" },
        },
      ],
    });
    this.memory = memory;
  }

  async handle(message: Message): Promise<Message> {
    const task = message.payload as TaskPayload;
    const action = task.action;

    if (action === "track") return this.track(message, task);
    if (action === "report") return this.report(message, task);
    if (action === "insights") return this.getInsights(message);
    if (action === "top-content") return this.topContent(message, task);

    return createMessage(this.name, message.from, "error", {
      code: "UNKNOWN_ACTION", message: `Unknown: ${action}`, retryable: false,
    }, message.id);
  }

  private async track(message: Message, task: TaskPayload): Promise<Message> {
    const { contentId, platform, metrics, title, topic, tags } = task.input;
    const key = `metrics:${contentId}`;

    let existing: ContentMetrics = this.memory.get(key) || {
      id: contentId,
      title: title || contentId,
      topic: topic || "",
      createdAt: new Date().toISOString(),
      platforms: [],
      metrics: {},
      tags: tags || [],
    };

    // Update metrics for platform
    existing.metrics[platform] = {
      ...(existing.metrics[platform] || {}),
      ...metrics,
      updatedAt: new Date().toISOString(),
    };

    if (!existing.platforms.includes(platform)) {
      existing.platforms.push(platform);
    }

    // Calculate engagement rate
    const m = existing.metrics[platform];
    if (m.views && m.views > 0) {
      m.engagement = ((m.likes || 0) + (m.comments || 0) + (m.shares || 0)) / m.views * 100;
    }

    await this.memory.set(key, existing, this.name, ["metrics", platform, ...(tags || [])]);

    return createMessage(this.name, message.from, "result", {
      success: true,
      output: { tracked: true, contentId, platform },
    } satisfies ResultPayload, message.id);
  }

  private async report(message: Message, task: TaskPayload): Promise<Message> {
    const days = task.input.days || 30;
    const platform = task.input.platform;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    const allMetrics = this.memory.search("metrics:").filter((e) => {
      const m = e.value as ContentMetrics;
      return m.createdAt >= cutoff;
    });

    let totalViews = 0, totalLikes = 0, totalShares = 0, totalComments = 0;
    let contentCount = allMetrics.length;

    for (const entry of allMetrics) {
      const m = entry.value as ContentMetrics;
      for (const [p, stats] of Object.entries(m.metrics)) {
        if (platform && p !== platform) continue;
        totalViews += stats.views || 0;
        totalLikes += stats.likes || 0;
        totalShares += stats.shares || 0;
        totalComments += stats.comments || 0;
      }
    }

    const avgEngagement = totalViews > 0 ? ((totalLikes + totalComments + totalShares) / totalViews * 100).toFixed(2) : 0;

    return createMessage(this.name, message.from, "result", {
      success: true,
      output: {
        period: `Last ${days} days`,
        platform: platform || "all",
        contentCount,
        totalViews,
        totalLikes,
        totalShares,
        totalComments,
        avgEngagement: `${avgEngagement}%`,
        topPlatform: this.getTopPlatform(allMetrics),
      },
    } satisfies ResultPayload, message.id);
  }

  private async getInsights(message: Message): Promise<Message> {
    const allMetrics = this.memory.search("metrics:");
    const insights: string[] = [];

    if (allMetrics.length === 0) {
      insights.push("No content tracked yet. Start generating and tracking to get insights!");
      return createMessage(this.name, message.from, "result", {
        success: true, output: { insights },
      } satisfies ResultPayload, message.id);
    }

    // Find best performing topics
    const topicPerformance = new Map<string, { views: number; engagement: number; count: number }>();
    for (const entry of allMetrics) {
      const m = entry.value as ContentMetrics;
      if (!m.topic) continue;
      const existing = topicPerformance.get(m.topic) || { views: 0, engagement: 0, count: 0 };
      for (const stats of Object.values(m.metrics)) {
        existing.views += stats.views || 0;
        existing.engagement += stats.engagement || 0;
      }
      existing.count++;
      topicPerformance.set(m.topic, existing);
    }

    // Sort by engagement
    const sortedTopics = Array.from(topicPerformance.entries())
      .sort((a, b) => b[1].engagement - a[1].engagement);

    if (sortedTopics.length > 0) {
      insights.push(`📈 Best performing topic: "${sortedTopics[0][0]}" with ${sortedTopics[0][1].views} total views`);
    }

    // Platform comparison
    const platformStats = new Map<string, { views: number; engagement: number }>();
    for (const entry of allMetrics) {
      const m = entry.value as ContentMetrics;
      for (const [p, stats] of Object.entries(m.metrics)) {
        const existing = platformStats.get(p) || { views: 0, engagement: 0 };
        existing.views += stats.views || 0;
        existing.engagement += stats.engagement || 0;
        platformStats.set(p, existing);
      }
    }

    const bestPlatform = Array.from(platformStats.entries()).sort((a, b) => b[1].engagement - a[1].engagement)[0];
    if (bestPlatform) {
      insights.push(`🏆 Best platform: ${bestPlatform[0]} (highest engagement)`);
    }

    insights.push(`📊 Total content tracked: ${allMetrics.length} pieces`);
    insights.push(`💡 Tip: Track metrics regularly to improve content strategy`);

    return createMessage(this.name, message.from, "result", {
      success: true, output: { insights },
    } satisfies ResultPayload, message.id);
  }

  private async topContent(message: Message, task: TaskPayload): Promise<Message> {
    const limit = task.input.limit || 5;
    const metric = task.input.metric || "views";

    const allMetrics = this.memory.search("metrics:");

    const scored = allMetrics.map((entry) => {
      const m = entry.value as ContentMetrics;
      let score = 0;
      for (const stats of Object.values(m.metrics)) {
        score += (stats as any)[metric] || 0;
      }
      return { ...m, score };
    }).sort((a, b) => b.score - a.score).slice(0, limit);

    return createMessage(this.name, message.from, "result", {
      success: true,
      output: {
        content: scored.map((c) => ({
          title: c.title,
          topic: c.topic,
          platforms: c.platforms,
          score: c.score,
          metric,
        })),
      },
    } satisfies ResultPayload, message.id);
  }

  private getTopPlatform(metrics: any[]): string {
    const platformViews = new Map<string, number>();
    for (const entry of metrics) {
      const m = entry.value as ContentMetrics;
      for (const [p, stats] of Object.entries(m.metrics)) {
        platformViews.set(p, (platformViews.get(p) || 0) + ((stats as any).views || 0));
      }
    }
    const sorted = Array.from(platformViews.entries()).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0] || "none";
  }
}
