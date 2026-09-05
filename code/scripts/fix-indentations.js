const fs = require('fs');
const path = require('path');

const BOOKS_DIR = path.join(__dirname, '..', '..', 'books');

function fixIndentations(content) {
    const lines = content.split('\n');
    const result = [];
    let quoteBlock = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmedLine = line.trim();
        
        // Skip empty lines
        if (trimmedLine.length === 0) {
            if (quoteBlock.length > 0) {
                // End of quote block
                result.push('> ' + quoteBlock.join('\n> '));
                quoteBlock = [];
            }
            result.push(line);
            continue;
        }
        
        // Check if this line starts with 4+ spaces
        if (line.match(/^\s{4,}/)) {
            // Remove indentation for footnote URLs
            if (trimmedLine.match(/^\[http/) || trimmedLine.match(/^\(http/)) {
                if (quoteBlock.length > 0) {
                    result.push('> ' + quoteBlock.join('\n> '));
                    quoteBlock = [];
                }
                result.push(trimmedLine);
                continue;
            }
            
            // Check if this looks like a quote (starts with quote markers or contains quote content)
            if (trimmedLine.match(/^[\*\—«]/) || 
                trimmedLine.includes('Софі́стикат') || 
                trimmedLine.includes('Зетет') ||
                trimmedLine.includes('Праща Давида') ||
                trimmedLine.includes('гомункул') ||
                trimmedLine.includes('упере') ||
                trimmedLine.includes('баєсівський')) {
                
                // Add to quote block
                quoteBlock.push(trimmedLine);
                continue;
            }
            
            // For other indented text, just remove indentation
            if (quoteBlock.length > 0) {
                result.push('> ' + quoteBlock.join('\n> '));
                quoteBlock = [];
            }
            result.push(trimmedLine);
        } else {
            // Not indented
            if (quoteBlock.length > 0) {
                result.push('> ' + quoteBlock.join('\n> '));
                quoteBlock = [];
            }
            result.push(line);
        }
    }
    
    // Handle case where file ends with a quote block
    if (quoteBlock.length > 0) {
        result.push('> ' + quoteBlock.join('\n> '));
    }
    
    return result.join('\n');
}

function processFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const fixedContent = fixIndentations(content);
        
        if (content !== fixedContent) {
            fs.writeFileSync(filePath, fixedContent, 'utf8');
            console.log(`Fixed indentations in: ${filePath}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`Error processing ${filePath}:`, error.message);
        return false;
    }
}

function findMarkdownFiles(dir) {
    const files = [];
    
    function walkDirectory(currentDir) {
        const items = fs.readdirSync(currentDir);
        
        for (const item of items) {
            const fullPath = path.join(currentDir, item);
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory()) {
                walkDirectory(fullPath);
            } else if (item.endsWith('.md')) {
                files.push(fullPath);
            }
        }
    }
    
    walkDirectory(dir);
    return files;
}

function main() {
    console.log('Finding all markdown files in books directory...');
    const markdownFiles = findMarkdownFiles(BOOKS_DIR);
    console.log(`Found ${markdownFiles.length} markdown files\n`);
    
    let fixedCount = 0;
    
    for (const filePath of markdownFiles) {
        if (processFile(filePath)) {
            fixedCount++;
        }
    }
    
    console.log(`\nFixed indentations in ${fixedCount} out of ${markdownFiles.length} files`);
}

if (require.main === module) {
    main();
}

module.exports = { fixIndentations, processFile, findMarkdownFiles };