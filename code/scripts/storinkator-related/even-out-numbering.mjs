#!/usr/bin/env node
/**
 * Within each numbered book (1. …, 2. …, …): renumber chapter folders to [010], [020], [030] …
 * by current bracket order (sorted by number, then name).
 *
 * Within each chapter folder: renumber bracketed .md files to steps of 10. The titulka file
 * (`… Титулка.md`, any bracket) stays at `[000] Титулка.md`; all other essays become
 * `[010] …`, `[020] …`, … in sorted order.
 *
 * Non-bracketed paths (images/, meta.json, cover, etc.) are left alone.
 *
 * Usage: node scripts/even-out-numbering.mjs [booksRoot] [--dry-run]
 */

import { readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const booksRootArg = args.find((a) => !a.startsWith('-'));
const booksRoot = booksRootArg ?? join(fileURLToPath(new URL('..', import.meta.url)), 'books');

function isNumberedBookDir(name) {
	return /^\d+\.\s/.test(name);
}

function formatTag(indexFromZero) {
	const n = (indexFromZero + 1) * 10;
	return `[${String(n).padStart(3, '0')}]`;
}

const chapterDirRe = /^\[(\d+)\]\s+(.+)$/;
const essayFileRe = /^\[(\d+)\]\s+(.+)\.md$/i;

function isTitulkaStem(stem) {
	return stem === 'Титулка';
}

/**
 * @param {string} dir
 * @param {'chapter' | 'essay'} kind
 */
async function evenOutInDir(dir, kind) {
	const entries = await readdir(dir, { withFileTypes: true });
	/** @type {{ oldName: string; order: number; stem: string }[]} */
	const items = [];

	for (const e of entries) {
		if (kind === 'chapter' && !e.isDirectory()) continue;
		if (kind === 'essay' && !e.isFile()) continue;

		const name = e.name;
		const m = kind === 'chapter' ? name.match(chapterDirRe) : name.match(essayFileRe);
		if (!m) continue;

		const order = Number(m[1]);
		const stem = m[2];
		items.push({ oldName: name, order, stem });
	}

	if (items.length === 0) return { changed: 0 };

	/** @type {{ oldName: string; order: number; stem: string; newName: string }[]} */
	let planned;

	if (kind === 'chapter') {
		items.sort((a, b) => a.order - b.order || a.stem.localeCompare(b.stem, 'uk'));
		planned = items.map((x, i) => ({
			...x,
			newName: `${formatTag(i)} ${x.stem}`
		}));
	} else {
		const titulkas = items.filter((x) => isTitulkaStem(x.stem));
		let rest = items.filter((x) => !isTitulkaStem(x.stem));
		if (titulkas.length > 1) {
			console.warn(`    [essay] multiple Титулка in ${dir} — extras renumbered with other essays`);
			rest = [...rest, ...titulkas.slice(1)];
		}
		rest.sort((a, b) => a.order - b.order || a.stem.localeCompare(b.stem, 'uk'));

		planned = [];
		if (titulkas.length > 0) {
			titulkas.sort((a, b) => a.order - b.order || a.oldName.localeCompare(b.oldName, 'uk'));
			planned.push({ ...titulkas[0], newName: '[000] Титулка.md' });
		}
		let i = 0;
		for (const x of rest) {
			planned.push({ ...x, newName: `${formatTag(i)} ${x.stem}.md` });
			i++;
		}
	}

	const needsWork = planned.some((p) => p.oldName !== p.newName);
	if (!needsWork) return { changed: 0 };

	const label = kind === 'chapter' ? 'chapter' : 'essay';

	if (dryRun) {
		for (const p of planned) {
			if (p.oldName !== p.newName) {
				console.log(`    [${label}] ${p.oldName} -> ${p.newName}`);
			}
		}
		return { changed: planned.filter((p) => p.oldName !== p.newName).length };
	}

	for (let i = 0; i < planned.length; i++) {
		const tmp =
			kind === 'chapter'
				? `.evenout-chap-${String(i).padStart(4, '0')}`
				: `.evenout-md-${String(i).padStart(4, '0')}.md`;
		await rename(join(dir, planned[i].oldName), join(dir, tmp));
	}

	for (let i = 0; i < planned.length; i++) {
		const tmp =
			kind === 'chapter'
				? `.evenout-chap-${String(i).padStart(4, '0')}`
				: `.evenout-md-${String(i).padStart(4, '0')}.md`;
		await rename(join(dir, tmp), join(dir, planned[i].newName));
	}

	return { changed: planned.filter((p) => p.oldName !== p.newName).length };
}

async function main() {
	const bookEntries = await readdir(booksRoot, { withFileTypes: true });
	const bookDirs = bookEntries
		.filter((e) => e.isDirectory() && isNumberedBookDir(e.name))
		.map((e) => e.name)
		.sort((a, b) => a.localeCompare(b, 'uk'));

	let chaptersTouched = 0;
	let essaysTouched = 0;

	if (dryRun) console.log('DRY RUN — no changes written\n');

	for (const book of bookDirs) {
		const bookPath = join(booksRoot, book);
		const ch = await evenOutInDir(bookPath, 'chapter');
		if (ch.changed) {
			console.log(`${book}: even out ${ch.changed} chapter folder(s)`);
			chaptersTouched += ch.changed;
		}

		const afterChapters = await readdir(bookPath, { withFileTypes: true });
		for (const d of afterChapters.filter((e) => e.isDirectory())) {
			if (!chapterDirRe.test(d.name)) continue;
			const chapterPath = join(bookPath, d.name);
			const es = await evenOutInDir(chapterPath, 'essay');
			if (es.changed) {
				console.log(`  ${d.name}: even out ${es.changed} essay(s)`);
				essaysTouched += es.changed;
			}
		}
	}

	console.log(
		`\n${dryRun ? 'Would rename' : 'Renamed'}: ${chaptersTouched} chapter folders, ${essaysTouched} essays`
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
