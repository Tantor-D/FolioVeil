import type { ThemeSlot, ThemeTemplate } from '../packages/theme-chatgpt/src/template-contract';
export const REQUIRED_SLOTS: ThemeSlot[];
export interface CompiledTheme extends ThemeTemplate { assets: Record<string, string> }
export function compileCapture(capture: unknown): CompiledTheme;
export function packageFiles(template: CompiledTheme): Record<string, string>;
export function sanitizeCSS(input: unknown): Record<string, string>;
export function sanitizeSVG(raw: unknown): string;
export function stableJSON(value: unknown): string;
