/**
 * `autoqe init`：在目标项目里生成 qe.config.json，并复制方法层文档与模板。
 *
 * 设计约束：
 * - 不覆盖宿主已有的 AGENTS.md（改为写 AGENTS.autoqe.md，由人合并）；
 * - 默认不覆盖任何已存在文件，只有 --force 才覆盖；
 * - 只复制文档与模板，不复制 qe/ 运行时代码（由 npm 包提供）。
 */

import path from 'node:path'
import { access, copyFile, mkdir, readdir, writeFile } from 'node:fs/promises'

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..')

const CONFIG_TEMPLATE = (opts: { schemaPath: string | null; sourceRoots: string[] }): string =>
  `${JSON.stringify(
    {
      schema: {
        provider: opts.schemaPath ? 'prisma' : 'none',
        path: opts.schemaPath ?? 'prisma/schema.prisma',
        clientNames: ['prisma', 'db', 'tx'],
      },
      source: {
        collector: 'ts',
        roots: opts.sourceRoots,
        extensions: ['.ts', '.tsx'],
      },
      ignore: ['node_modules', 'dist', 'build', '.next', 'coverage', '.git', 'qe/templates', 'qe-report'],
      systemFields: {
        id: 'framework-generated (cuid/uuid/autoincrement)',
        createdAt: 'framework-generated (@default(now()))',
        updatedAt: 'framework-generated (@updatedAt)',
        deletedAt: 'written only by the soft-delete helper',
      },
      fieldExemptions: [],
      contracts: 'qe.contracts.json',
      boundaries: {
        publicRoutes: [],
      },
      stores: {
        moduleRoots: ['src/features', 'src/modules'],
        sensitiveKeys: ['password', 'accessToken', 'refreshToken', 'token', 'secret'],
      },
      scriptsDirs: ['scripts'],
      guardsDir: 'qe/guards',
      packageJson: 'package.json',
      ledger: 'qe/ledger/incidents.json',
      waivers: 'qe/waivers.json',
      auditDir: 'qe-audit',
      locale: 'en',
      metaGuards: false,
    },
    null,
    2,
  )}\n`

export interface InitOptions {
  force?: boolean
}

export interface InitResult {
  created: string[]
  skipped: string[]
  agentsMerged: boolean
  schemaPath: string | null
  sourceRoots: string[]
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function detectSchema(root: string): Promise<string | null> {
  for (const rel of ['prisma/schema.prisma', 'schema.prisma', 'src/prisma/schema.prisma']) {
    if (await exists(path.join(root, rel))) return rel
  }
  return null
}

async function detectSourceRoots(root: string): Promise<string[]> {
  const found: string[] = []
  for (const rel of ['src', 'app']) {
    if (await exists(path.join(root, rel))) found.push(rel)
  }
  return found.length > 0 ? found : ['src']
}

async function copyTree(
  srcDir: string,
  destDir: string,
  force: boolean,
  created: string[],
  skipped: string[],
): Promise<void> {
  await mkdir(destDir, { recursive: true })
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name)
    const dest = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      await copyTree(src, dest, force, created, skipped)
      continue
    }
    if (!force && (await exists(dest))) {
      skipped.push(dest)
      continue
    }
    await copyFile(src, dest)
    created.push(dest)
  }
}

export async function initProject(root: string, opts: InitOptions = {}): Promise<InitResult> {
  const force = opts.force === true
  const created: string[] = []
  const skipped: string[] = []
  const schemaPath = await detectSchema(root)
  const sourceRoots = await detectSourceRoots(root)

  const configPath = path.join(root, 'qe.config.json')
  if (!force && (await exists(configPath))) {
    skipped.push(configPath)
  } else {
    await writeFile(configPath, CONFIG_TEMPLATE({ schemaPath, sourceRoots }), 'utf8')
    created.push(configPath)
  }

  const contractsPath = path.join(root, 'qe.contracts.json')
  if (!force && (await exists(contractsPath))) {
    skipped.push(contractsPath)
  } else {
    await writeFile(contractsPath, `${JSON.stringify({ promises: [], gates: [] }, null, 2)}\n`, 'utf8')
    created.push(contractsPath)
  }

  const waiversPath = path.join(root, 'qe', 'waivers.json')
  if (!force && (await exists(waiversPath))) {
    skipped.push(waiversPath)
  } else {
    await mkdir(path.dirname(waiversPath), { recursive: true })
    await writeFile(waiversPath, '[]\n', 'utf8')
    created.push(waiversPath)
  }

  for (const name of await readdir(PACKAGE_ROOT)) {
    if (!/^QE-\d{2}-.*\.md$/.test(name)) continue
    const dest = path.join(root, name)
    if (!force && (await exists(dest))) {
      skipped.push(dest)
      continue
    }
    await copyFile(path.join(PACKAGE_ROOT, name), dest)
    created.push(dest)
  }

  const docsDir = path.join(root, 'docs')
  await mkdir(docsDir, { recursive: true })
  for (const name of ['ai-agent-workflow.md', 'configuration.md']) {
    const dest = path.join(docsDir, name)
    if (!force && (await exists(dest))) {
      skipped.push(dest)
      continue
    }
    await copyFile(path.join(PACKAGE_ROOT, 'docs', name), dest)
    created.push(dest)
  }

  let agentsMerged = false
  const agentsDest = path.join(root, 'AGENTS.md')
  if (!force && (await exists(agentsDest))) {
    const alt = path.join(root, 'AGENTS.autoqe.md')
    if (!force && (await exists(alt))) {
      skipped.push(alt)
    } else {
      await copyFile(path.join(PACKAGE_ROOT, 'AGENTS.md'), alt)
      created.push(alt)
    }
    agentsMerged = true
  } else {
    await copyFile(path.join(PACKAGE_ROOT, 'AGENTS.md'), agentsDest)
    created.push(agentsDest)
  }

  await copyTree(
    path.join(PACKAGE_ROOT, 'qe', 'templates'),
    path.join(root, 'qe', 'templates'),
    force,
    created,
    skipped,
  )

  return { created, skipped, agentsMerged, schemaPath, sourceRoots }
}
