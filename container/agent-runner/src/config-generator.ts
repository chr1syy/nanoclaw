/**
 * OpenCode Configuration Generator
 *
 * Reads opencode.json.template and substitutes ${VAR} placeholders
 * with actual environment variable values. Writes the result to
 * /workspace/.opencode.json which OpenCode reads as project config.
 *
 * This should be run before starting the OpenCode server.
 */

import fs from 'fs';
import path from 'path';

/**
 * Default paths for config template and output
 */
const DEFAULT_TEMPLATE_PATH = '/app/opencode.json.template';
const DEFAULT_OUTPUT_PATH = '/workspace/.opencode.json';

/**
 * Regex to match ${VAR_NAME} placeholders
 */
const PLACEHOLDER_REGEX = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface GenerateConfigOptions {
  /** Path to the template file */
  templatePath?: string;
  /** Path to write the generated config */
  outputPath?: string;
  /** Additional environment variables to use (overrides process.env) */
  env?: Record<string, string | undefined>;
}

/**
 * Substitute ${VAR} placeholders in a string with environment values.
 *
 * @param content - String containing ${VAR} placeholders
 * @param env - Environment variables to use for substitution
 * @returns String with placeholders replaced by env values (empty string if not set)
 */
export function substituteEnvVars(
  content: string,
  env: Record<string, string | undefined> = process.env
): string {
  return content.replace(PLACEHOLDER_REGEX, (match, varName) => {
    const value = env[varName];
    if (value === undefined) {
      // Log warning but return empty string to avoid breaking JSON
      console.warn(`[config-generator] Warning: Environment variable ${varName} is not set`);
      return '';
    }
    return value;
  });
}

/**
 * Generate OpenCode config from template.
 *
 * Reads the template file, substitutes environment variables,
 * validates the result is valid JSON, and writes to output path.
 *
 * @param options - Configuration options
 * @returns The generated config object
 * @throws Error if template is missing or result is invalid JSON
 */
export function generateConfig(options: GenerateConfigOptions = {}): Record<string, unknown> {
  const templatePath = options.templatePath ?? DEFAULT_TEMPLATE_PATH;
  const outputPath = options.outputPath ?? DEFAULT_OUTPUT_PATH;
  const env = { ...process.env, ...options.env };

  // Read template
  if (!fs.existsSync(templatePath)) {
    throw new Error(`OpenCode template not found at ${templatePath}`);
  }
  const template = fs.readFileSync(templatePath, 'utf-8');

  // Substitute environment variables
  const configContent = substituteEnvVars(template, env);

  // Validate JSON
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(configContent);
  } catch (err) {
    throw new Error(
      `Generated config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });

  // Write config
  fs.writeFileSync(outputPath, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`[config-generator] Wrote OpenCode config to ${outputPath}`);

  return config;
}

/**
 * CLI entry point
 * Can be run as: node config-generator.js [templatePath] [outputPath]
 */
export function main(): void {
  const args = process.argv.slice(2);
  const templatePath = args[0] || DEFAULT_TEMPLATE_PATH;
  const outputPath = args[1] || DEFAULT_OUTPUT_PATH;

  try {
    generateConfig({ templatePath, outputPath });
    console.log('[config-generator] Config generation complete');
  } catch (err) {
    console.error(`[config-generator] Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Run if executed directly
if (process.argv[1]?.endsWith('config-generator.js')) {
  main();
}
