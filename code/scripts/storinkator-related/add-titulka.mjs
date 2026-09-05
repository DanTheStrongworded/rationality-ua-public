#!/usr/bin/env node
/**
 * Ensures each chapter `[NNN] Title` under books (each book folder) has `[000] Титулка.md` with
 * `# <chapter title>` (title = folder name without `[NNN] ` prefix).
 *
 * Essays keep `[010]`, `[020]`, … — no renumbering. If `[010] Титулка.md` exists from an older
 * run, it is renamed to `[000] Титулка.md` (unless another `[000] *.md` blocks it).
 *
 * Usage: node scripts/add-titulka.mjs [booksRoot] [--dry-run]
 */

import { readdir, writeFile, rename, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const booksRootArg = args.find((a) => !a.startsWith('-'));
const booksRoot = booksRootArg ?? join(fileURLToPath(new URL('..', import.meta.url)), 'books');
const TITULKA = '[000] Титулка.md';
const LEGACY_TITULKA = '[010] Титулка.md';

/** Same convention as scripts/renumber-books.mjs — only these book roots. */
function isNumberedBookDir(name) {
	return /^\d+\.\s/.test(name);
}

const chapterDirRe = /^\[\d+\]\s+.+$/;
const numberedMdRe = /^\[(\d+)\]\s*(.+)\.md$/i;

function chapterDisplayTitle(folderName) {
	const m = folderName.match(/^\[\d+\]\s*(.+)$/);
	return (m?.[1] ?? folderName).trim();
}

async function fileExists(p) {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

/** @returns {{ name: string; order: number; stem: string }[]} */
async function listNumberedMarkdown(chapterPath) {
	const files = await readdir(chapterPath);
	const out = [];
	for (const f of files) {
		const m = f.match(numberedMdRe);
		if (!m) continue;
		out.push({ name: f, order: Number(m[1]), stem: m[2] });
	}
	out.sort((a, b) => a.order - b.order || a.name.localeCompare(b, 'uk'));
	return out;
}

async function ensureTitulka(chapterPath, book, chName) {
	const titulkaPath = join(chapterPath, TITULKA);
	const legacyPath = join(chapterPath, LEGACY_TITULKA);
	const rel = join(book, chName);

	if (await fileExists(titulkaPath)) {
		return { kind: 'skip' };
	}

	if (await fileExists(legacyPath)) {
		const blocking000 = (await listNumberedMarkdown(chapterPath)).find(
			(x) => x.order === 0 && x.name !== LEGACY_TITULKA
		);
		if (blocking000) {
			console.warn(`skip migrate (other [000] present): ${rel} — ${blocking000.name}`);
			return { kind: 'skip-warn' };
		}
		if (dryRun) {
			console.log(`would rename: ${rel}/${LEGACY_TITULKA} -> ${TITULKA}`);
			return { kind: 'migrate' };
		}
		await rename(legacyPath, titulkaPath);
		console.log(`migrated: ${rel}/${LEGACY_TITULKA} -> ${TITULKA}`);
		return { kind: 'migrate' };
	}

	const numbered = await listNumberedMarkdown(chapterPath);
	const other000 = numbered.find((x) => x.order === 0);
	if (other000) {
		console.warn(`skip (non-titulka [000] present): ${rel} — ${other000.name}`);
		return { kind: 'skip-warn' };
	}

	const title = chapterDisplayTitle(chName);
	const body = `# ${title}\n`;

	if (dryRun) {
		console.log(`would create: ${rel}/${TITULKA}`);
		return { kind: 'create' };
	}
	await writeFile(titulkaPath, body, 'utf8');
	console.log(`created: ${rel}/${TITULKA}`);
	return { kind: 'create' };
}

async function main() {
	const bookEntries = await readdir(booksRoot, { withFileTypes: true });
	const bookDirs = bookEntries
		.filter((e) => e.isDirectory() && isNumberedBookDir(e.name))
		.map((e) => e.name);

	let created = 0;
	let migrated = 0;
	let skipped = 0;
	let warned = 0;

	for (const book of bookDirs.sort((a, b) => a.localeCompare(b, 'uk'))) {
		const bookPath = join(booksRoot, book);
		const children = await readdir(bookPath, { withFileTypes: true });

		for (const ch of children.filter((e) => e.isDirectory())) {
			if (!chapterDirRe.test(ch.name)) continue;

			const chapterPath = join(bookPath, ch.name);
			const r = await ensureTitulka(chapterPath, book, ch.name);
			if (r.kind === 'skip') skipped++;
			else if (r.kind === 'skip-warn') warned++;
			else if (r.kind === 'migrate') migrated++;
			else if (r.kind === 'create') created++;
		}
	}

	if (dryRun) {
		console.log(
			`\nWould create: ${created}, migrate [010]→[000]: ${migrated}, skipped (already [000]): ${skipped}, skipped (conflict): ${warned}`
		);
	} else {
		console.log(
			`\ncreated: ${created}, migrated: ${migrated}, skipped (already [000]): ${skipped}, skipped (conflict): ${warned}`
		);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
