import { type Page, type TestInfo, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export interface Verification {
  spec: string;
  check: () => Promise<void>;
}

export interface StepOptions {
  description: string;
  verifications: Verification[];
  networkStatus?: 'synced' | 'offline' | 'error' | 'skip';
}

interface DocStep {
  title: string;
  image: string;
  specs: string[];
}

export class TestStepHelper {
  private stepCount = 0;
  private steps: DocStep[] = [];

  constructor(
    private page: Page,
    private testInfo: TestInfo
  ) {}

  setMetadata(_title: string, _description: string) {
    // Reserved for generated doc headers once scenario metadata is needed.
  }

  async step(id: string, options: StepOptions) {
    for (const verification of options.verifications) {
      await verification.check();
    }

    const paddedIndex = String(this.stepCount++).padStart(3, '0');
    const filename = `${paddedIndex}-${id.replace(/_/g, '-')}.png`;

    const networkStatus = this.page.locator('button[data-status]:visible');
    const expectedStatus = options.networkStatus ?? 'synced';
    if (expectedStatus !== 'skip') {
      const statusVisible = await networkStatus
        .first()
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);
      if (statusVisible) {
        await expect(networkStatus.first()).toHaveAttribute('data-status', expectedStatus, {
          timeout: 30000
        });
      }
    }

    const toggleIcons = this.page.locator('img[alt="Toggle Details"]');
    if ((await toggleIcons.count()) > 0) {
      await this.page.waitForFunction(
        () => {
          const icons = Array.from(
            document.querySelectorAll<HTMLImageElement>('img[alt="Toggle Details"]')
          );
          return icons.every((img) => img.complete && img.naturalWidth > 0);
        },
        { timeout: 30000 }
      );
    }

    await expect(this.page).toHaveScreenshot(filename.replace(/\.png$/, ''));

    this.steps.push({
      title: options.description,
      image: `./screenshots/${filename}`,
      specs: options.verifications.map((verification) => verification.spec)
    });
  }

  generateDocs() {
    const docPath = path.join(path.dirname(this.testInfo.file), 'README.md');
    let content = `# Test: ${this.testInfo.title}\n\n`;

    for (const step of this.steps) {
      content += `## ${step.title}\n\n`;
      content += `![${step.title}](${step.image})\n\n`;
      content += '**Verifications:**\n';
      for (const spec of step.specs) {
        content += `- [x] ${spec}\n`;
      }
      content += '\n---\n\n';
    }

    fs.writeFileSync(docPath, content);
  }
}
