const fs = require("fs").promises;
const path = require("path");

// Ukrainian alphabet for folder naming
const ALPHABET = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "F",
  "G",
  "H",
  "I",
  "J",
  "K",
  "L",
  "M",
  "N",
  "O",
  "P",
  "Q",
  "R",
  "S",
  "T",
  "U",
  "V",
  "W",
  "X",
  "Y",
  "Z",
];

function fixMarkdownEmphasisSafe(text) {
  // Match a single '*' (not part of **), capture anything up to a space before a single closing '*'
  const regex = /(?<!\*)\*([^*]*?)\s\*(?!\*)/g;
  return text.replace(regex, (_, content) => `*${content}* `);
}

function fixLineEmphasis(text) {
  // 1. Fix malformed emphasis with space inside (e.g. _ текст _ → _текст_)
  text = text.replace(
    /([*_])\s+([^\s][^*_]*?[^\s])\s+\1/g,
    (_, marker, content) => {
      return `${marker}${content}${marker}`;
    }
  );

  // 2. Fix cases with space only before or after
  text = text.replace(/([*_])\s+([^\s][^*_]*?)\1/g, (_, marker, content) => {
    return `${marker}${content}${marker}`;
  });

  text = text.replace(/([*_])([^\s][^*_]*?)\s+\1/g, (_, marker, content) => {
    return `${marker}${content}${marker}`;
  });

  // 3. Insert space if emphasis touches letters directly (but not punctuation)
  text = text.replace(/([a-zA-Zа-яА-ЯіІїЇєЄґҐ0-9])([*_][^*_]+?[*_])/g, "$1 $2");
  text = text.replace(/([*_][^*_]+?[*_])([a-zA-Zа-яА-ЯіІїЇєЄґҐ0-9])/g, "$1 $2");

  return text;
}

// Function to extract footnote definitions from the document
function extractFootnotes(content) {
  const footnotes = new Map();
  const lines = content.split("\n");

  let currentId = null;
  let currentDef = [];

  for (const line of lines) {
    const defMatch = line.match(/^\[\^([^\]]+)\]:\s*(.*)/);
    if (defMatch) {
      if (currentId) {
        footnotes.set(currentId, currentDef.join("\n").trim());
      }
      currentId = defMatch[1];
      currentDef = [defMatch[2]];
    } else if (currentId && /^\s+/.test(line)) {
      // Continuation of the footnote
      currentDef.push(line);
    } else {
      if (currentId) {
        footnotes.set(currentId, currentDef.join("\n").trim());
        currentId = null;
        currentDef = [];
      }
    }
  }

  // Capture last footnote if file ends without new one
  if (currentId) {
    footnotes.set(currentId, currentDef.join("\n").trim());
  }

  return footnotes;
}

// Function to renumber footnotes in content and return mapping
function renumberFootnotes(contentLines, footnotes) {
  const result = [];
  let currentParagraph = [];
  let footnoteCounter = 1;
  const footnoteMapping = new Map(); // originalId -> newNumber
  const usedFootnotes = new Map(); // newNumber -> footnoteContent

  const processParagraph = () => {
    if (currentParagraph.length > 0) {
      // Process footnote references in the paragraph and renumber them
      const processedParagraph = currentParagraph.map((line) => {
        return line.replace(/\[\^([^\]]+)\]/g, (match, originalId) => {
          if (footnotes.has(originalId)) {
            if (!footnoteMapping.has(originalId)) {
              footnoteMapping.set(originalId, footnoteCounter);
              usedFootnotes.set(footnoteCounter, footnotes.get(originalId));
              footnoteCounter++;
            }
            return `[^${footnoteMapping.get(originalId)}]`;
          }
          return match; // Keep original if footnote not found
        });
      });

      // Add the processed paragraph
      result.push(...processedParagraph);

      // Check for footnote references in the paragraph
      const paragraphText = processedParagraph.join("\n");
      const footnoteRefs = paragraphText.match(/\[\^(\d+)\]/g);

      if (footnoteRefs) {
        const addedFootnotes = new Set();

        for (const ref of footnoteRefs) {
          const id = parseInt(ref.match(/\[\^(\d+)\]/)[1]);
          if (usedFootnotes.has(id) && !addedFootnotes.has(id)) {
            result.push(`[^${id}]: ${usedFootnotes.get(id)}`);
            addedFootnotes.add(id);
          }
        }
      }

      currentParagraph = [];
    }
  };

  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];

    // Skip footnote definition lines (they'll be recreated with new numbers)
    if (line.match(/^\[\^([^\]]+)\]:/)) {
      continue;
    }

    // Check if it's an empty line (paragraph break)
    if (line.trim() === "") {
      processParagraph();

      // Only add empty line if the next line isn't empty (avoid multiple empty lines)
      if (i + 1 < contentLines.length && contentLines[i + 1].trim() !== "") {
        result.push("");
      }
    } else {
      currentParagraph.push(line);
    }
  }

  // Process the last paragraph
  processParagraph();

  return result;
}

