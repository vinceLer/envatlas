#!/usr/bin/env node
import * as fs from 'fs/promises';
import * as path from 'path';

// Target directory to analyze (defaulting to current directory or command-line argument)
const args = process.argv.slice(2);

let targetDirArg: string | null = null;
let targetEnvFile: string | null = null;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--env') {
    targetEnvFile = args[i + 1] || null;
    i++; // Skip the .env file value
  } else if (!arg.startsWith('--')) {
    if (!targetDirArg) {
      targetDirArg = arg;
    }
  }
}

const targetDir = targetDirArg ? path.resolve(targetDirArg) : process.cwd();

// Checks user options
const generateReportFile = args.includes('--report');
const autoFix = args.includes('--fix') || args.includes('--update');

// File extensions to analyze
const VALID_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

interface EnvUsage {
  files: string[];
  defaultValue?: string;
}

/**
 * Loads and parses the .gitignore file if it exists, returning a matcher function.
 */
async function loadIgnoreMatcher(dir: string): Promise<(relativePath: string) => boolean> {
  const defaultIgnores = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage'];
  let ignorePatterns = [...defaultIgnores];

  try {
    const gitignorePath = path.join(dir, '.gitignore');
    const content = await fs.readFile(gitignorePath, 'utf-8');
    const parsed = content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));

    if (parsed.length > 0) {
      ignorePatterns = Array.from(new Set([...defaultIgnores, ...parsed]));
    }
  } catch {
    // .gitignore not found, default patterns remain active
  }

  return (relativePath: string) => {
    const normalized = relativePath.split(path.sep).join('/');
    const segments = normalized.split('/');

    for (const pattern of ignorePatterns) {
      const clean = pattern.replace(/\/$/, '').replace(/^\//, '');
      if (segments.includes(clean) || normalized.startsWith(clean + '/')) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Removes single-line and multi-line comments from JS/TS source code.
 */
function removeComments(content: string): string {
  return content
    // Remove multi-line comments /* ... */
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove single-line comments // ... (avoiding URLs like http://)
    .replace(/(^|[^:])\/\/.*/g, '$1');
}

/**
 * Recursively traverses a directory to find all source files asynchronously.
 */
async function walkDir(dir: string, baseDir: string, isIgnored: (path: string) => boolean, fileList: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (isIgnored(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      await walkDir(fullPath, baseDir, isIgnored, fileList);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (VALID_EXTENSIONS.includes(ext)) {
        fileList.push(fullPath);
      }
    }
  }

  return fileList;
}

/**
 * Extracts process.env and import.meta.env variables and their fallback defaults if present.
 */
function extractEnvVariables(content: string): Map<string, string | undefined> {
  const envMap = new Map<string, string | undefined>();

  // Matches process.env.VAR || 'default' or process.env['VAR'] ?? 3000, etc.
  const regex = /\b(?:process\.env|import\.meta\.env)(?:\.([A-Za-z0-9_]+)|\[(['"])([A-Za-z0-9_]+)\2\])(?:\s*(?:\|\||\?\?)\s*([^;\)\}\n]+))?/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    const variableName = match[1] || match[3];
    let defaultValue = match[4] ? match[4].trim() : undefined;

    // Clean up quotes around default value if present
    if (defaultValue && /^(['"`])(.*)\1$/.test(defaultValue)) {
      defaultValue = defaultValue.replace(/^(['"`])(.*)\1$/, '$2');
    }

    if (variableName) {
      // Keep existing default or assign new one
      if (!envMap.has(variableName) || !envMap.get(variableName)) {
        envMap.set(variableName, defaultValue);
      }
    }
  }

  return envMap;
}

interface EnvFileStats {
  fileName: string;
  filePath: string;
  vars: Map<string, string>; // name -> value
}

/**
 * Loads and parses all .env* files found or a specific targeted file.
 */
async function loadAllEnvFiles(dir: string, specificFile?: string | null): Promise<EnvFileStats[]> {
  const results: EnvFileStats[] = [];
  let filesToScan: string[] = [];

  if (specificFile) {
    filesToScan = [specificFile];
  } else {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    filesToScan = entries
      .filter(e => e.isFile() && e.name.startsWith('.env'))
      .map(e => e.name);
  }

  for (const fileName of filesToScan) {
    try {
      const filePath = path.join(dir, fileName);
      const content = await fs.readFile(filePath, 'utf-8');
      const envVars = new Map<string, string>();

      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const match = trimmed.match(/^([A-Za-z0-9_]+)=(.*)$/);
        if (match) {
          let val = match[2].trim();
          // Remove wrapping quotes if any
          if (/^(['"`])(.*)\1$/.test(val)) {
            val = val.replace(/^(['"`])(.*)\1$/, '$2');
          }
          envVars.set(match[1], val);
        }
      }

      results.push({ fileName, filePath, vars: envVars });
    } catch {
      // File not found or unreadable, ignore
    }
  }

  return results;
}

/**
 * Lightweight type/format validation rules without external dependencies.
 */
function validateEnvFormat(varName: string, value: string): string | null {
  const upper = varName.toUpperCase();

  // URL Validation
  if ((upper.includes('URL') || upper.includes('URI')) && value !== '') {
    try {
      new URL(value);
    } catch {
      return `Invalid format: expects a valid URL (e.g., https://...)`;
    }
  }

  // Port Validation (Numbers between 1 and 65535)
  if (upper.includes('PORT') && value !== '') {
    const port = Number(value);
    if (isNaN(port) || port <= 0 || port > 65535) {
      return `Invalid format: expects a valid port number (1-65535)`;
    }
  }

  // Boolean Validation
  if ((upper.startsWith('IS_') || upper.startsWith('ENABLE_') || upper.startsWith('USE_')) && value !== '') {
    if (!['true', 'false', '1', '0'].includes(value.toLowerCase())) {
      return `Invalid format: expects a boolean (true/false/1/0)`;
    }
  }

  return null;
}

async function main() {
  const outputLines: string[] = [];

  const logAndCollect = (message: string = '') => {
    console.log(message);
    outputLines.push(message);
  };

  logAndCollect(`\n🔍 Analyzing directory: ${targetDir}...\n`);

  try {
    const stats = await fs.stat(targetDir);
    if (!stats.isDirectory()) {
      console.error(`❌ Error: The path ${targetDir} is not a valid directory.`);
      process.exit(1);
    }
  } catch {
    console.error(`❌ Error: The directory ${targetDir} does not exist.`);
    process.exit(1);
  }

  const isIgnored = await loadIgnoreMatcher(targetDir);
  const files = await walkDir(targetDir, targetDir, isIgnored);
  const allEnvVars = new Map<string, EnvUsage>();

  const fileAnalysisResults = await Promise.all(
    files.map(async (filePath) => {
      const rawContent = await fs.readFile(filePath, 'utf-8');

      // 🧹 Remove comments to avoid false positives
      const cleanContent = removeComments(rawContent);

      const varsMap = extractEnvVariables(cleanContent);
      const relativePath = path.relative(targetDir, filePath);
      return { relativePath, varsMap };
    })
  );

  for (const { relativePath, varsMap } of fileAnalysisResults) {
    for (const [v, defaultVal] of varsMap.entries()) {
      if (!allEnvVars.has(v)) {
        allEnvVars.set(v, { files: [], defaultValue: defaultVal });
      }
      const usage = allEnvVars.get(v)!;
      usage.files.push(relativePath);
      if (!usage.defaultValue && defaultVal) {
        usage.defaultValue = defaultVal;
      }
    }
  }

  const sortedVars = Array.from(allEnvVars.keys()).sort();

  logAndCollect(`📊 Result: ${sortedVars.length} process.env variable(s) found:\n`);
  logAndCollect('='.repeat(50));

  for (const v of sortedVars) {
    const usage = allEnvVars.get(v)!;
    logAndCollect(`🔹 ${v}${usage.defaultValue !== undefined ? ` (Default value: "${usage.defaultValue}")` : ''}`);
    logAndCollect(`    Used in (${usage.files.length} file(s)):`);
    usage.files.forEach((f) => logAndCollect(`      - ${f}`));
    logAndCollect('-'.repeat(50));
  }

  const envFilesData = await loadAllEnvFiles(targetDir, targetEnvFile);

  if (envFilesData.length > 0) {
    logAndCollect(`\n📂 Multi-Environment Analysis & Validation:`);
    logAndCollect('='.repeat(50));

    for (const envData of envFilesData) {
      logAndCollect(`\n🔹 File: ${envData.fileName}`);

      const missingInEnv = sortedVars.filter(v => !envData.vars.has(v));
      const unusedInCode = Array.from(envData.vars.keys()).filter(v => !allEnvVars.has(v)).sort();

      if (missingInEnv.length > 0) {
        logAndCollect(`   ⚠️  Missing in ${envData.fileName} (${missingInEnv.length}):`);
        missingInEnv.forEach(v => {
          const def = allEnvVars.get(v)?.defaultValue;
          logAndCollect(`      - ${v}${def !== undefined ? ` (Code default: ${def})` : ''}`);
        });
      } else {
        logAndCollect(`   ✅ All code variables are present in ${envData.fileName}.`);
      }

      if (unusedInCode.length > 0) {
        logAndCollect(`   ℹ️  Declared in ${envData.fileName} but unused in code (${unusedInCode.length}):`);
        unusedInCode.forEach(v => logAndCollect(`      - ${v}`));
      }

      // Format/Type Validation
      let formatErrorsCount = 0;
      for (const [v, val] of envData.vars.entries()) {
        const errorMsg = validateEnvFormat(v, val);
        if (errorMsg) {
          if (formatErrorsCount === 0) {
            logAndCollect(`   ❌ Format errors detected:`);
          }
          logAndCollect(`      - ${v}="${val}" -> ${errorMsg}`);
          formatErrorsCount++;
        }
      }
      if (formatErrorsCount === 0) {
        logAndCollect(`   ✅ Format and type validation passed.`);
      }
    }
    logAndCollect('='.repeat(50));
  } else {
    logAndCollect(`\nℹ️  No environment file (.env*) found for comparison.`);
  }

  if (autoFix) {
    const targetFileStats = envFilesData.find(e => e.fileName === targetEnvFile) || envFilesData[0];
    const targetFileToUpdate = targetFileStats ? targetFileStats.filePath : path.join(targetDir, '.env.example');
    const targetNameToDisplay = targetFileStats ? targetFileStats.fileName : '.env.example';

    const currentEnvVarsSet = targetFileStats ? targetFileStats.vars : new Map<string, string>();
    const varsToAdd = sortedVars.filter(v => !currentEnvVarsSet.has(v));

    if (varsToAdd.length > 0) {
      const missingWithDefaults = varsToAdd.map(v => {
        const def = allEnvVars.get(v)?.defaultValue;
        return { name: v, defaultValue: def };
      });
      await appendMissingVarsWithDefaults(targetFileToUpdate, missingWithDefaults);
      console.log(`\n🛠️  Success: ${targetNameToDisplay} has been updated with${varsToAdd.length} missing variable(s)!`);
    } else {
      console.log(`\n✨ ${targetNameToDisplay} is already up to date.`);
    }
  }

  await generateEnvTemplate(sortedVars, allEnvVars, targetDir);

  if (generateReportFile) {
    const vaDir = path.join(targetDir, 'vA');
    await fs.mkdir(vaDir, { recursive: true });

    // 1. Generate and write TXT report
    const reportPathTxt = path.join(vaDir, '.envatlas-report.txt');
    await fs.writeFile(reportPathTxt, outputLines.join('\n'), 'utf-8');
    console.log(`\n📄 TXT report generated: ${reportPathTxt}`);

    // 2. Generate and write modern Markdown report (.md)
    const markdownContent = generateMarkdownReport(targetDir, sortedVars, allEnvVars, envFilesData);
    const reportPathMd = path.join(vaDir, '.envatlas-report.md');
    await fs.writeFile(reportPathMd, markdownContent, 'utf-8');
    console.log(`✨ Modern Markdown report generated: ${reportPathMd}`);
  }
}

async function appendMissingVarsWithDefaults(filePath: string, vars: { name: string; defaultValue?: string }[]) {
  if (vars.length === 0) return;

  const addition = `\n# Added automatically on ${new Date().toISOString().split('T')[0]}\n` +
    vars.map(v => `${v.name}=${v.defaultValue !== undefined ? v.defaultValue : ''}`).join('\n') + '\n';

  await fs.appendFile(filePath, addition, 'utf-8');
}

async function generateEnvTemplate(vars: string[], allEnvVars: Map<string, EnvUsage>, targetDir: string) {
  const templateContent = vars.map((v) => {
    const usage = allEnvVars.get(v);
    const comment = usage?.defaultValue !== undefined ? ` # Default: ${usage.defaultValue}` : '';
    return `${v}=${comment}`;
  }).join('\n') + '\n';

  const vaDir = path.join(targetDir, 'vA');
  await fs.mkdir(vaDir, { recursive: true });

  const outputPath = path.join(vaDir, '.env.atlas.template');
  await fs.writeFile(outputPath, templateContent, 'utf-8');
  console.log(`✨ File generated successfully: ${outputPath}`);
}

/**
 * Generates the report content in a modern, readable Markdown format.
 */
function generateMarkdownReport(
  targetDir: string,
  sortedVars: string[],
  allEnvVars: Map<string, EnvUsage>,
  envFilesData: EnvFileStats[]
): string {
  const dateStr = new Date().toISOString().split('T')[0];
  let md = `# 📊 EnvAtlas - Environment Variables Analysis Report\n\n`;
  md += `> **Analysis Date:** ${dateStr}  \n`;
  md += `> **Target Directory:** \`${targetDir}\`\n\n`;

  // Summary / Overview
  md += `## 📋 Overview\n\n`;
  md += `- **Unique variables detected in code:** \`${sortedVars.length}\`\n`;
  md += `- **Environment files analyzed:** \`${envFilesData.length}\`\n\n`;
  md += `---\n\n`;

  // Code variables details
  md += `## 🔍 Variables Used in Code\n\n`;
  md += `| Variable | Default Value | Usage Files |\n`;
  md += `| :--- | :--- | :--- |\n`;

  for (const v of sortedVars) {
    const usage = allEnvVars.get(v)!;
    const defVal = usage.defaultValue !== undefined ? `\`${usage.defaultValue}\`` : '_None_';
    const filesList = usage.files.map(f => `\`${f}\``).join('<br>');
    md += `| **\`${v}\`** | ${defVal} | ${filesList} |\n`;
  }

  md += `\n---\n\n`;

  // Multi-environment analysis
  md += `## 📂 Multi-Environment Analysis & Validation\n\n`;

  if (envFilesData.length > 0) {
    for (const envData of envFilesData) {
      md += `### 🔹 File: \`${envData.fileName}\`\n\n`;

      const missingInEnv = sortedVars.filter(v => !envData.vars.has(v));
      const unusedInCode = Array.from(envData.vars.keys()).filter(v => !allEnvVars.has(v)).sort();

      // Missing variables
      if (missingInEnv.length > 0) {
        md += `> ⚠️ **Missing variables (${missingInEnv.length}) :**\n`;
        missingInEnv.forEach(v => {
          const def = allEnvVars.get(v)?.defaultValue;
          md += `> - \`${v}\` ${def !== undefined ? `*(Default: \`${def}\`)*` : ''}\n`;
        });
        md += `\n`;
      } else {
        md += `> ✅ **All code variables are present.**\n\n`;
      }

      // Unused variables
      if (unusedInCode.length > 0) {
        md += `> ℹ️ **Declared but unused in code (${unusedInCode.length}) :**\n`;
        unusedInCode.forEach(v => {
          md += `> - \`${v}\`\n`;
        });
        md += `\n`;
      }

      // Format validation
      let formatErrorsCount = 0;
      let formatErrorsList = '';
      for (const [v, val] of envData.vars.entries()) {
        const errorMsg = validateEnvFormat(v, val);
        if (errorMsg) {
          formatErrorsList += `> - \`${v}="${val}"\` -> ${errorMsg}\n`;
          formatErrorsCount++;
        }
      }

      if (formatErrorsCount > 0) {
        md += `> ❌ **Format errors detected (${formatErrorsCount}) :**\n${formatErrorsList}\n`;
      } else {
        md += `> ✅ **Format and type validation passed.**\n\n`;
      }
    }
  } else {
    md += `_No environment file (.env*) found for comparison._\n`;
  }

  md += `\n---\n**EnvAtlas**\n`;
  return md;
}

main().catch((err) => {
  console.error('❌ An unexpected error occurred:', err);
  process.exit(1);
});