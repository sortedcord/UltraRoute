import type { IWebSessionProvider } from "../shared/baseAdapter.ts";

export class ProviderRegistry {
  private readonly providers = new Map<string, IWebSessionProvider>();

  register(provider: IWebSessionProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(providerId: string): IWebSessionProvider | undefined {
    return this.providers.get(providerId);
  }

  list(): IWebSessionProvider[] {
    return Array.from(this.providers.values());
  }
}

export const globalProviderRegistry = new ProviderRegistry();
