import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export class EventState {
  constructor(filePath) {
    this.filePath = filePath;
    this.processed = new Set();
    this.load();
  }

  load() {
    if (existsSync(this.filePath)) {
      try {
        const data = JSON.parse(readFileSync(this.filePath, 'utf8'));
        this.processed = new Set(data.events || []);
      } catch {
        this.processed = new Set();
      }
    }
  }

  has(fingerprint) {
    return this.processed.has(fingerprint);
  }

  add(fingerprint) {
    this.processed.add(fingerprint);
    this.save();
  }

  remove(fingerprint) {
    this.processed.delete(fingerprint);
    this.save();
  }

  save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify({ events: [...this.processed], lastUpdated: new Date().toISOString() }, null, 2)
    );
  }

  // Remove fingerprints for events more than 90 days in the past
  purgeOld() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    let changed = false;
    for (const fp of this.processed) {
      const datePart = fp.split('|')[3]; // 'YYYY-MM-DD'
      if (datePart && new Date(datePart) < cutoff) {
        this.processed.delete(fp);
        changed = true;
      }
    }
    if (changed) this.save();
  }
}
