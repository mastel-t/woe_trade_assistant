import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sampleDirectory = path.resolve('sample');
const endpoints = [
  {
    name: 'configs',
    url: 'https://woe-idle.com/api/public/v1/configs',
  },
  {
    name: 'marketplace_items',
    url: 'https://woe-idle.com/api/public/v1/marketplace/items',
  },
];

async function fetchJson(endpoint) {
  const response = await fetch(endpoint.url);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`${endpoint.url} returned HTTP ${response.status}`);
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${endpoint.url} returned invalid JSON: ${error.message}`);
  }
}

async function writeSample(endpoint, data) {
  const filePath = path.join(sampleDirectory, `${endpoint.name}.json`);
  const oldFilePath = path.join(sampleDirectory, `${endpoint.name}_old.json`);
  const temporaryFilePath = `${filePath}.tmp`;

  await writeFile(temporaryFilePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

  try {
    await rm(oldFilePath, { force: true });
    try {
      await rename(filePath, oldFilePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    await rename(temporaryFilePath, filePath);
  } catch (error) {
    await rm(temporaryFilePath, { force: true });
    throw error;
  }

  return { filePath, oldFilePath };
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: npm run sample:update');
    return;
  }

  await mkdir(sampleDirectory, { recursive: true });

  const responses = await Promise.all(
    endpoints.map(async (endpoint) => ({
      endpoint,
      data: await fetchJson(endpoint),
    })),
  );

  const writtenFiles = [];
  for (const { endpoint, data } of responses) {
    writtenFiles.push(await writeSample(endpoint, data));
  }

  for (const { filePath, oldFilePath } of writtenFiles) {
    const oldFileExists = await readFile(oldFilePath).then(() => true).catch(() => false);
    console.log(`Updated ${filePath}${oldFileExists ? ` (previous file: ${oldFilePath})` : ''}`);
  }
}

main().catch((error) => {
  console.error(`Sample update failed: ${error.message}`);
  process.exitCode = 1;
});