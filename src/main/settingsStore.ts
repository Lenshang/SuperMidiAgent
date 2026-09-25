/** 应用设置持久化（JSON 文件，原子写入）。不依赖 electron，便于测试。 */
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { ModelProfile, SettingsData } from '../shared/types';

export const DEFAULT_SETTINGS: SettingsData = {
  profiles: [],
  activeProfileId: null,
  mcpServers: [],
  builtinMcpEnabled: true,
  kbTopK: 4,
  agentMaxIterations: 12,
  volume: 0.8,
};

export class SettingsStore {
  private data: SettingsData = { ...DEFAULT_SETTINGS };
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private filePath: string) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      this.data = { ...DEFAULT_SETTINGS };
      await this.flush();
    }
  }

  get(): SettingsData {
    return this.data;
  }

  /** 合并式更新；profiles 等数组整体替换。 */
  update(patch: Partial<SettingsData>): SettingsData {
    this.data = { ...this.data, ...patch };
    this.scheduleSave();
    return this.data;
  }

  upsertProfile(profile: Partial<ModelProfile> & { name: string; baseUrl: string; apiKey: string; model: string }): ModelProfile {
    const id = profile.id ?? randomUUID().slice(0, 8);
    const next: ModelProfile = { ...profile, id };
    const idx = this.data.profiles.findIndex((p) => p.id === id);
    if (idx >= 0) this.data.profiles[idx] = next;
    else this.data.profiles.push(next);
    if (!this.data.activeProfileId) this.data.activeProfileId = id;
    this.scheduleSave();
    return next;
  }

  removeProfile(id: string): void {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    if (this.data.activeProfileId === id) {
      this.data.activeProfileId = this.data.profiles[0]?.id ?? null;
    }
    this.scheduleSave();
  }

  scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 300);
  }

  async flush(): Promise<void> {
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}
