const fs = require("fs").promises;
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const readline = require("readline");

const execFileAsync = promisify(execFile);
const BOOKS_DIR = path.join(__dirname, "..", "..", "books");
const STORINKATOR_URL = "https://storinkator.vercel.app";

const UKRAINIAN_MONTHS = [
  "січня",
  "лютого",
  "березня",
  "квітня",
  "травня",
  "червня",
  "липня",
  "серпня",
  "вересня",
  "жовтня",
  "листопада",
  "грудня",
];

function question(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function formatUkrainianDate(date = new Date()) {
  return `${date.getDate()} ${UKRAINIAN_MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function parseVersion(version) {
  const match = String(version).trim().match(/^(\d+)\.(\d+)$/);

  if (!match) {
    throw new Error(`Непідтримуваний номер версії: "${version}". Очікується формат X.X.`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

function incrementVersion(currentVersion, updateType) {
  const { major, minor } = parseVersion(currentVersion);

  if (updateType === "major") {
    return `${major + 1}.0`;
  }

  if (updateType === "minor") {
    return `${major}.${minor + 1}`;
  }

  throw new Error(`Невідомий тип оновлення версії: ${updateType}`);
}

function isValidVersion(version) {
  return /^\d+\.\d+$/.test(String(version).trim());
}

async function findBooks() {
  const entries = await fs.readdir(BOOKS_DIR, { withFileTypes: true });
  const books = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const bookPath = path.join(BOOKS_DIR, entry.name);
    const files = await fs.readdir(bookPath);
    const configFiles = files.filter(
      (file) => file.startsWith("Storinkator Config") && file.endsWith(".json")
    );

    if (configFiles.length === 1) {
      books.push({
        name: entry.name,
        directory: bookPath,
        configPath: path.join(bookPath, configFiles[0]),
      });
    }
  }

  return books.sort((a, b) => a.name.localeCompare(b.name, "uk"));
}

async function chooseBook(rl, books) {
  if (books.length === 0) {
    throw new Error("У папці books не знайдено книг із конфігурацією Storinkator.");
  }

  console.log("\nЯку книгу випускаємо?");
  books.forEach((book, index) => console.log(`  ${index + 1}. ${book.name}`));

  while (true) {
    const answer = (await question(rl, "Номер книги: ")).trim();
    const index = Number(answer) - 1;

    if (Number.isInteger(index) && index >= 0 && index < books.length) {
      return books[index];
    }

    console.log(`Введіть число від 1 до ${books.length}.`);
  }
}

async function chooseVersion(rl, currentVersion) {
  console.log(`\nПоточна версія: ${currentVersion}`);

  while (true) {
    const updateType = (await question(
      rl,
      "Оновлення версії — major, minor чи custom? [minor]: "
    ))
      .trim()
      .toLowerCase();
    const selectedType = updateType || "minor";

    if (selectedType === "major" || selectedType === "minor") {
      return incrementVersion(currentVersion, selectedType);
    }

    if (selectedType === "custom") {
      while (true) {
        const customVersion = (await question(rl, "Введіть номер версії у форматі X.X: ")).trim();

        if (isValidVersion(customVersion)) {
          return customVersion;
        }

        console.log("Номер версії має бути у форматі X.X, наприклад 2.1.");
      }
    }

    console.log("Введіть major, minor або custom.");
  }
}

async function updateConfig(book, version, releaseDate = formatUkrainianDate()) {
  const config = JSON.parse(await fs.readFile(book.configPath, "utf8"));

  if (!config.values || !config.values.content_variables) {
    throw new Error(`У конфігурації книги немає values.content_variables: ${book.configPath}`);
  }

  config.values.content_variables.TRANSLATION_VERSION = version;
  config.values.content_variables.TRANSLATION_DATE = releaseDate;

  await fs.writeFile(book.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  return { version, releaseDate };
}

async function runGit(args) {
  return execFileAsync("git", args, { cwd: path.join(__dirname, "..", "..") });
}

async function commitAndPush(book, version) {
  const commitMessage = `Release ${book.name} v${version}`;

  await runGit(["add", "-A"]);
  await runGit(["commit", "-m", commitMessage]);
  await runGit(["push"]);

  return commitMessage;
}

async function openStorinkator() {
  const commands = {
    darwin: ["open", [STORINKATOR_URL]],
    win32: ["cmd", ["/c", "start", "", STORINKATOR_URL]],
    linux: ["xdg-open", [STORINKATOR_URL]],
  };
  const command = commands[process.platform];

  if (!command) {
    console.log(`Відкрийте Storinkator вручну: ${STORINKATOR_URL}`);
    return;
  }

  await execFileAsync(command[0], command[1]);
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const books = await findBooks();
    const book = await chooseBook(rl, books);
    const config = JSON.parse(await fs.readFile(book.configPath, "utf8"));
    const currentVersion = config.values?.content_variables?.TRANSLATION_VERSION;

    if (!currentVersion) {
      throw new Error(`У конфігурації книги не знайдено TRANSLATION_VERSION: ${book.configPath}`);
    }

    const version = await chooseVersion(rl, currentVersion);
    const { releaseDate } = await updateConfig(book, version);

    console.log(
      `\nКонфігурацію оновлено: ${book.name} — версія ${version}, дата ${releaseDate}.`
    );

    if (
      (await question(
        rl,
        "Додати зміни до коміту та виконати commit/push з автоматичним повідомленням? [y/N]: "
      ))
        .trim()
        .toLowerCase()
        .startsWith("y")
    ) {
      try {
        const commitMessage = await commitAndPush(book, version);
        console.log(`Зміни закомічено та відправлено: ${commitMessage}`);
      } catch (error) {
        console.error(`Не вдалося виконати commit/push: ${error.message}`);
      }
    }

    if (
      (await question(rl, "Відкрити storinkator.vercel.app для створення нового PDF? [y/N]: "))
        .trim()
        .toLowerCase()
        .startsWith("y")
    ) {
      try {
        await openStorinkator();
        console.log(`Відкрито ${STORINKATOR_URL}.`);
      } catch (error) {
        console.error(`Не вдалося відкрити Storinkator: ${error.message}`);
        console.log(`Відкрийте вручну: ${STORINKATOR_URL}`);
      }
    }
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Помилка: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  chooseBook,
  chooseVersion,
  findBooks,
  formatUkrainianDate,
  incrementVersion,
  isValidVersion,
  openStorinkator,
  parseVersion,
  updateConfig,
};