// Function to normalize heading levels (shift all headings to start from L1)
function normalizeHeadingLevels(contentLines) {
  // Find the minimum heading level in the content
  let minLevel = 7; // Start with max possible level + 1

  for (const line of contentLines) {
    const match = line.match(/^(#{1,6})\s/);
    if (match) {
      const level = match[1].length;
      minLevel = Math.min(minLevel, level);
    }
  }

  // If no headings found, return as is
  if (minLevel === 7) {
    return contentLines;
  }

  // Calculate how many levels to shift (to start from L2)
  const levelShift = minLevel - 2;

  // Normalize all headings
  return contentLines.map((line) => {
    const match = line.match(/^(#{1,6})(\s.*)/);
    if (match) {
      const currentLevel = match[1].length;
      const newLevel = Math.max(2, currentLevel - levelShift); // Ensure minimum L2
      const newHeading = "#".repeat(newLevel) + match[2];
      return newHeading;
    }
    return line;
  });
}

// Function to clean text from bold/italic formatting
function cleanFormatting(text) {
  return text
    .replace(/\*\*\*(.*?)\*\*\*/g, "$1") // Remove bold+italic ***text***
    .replace(/\*\*(.*?)\*\*/g, "$1") // Remove bold **text**
    .replace(/\*(.*?)\*/g, "$1") // Remove italic *text*
    .replace(/__(.*?)__/g, "$1") // Remove bold __text__
    .replace(/_(.*?)_/g, "$1") // Remove italic _text_
    .trim();
}

async function splitMarkdownFile(inputFile, outputDir) {
  try {
    // Read the markdown file
    const content = await fs.readFile(inputFile, "utf-8");

    // Create output directory if it doesn't exist
    await fs.mkdir(outputDir, { recursive: true });

    // Extract footnote definitions
    const footnotes = extractFootnotes(content);

    // Split content by lines
    const lines = content.split("\n");

    let currentLevel1 = null;
    let currentLevel2 = null;
    let currentContent = [];
    let level1Index = 0;
    let level2Index = 0; // Global counter for level 2 headings

    const processCurrentContent = async () => {
      if (currentLevel2 && currentContent.length > 0) {
        const cleanLevel1 = cleanFileName(cleanFormatting(currentLevel1));
        const cleanLevel2 = cleanFileName(cleanFormatting(currentLevel2));

        const folderName = `${ALPHABET[level1Index - 1]}. ${cleanLevel1}`;
        const fileName = `${(level2Index - 1)
          .toString()
          .padStart(2, "0")}. ${cleanLevel2}.md`;
        const folderPath = path.join(outputDir, folderName);
        const filePath = path.join(folderPath, fileName);

        // Create folder if it doesn't exist
        await fs.mkdir(folderPath, { recursive: true });

        // Normalize heading levels in content
        const normalizedContent = normalizeHeadingLevels(
          currentContent.slice(1)
        );

        // Renumber footnotes starting from 1 for each file
        const contentWithRenumberedFootnotes = renumberFootnotes(
          normalizedContent,
          footnotes
        );

        // Fix incorrect emphasys edges
        const emphasysfixedContent = fixMarkdownEmphasisSafe(
          contentWithRenumberedFootnotes.join("\n")
        );

        // Prepare file content with L1 heading at the top
        const fileContent =
          contentWithRenumberedFootnotes.length > 0
            ? [`# ${cleanLevel2}`, emphasysfixedContent].join("\n").trim()
            : `# ${cleanLevel2}`;
        await fs.writeFile(filePath, fileContent, "utf-8");

        console.log(`Created: ${path.join(folderName, fileName)}`);
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Check for level 1 heading (#)
      if (line.match(/^# [^#]/)) {
        // Process previous content if exists
        await processCurrentContent();

        // Reset content and update level 1 info
        currentLevel1 = line.substring(2).trim();
        currentLevel2 = null;
        currentContent = [];
        level1Index++;

        console.log(`Found Level 1: ${currentLevel1}`);
        continue;
      }

      // Check for level 2 heading (##)
      if (line.match(/^## [^#]/)) {
        // Process previous content if exists
        await processCurrentContent();

        // Reset content and update level 2 info
        currentLevel2 = line.substring(3).trim();
        currentContent = [line]; // Include the heading in content
        level2Index++;

        console.log(`Found Level 2: ${currentLevel2}`);
        continue;
      }

      // Add line to current content if we're inside a level 2 section
      if (currentLevel2) {
        currentContent.push(line);
      }
    }

    // Process any remaining content
    await processCurrentContent();

    console.log("\nSplitting completed successfully!");
    console.log(`Total Level 1 sections: ${level1Index}`);
    console.log(`Total Level 2 files: ${level2Index - 1}`);
  } catch (error) {
    console.error("Error processing file:", error.message);
    process.exit(1);
  }
}

// Function to clean filename (replace forbidden characters)
function cleanFileName(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, ".") // Replace forbidden characters with dot
    .replace(/[\x00-\x1f\x80-\x9f]/g, " ") // Replace control characters
    .replace(/^\.+/, "") // Replace leading dots
    .replace(/\.+$/, "") // Replace trailing dots
    .replace(/\s+/g, " ") // Replace multiple spaces with single space
    .replace(/_+/g, " ") // Replace multiple underscores with dot
    .trim();
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log(
      "Usage: node script.js <input-markdown-file> [output-directory]"
    );
    console.log("Example: node script.js document.md ./output");
    process.exit(1);
  }

  const inputFile = args[0];
  const outputDir = args[1] || "./output";

  // Check if input file exists
  try {
    await fs.access(inputFile);
  } catch (error) {
    console.error(`Input file '${inputFile}' does not exist.`);
    process.exit(1);
  }

  console.log(`Input file: ${inputFile}`);
  console.log(`Output directory: ${outputDir}`);
  console.log("Starting markdown file splitting...\n");

  await splitMarkdownFile(inputFile, outputDir);
}

// Run the script
if (require.main === module) {
  main();
}
