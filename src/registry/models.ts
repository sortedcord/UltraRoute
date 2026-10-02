import type { WebProviderCapabilities } from "../shared/types.ts";

export interface ModelDescriptor {
  id: string;
  name: string;
  providerId: string;
  aliases: readonly string[];
  capabilities: WebProviderCapabilities;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export class ModelRegistry {
  private readonly models = new Map<string, ModelDescriptor>();
  private readonly aliasMap = new Map<string, string>();

  register(model: ModelDescriptor): void {
    this.models.set(model.id, model);
    for (const alias of model.aliases) {
      this.aliasMap.set(alias.toLowerCase(), model.id);
    }
    this.aliasMap.set(model.id.toLowerCase(), model.id);
  }

  resolve(idOrAlias: string): ModelDescriptor | undefined {
    const canonicalId = this.aliasMap.get(idOrAlias.toLowerCase()) ?? idOrAlias;
    return this.models.get(canonicalId);
  }

  listByProvider(providerId: string): ModelDescriptor[] {
    return Array.from(this.models.values()).filter((m) => m.providerId === providerId);
  }

  listAll(): ModelDescriptor[] {
    return Array.from(this.models.values());
  }
}

export const globalModelRegistry = new ModelRegistry();
