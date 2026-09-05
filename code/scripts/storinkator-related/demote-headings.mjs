#!/usr/bin/env node
/**
 * In each .md under books/, every ATX heading is demoted by one level:
 * `#` -> `##`, `##` -> `###`, ... `#####` -> `######`.
 * Level-6 headings stay unchanged. Lines inside fenced ``` blocks are left unchanged.
 *
 * Skips `[000] Титулка.md` and legacy `[010] Титулка.md` (case-insensitive).
 *
 * Usage: node scripts/demote-headings.mjs [booksRoot] [--dry-run]
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const booksRootArg = args.find((a) => !a.startsWith('-'));
const booksRoot = booksRootArg ?? join(fileURLToPath(new URL('..', import.meta.url)), 'books');

function isTitulkaMd(filename) {
	return /^\[(000|010)\]\s*титулка\.md$/i.test(filename);
}

/** @returns {string[]} */
async function walkMarkdownFiles(dir, acc = []) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			await walkMarkdownFiles(p, acc);
		} else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
			acc.push(p);
		}
	}
	return acc;
}

function isFenceDelimiter(line) {
	return /^\s*```/.test(line);
}

/**
 * @param {string} content
 * @returns {{ next: string; changed: boolean }}
 */
function demoteAllHeadings(content) {
	const lines = content.split(/\r?\n/);
	let inFence = false;
	let changed = false;
	const out = [];

	for (const line of lines) {
		if (isFenceDelimiter(line)) {
			inFence = !inFence;
			out.push(line);
			continue;
		}

		if (inFence) {
			out.push(line);
			continue;
		}

		// ATX headings: up to 3 spaces, 1-5 `#`, then whitespace + rest.
		// Add one `#` to demote one level; `######` (h6) remains unchanged.
		const demoted = line.replace(/^(\s{0,3}#{1,5})(\s+.*)$/, '$1#$2');
		if (demoted !== line) changed = true;
		out.push(demoted);
	}

	return { next: out.join('\n'), changed };
}

async function main() {
	const paths = (await walkMarkdownFiles(booksRoot)).sort((a, b) => a.localeCompare(b));

	let changed = 0;
	let skippedTitulka = 0;
	let unchanged = 0;

	for (const filePath of paths) {
		if (isTitulkaMd(basename(filePath))) {
			skippedTitulka++;
			continue;
		}

		const raw = await readFile(filePath, 'utf8');
		const { next, changed: did } = demoteAllHeadings(raw);
		if (!did) {
			unchanged++;
			continue;
		}

		if (dryRun) {
			console.log(`would update: ${filePath}`);
		} else {
			await writeFile(filePath, next, 'utf8');
			console.log(`updated: ${filePath}`);
		}
		changed++;
	}

	console.log(
		`\n${dryRun ? 'Would change' : 'Changed'}: ${changed}, unchanged: ${unchanged}, skipped titulka: ${skippedTitulka}`
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
