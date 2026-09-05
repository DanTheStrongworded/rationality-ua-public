#!/usr/bin/env node
/**
 * Renames chapter folders and essay .md files under books/{1,2,3}.* to
 * [010], [020], [030] … (step 10, zero-padded to 3 digits).
 * Essay numbering restarts inside each chapter.
 *
 * Usage: node scripts/renumber-books.mjs [booksRoot] [--dry-run]
 */

import { readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const booksRootArg = args.find((a) => !a.startsWith('-'));
const root = booksRootArg ?? join(fileURLToPath(new URL('..', import.meta.url)), 'books');

function formatTag(indexFromZero) {
	const n = (indexFromZero + 1) * 10;
	return `[${String(n).padStart(3, '0')}]`;
}

function isNumberedBookDir(name) {
	return /^\d+\.\s/.test(name);
}

/** @returns {{ prefix: string | null, title: string }} */
function splitDotSpaceStem(stem) {
	const idx = stem.indexOf('. ');
	if (idx === -1) return { prefix: null, title: stem };
	return { prefix: stem.slice(0, idx), title: stem.slice(idx + 2) };
}

function chapterSortKey(name) {
	const { prefix, title } = splitDotSpaceStem(name);
	if (prefix === null) return [2, 0, name];
	if (/^\d+$/.test(prefix)) return [0, parseInt(prefix, 10), title];
	if (/^[A-Za-z]+$/.test(prefix)) return [1, prefix.toUpperCase().charCodeAt(0), title];
	return [2, 0, name];
}

function essaySortKey(filename) {
	const stem = filename.replace(/\.md$/i, '');
	const { prefix, title } = splitDotSpaceStem(stem);
	if (prefix !== null && /^\d+$/.test(prefix)) {
		return [0, parseInt(prefix, 10), title, filename];
	}
	return [1, 0, stem, filename];
}

function isOldChapterName(name) {
	if (!name.includes('. ')) return false;
	if (/^\[\d+\]\s/.test(name)) return false;
	return true;
}

function isOldEssayName(filename) {
	if (!filename.toLowerCase().endsWith('.md')) return false;
	if (/^\[\d+\]\s/.test(filename)) return false;
	const stem = filename.slice(0, -3);
	return stem.includes('. ');
}

async function renumberEssays(chapterPath, chapterLabel = '') {
	const entries = await readdir(chapterPath, { withFileTypes: true });
	const mdFiles = entries
		.filter((e) => e.isFile() && isOldEssayName(e.name))
		.map((e) => e.name)
		.sort((a, b) => {
			const ka = essaySortKey(a);
			const kb = essaySortKey(b);
			for (let i = 0; i < 4; i++) {
				if (ka[i] !== kb[i]) {
					const va = ka[i];
					const vb = kb[i];
					if (typeof va === 'number' && typeof vb === 'number') return va - vb;
					return String(va).localeCompare(String(vb), 'uk');
				}
			}
			return 0;
		});

	if (mdFiles.length === 0) return;

	if (dryRun && chapterLabel) {
		console.log(`  essays (${chapterLabel}):`);
	}

	const planned = mdFiles.map((oldName, i) => {
		const stem = oldName.replace(/\.md$/i, '');
		const { title } = splitDotSpaceStem(stem);
		const newName = `${formatTag(i)} ${title}.md`;
		return { oldName, newName };
	});

	const tmpNames = planned.map((_, i) => `.renum-essay-${String(i).padStart(4, '0')}.md`);

	if (!dryRun) {
		for (let i = 0; i < planned.length; i++) {
			await rename(join(chapterPath, planned[i].oldName), join(chapterPath, tmpNames[i]));
		}
		for (let i = 0; i < planned.length; i++) {
			await rename(join(chapterPath, tmpNames[i]), join(chapterPath, planned[i].newName));
		}
	} else {
		for (let i = 0; i < planned.length; i++) {
			console.log(`    essay: ${planned[i].oldName} -> ${planned[i].newName}`);
		}
	}
}

async function renumberBook(bookPath, bookLabel) {
	const entries = await readdir(bookPath, { withFileTypes: true });
	const chapterDirs = entries
		.filter((e) => e.isDirectory() && isOldChapterName(e.name))
		.map((e) => e.name)
		.sort((a, b) => {
			const ka = chapterSortKey(a);
			const kb = chapterSortKey(b);
			for (let i = 0; i < 3; i++) {
				if (ka[i] !== kb[i]) {
					const va = ka[i];
					const vb = kb[i];
					if (typeof va === 'number' && typeof vb === 'number') return va - vb;
					return String(va).localeCompare(String(vb), 'uk');
				}
			}
			return 0;
		});

	if (chapterDirs.length === 0) {
		console.log(`${bookLabel}: no old-style chapter dirs, skip`);
		return;
	}

	console.log(`${bookLabel}: ${chapterDirs.length} chapters`);

	const planned = chapterDirs.map((oldName, i) => {
		const { title } = splitDotSpaceStem(oldName);
		const newName = `${formatTag(i)} ${title}`;
		return { oldName, newName };
	});

	if (!dryRun) {
		for (let i = 0; i < planned.length; i++) {
			const tmp = `.renum-chapter-${String(i).padStart(4, '0')}`;
			await rename(join(bookPath, planned[i].oldName), join(bookPath, tmp));
		}
		for (let i = 0; i < planned.length; i++) {
			const tmp = `.renum-chapter-${String(i).padStart(4, '0')}`;
			await rename(join(bookPath, tmp), join(bookPath, planned[i].newName));
		}
	} else {
		for (const p of planned) {
			console.log(`  chapter: ${p.oldName} -> ${p.newName}`);
		}
	}

	for (const p of planned) {
		const chapterPath = join(bookPath, dryRun ? p.oldName : p.newName);
		await renumberEssays(chapterPath, dryRun ? p.oldName : p.newName);
	}
}

async function main() {
	let bookRoots;
	try {
		bookRoots = await readdir(root, { withFileTypes: true });
	} catch (e) {
		console.error('Cannot read books root:', root, e);
		process.exit(1);
	}

	const books = bookRoots.filter((e) => e.isDirectory() && isNumberedBookDir(e.name)).map((e) => e.name);

	if (books.length === 0) {
		console.log('No book folders matching /^\\d+\\.\\s/ under', root);
		return;
	}

	books.sort((a, b) => a.localeCompare(b, 'uk'));

	if (dryRun) console.log('DRY RUN — no changes written\n');

	for (const name of books) {
		await renumberBook(join(root, name), name);
	}

	console.log(dryRun ? '\nDry run done.' : '\nDone.');
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
