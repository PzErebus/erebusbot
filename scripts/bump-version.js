const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const VERSION_FILE = path.join(ROOT_DIR, 'version.json');

function getCurrentVersion() {
  if (fs.existsSync(VERSION_FILE)) {
    try {
      const data = fs.readFileSync(VERSION_FILE, 'utf-8');
      const version = JSON.parse(data);
      return version;
    } catch {
      return null;
    }
  }
  return null;
}

function generateVersion() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${dateStr}${hours}${minutes}`;
}

function updateVersion() {
  const version = generateVersion();
  
  // 更新 version.json
  fs.writeFileSync(VERSION_FILE, JSON.stringify({
    version,
    date: new Date().toISOString(),
    commit: process.env.GIT_COMMIT || 'unknown'
  }, null, 2));
  
  // 更新 src/index.ts
  const indexFile = path.join(ROOT_DIR, 'src', 'index.ts');
  let indexContent = fs.readFileSync(indexFile, 'utf-8');
  indexContent = indexContent.replace(
    /const VERSION = '[\d]+';/,
    `const VERSION = '${version}';`
  );
  fs.writeFileSync(indexFile, indexContent);
  
  // 更新 src/bot.ts 中的版本号显示
  const botFile = path.join(ROOT_DIR, 'src', 'bot.ts');
  let botContent = fs.readFileSync(botFile, 'utf-8');
  botContent = botContent.replace(
    /📦 v[\d]+/,
    `📦 v${version}`
  );
  fs.writeFileSync(botFile, botContent);
  
  // 更新 package.json
  const pkgFile = path.join(ROOT_DIR, 'package.json');
  let pkgContent = fs.readFileSync(pkgFile, 'utf-8');
  const pkg = JSON.parse(pkgContent);
  pkg.version = version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  
  console.log(`✅ 版本号已更新为: ${version}`);
}

if (require.main === module) {
  updateVersion();
}

module.exports = { generateVersion, updateVersion };
