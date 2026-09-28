# EnvAtlas 🗺️ (vA)

**EnvAtlas** is a lightweight, zero-dependency CLI tool built with TypeScript and `tsx` designed to audit, validate, and manage environment variables across your codebase. It scans your source files (`.ts`, `.tsx`, `.js`, `.jsx`) for `process.env` and `import.meta.env` usage, cross-references them against your `.env` files, detects format/type errors, and automatically updates your configuration templates.

---

## 🚀 Features

* **Static Code Analysis:** Recursively scans source files to detect all `process.env` and `import.meta.env` keys along with any inline fallback defaults (e.g., `process.env.PORT || 3000`).
* **Multi-Environment Validation:** Compares code requirements against specific environment files (e.g., `.env.local`, `.env.production`).
* **Smart Format Validation:** Built-in checks for common environment variable patterns:
* **URLs/URIs:** Validates valid web addresses.
* **Ports:** Ensures numerical values fall within the correct range (`1` to `65535`).
* **Booleans:** Verifies values match truthy/falsy flags (`true`/`false`/`1`/`0`).


* **Auto-Fix & Updates:** Automatically appends missing environment variables directly to your target `.env` files or examples.
* **Template Generation:** Generates clean `/vA/.env.atlas.template` files containing defaults discovered in code.
* **Reporting:** Exports full audit reports to `/vA/.envatlas-report.txt` using the `--report` flag.
* **Ignore Support:** Automatically respects your `.gitignore` rules combined with standard defaults (`node_modules`, `dist`, etc.).

---

## 📦 Installation & Setup

Make sure you have [Node.js](https://nodejs.org) and [pnpm](https://pnpm.io) installed.

1. Clone or download the project repository.
2. Install dependencies using `pnpm`:

```bash
pnpm install
```

---

## ⚙️ Available Commands

All scripts are pre-configured to run via `pnpm` using `tsx`.

| Command | Description |
| --- | --- |
| `pnpm envatlas` | Scans the default directory and runs a full audit on code vs. existing `.env` files. |
| `pnpm envatlas:report` | Runs the audit and exports a full text report to `.envatlas-report.txt`. |
| `pnpm envatlas:update` / `pnpm envatlas:fix` | Scans and automatically appends any missing environment variables to your primary `.env` file. |
| `pnpm envatlas:local` | Targets `.env.local` and automatically fixes/appends missing variables. |
| `pnpm envatlas:dev` | Targets `.env.development` and automatically fixes/appends missing variables. |
| `pnpm envatlas:staging` | Targets `.env.staging` and automatically fixes/appends missing variables. |
| `pnpm envatlas:prod` | Targets `.env.production` and automatically fixes/appends missing variables. |

---

## 🛠️ Advanced Usage

You can also run the CLI manually with custom arguments:

```bash
# Scan a specific directory
pnpm envatlas ./packages/backend

# Target a specific environment file and auto-fix missing keys
pnpm envatlas --env .env.custom --fix

# Generate a report file during custom execution
pnpm envatlas --report
```

---

## 📄 Output Artifacts

* **`/vA/.env.atlas.template`**: Automatically generated on every run, listing all variables discovered in the source code alongside their default values.
* **`/vA/.envatlas-report.txt`**: Generated when using the `--report` flag, containing a shareable text-based breakdown of your environment health audit.