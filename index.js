/**
 * Puppeteer script to save a rendered page as MHTML + HTML + screenshot.
 * Usage examples:
 *   node index.js --url="https://example.com" --out="output" --login=false --depth=0
 *
 * Environment (optional): create .env from .env.example for login.
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
require('dotenv').config();

const args = require('minimist')(process.argv.slice(2), {
  string: ['url', 'out'],
  boolean: ['login'],
  default: {
    out: 'output',
    depth: 0,
    login: process.env.LOGIN_ENABLED === 'true' || false
  }
});

if (!args.url) {
  console.error('ERROR: Debes pasar --url="https://..."');
  process.exit(1);
}

const OUT_DIR = path.resolve(process.cwd(), args.out);
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const config = {
  url: args.url,
  depth: Number(args.depth || 0),
  login: args.login,
  loginUrl: process.env.LOGIN_URL || '',
  loginUserSelector: process.env.LOGIN_USER_SELECTOR || '',
  loginPassSelector: process.env.LOGIN_PASS_SELECTOR || '',
  loginSubmitSelector: process.env.LOGIN_SUBMIT_SELECTOR || '',
  loginUser: process.env.LOGIN_USER || '',
  loginPass: process.env.LOGIN_PASS || '',
  userAgent: process.env.USER_AGENT || ''
};

async function saveMHTML(page, filepath) {
  // Use DevTools protocol to capture MHTML snapshot (bundles resources)
  const client = await page.target().createCDPSession();
  await client.send('Page.enable');
  const { data } = await client.send('Page.captureSnapshot', { format: 'mhtml' });
  fs.writeFileSync(filepath, data);
  console.log('Saved MHTML →', filepath);
}

async function saveRendered(url, nameSafe) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    if (config.userAgent) await page.setUserAgent(config.userAgent);

    page.setDefaultNavigationTimeout(60_000);

    // Optional login flow (only run if login=true and selectors provided)
    if (config.login) {
      console.log('Login enabled. Navigating to login URL...');
      const loginUrl = config.loginUrl || url;
      await page.goto(loginUrl, { waitUntil: 'networkidle2' });

      if (config.loginUserSelector && config.loginPassSelector) {
        if (!config.loginUser || !config.loginPass) {
          console.warn('LOGIN is enabled but LOGIN_USER/LOGIN_PASS are empty in env. Skipping credential fill.');
        } else {
          try {
            await page.waitForSelector(config.loginUserSelector, { timeout: 5000 });
            await page.type(config.loginUserSelector, config.loginUser, { delay: 50 });
            await page.type(config.loginPassSelector, config.loginPass, { delay: 50 });
            if (config.loginSubmitSelector) {
              await Promise.all([
                page.click(config.loginSubmitSelector),
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 })
              ]);
            } else {
              // Try Enter
              await page.keyboard.press('Enter');
              await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(()=>{});
            }
            console.log('Login attempt finished.');
          } catch (err) {
            console.warn('Login selectors not found or login failed:', err.message);
          }
        }
      } else {
        console.warn('Login requested but selectors not configured. Skipping login.');
      }
    }

    // Navigate to target page (could be same as login landing)
    console.log('Navigating to target URL:', url);
    await page.goto(url, { waitUntil: 'networkidle2' });

    // Create safe filename base from URL
    const safeName = nameSafe || url.replace(/(^\w+:|[:\/]+|[?#&=])/g, '_').slice(0, 120);
    const mhtmlPath = path.join(OUT_DIR, `${safeName}.mhtml`);
    const htmlPath = path.join(OUT_DIR, `${safeName}.html`);
    const screenshotPath = path.join(OUT_DIR, `${safeName}.png`);

    // Save MHTML (bundles resources)
    try {
      await saveMHTML(page, mhtmlPath);
    } catch (err) {
      console.warn('MHTML capture failed:', err.message);
    }

    // Save rendered HTML
    const rendered = await page.content();
    fs.writeFileSync(htmlPath, rendered, 'utf8');
    console.log('Saved HTML →', htmlPath);

    // Save screenshot
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log('Saved screenshot →', screenshotPath);

    await browser.close();
  } catch (err) {
    console.error('Error during saveRendered:', err);
    await browser.close();
    process.exit(1);
  }
}

/**
 * Simple crawler: starts from URL and saves up to depth N pages within same origin.
 * If depth=0 just saves the single URL.
 */
async function run() {
  const rootUrl = config.url;
  const toVisit = [{ url: rootUrl, depth: 0 }];
  const visited = new Set();

  while (toVisit.length) {
    const item = toVisit.shift();
    if (visited.has(item.url)) continue;
    visited.add(item.url);

    console.log(`\n=== Processing (depth ${item.depth}): ${item.url}`);
    await saveRendered(item.url);

    if (item.depth < config.depth) {
      // extract links from the rendered HTML file we just saved
      const safeName = item.url.replace(/(^\w+:|[:\/]+|[?#&=])/g, '_').slice(0, 120);
      const htmlPath = path.join(OUT_DIR, `${safeName}.html`);
      if (fs.existsSync(htmlPath)) {
        const html = fs.readFileSync(htmlPath, 'utf8');
        // simple href extraction
        const hrefs = Array.from(html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)).map(m => m[1]);
        for (let href of hrefs) {
          try {
            // ignore anchors, mailto, javascript:
            if (href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) continue;
            // resolve relative
            const abs = new URL(href, item.url).toString();
            // only same origin
            if (new URL(abs).origin === new URL(rootUrl).origin && !visited.has(abs)) {
              toVisit.push({ url: abs, depth: item.depth + 1 });
            }
          } catch (e) {
            // ignore bad urls
          }
        }
      }
    }
  }

  console.log('\nAll done. Output in:', OUT_DIR);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
