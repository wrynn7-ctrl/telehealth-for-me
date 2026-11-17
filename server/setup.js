'use strict';
// Sets (or changes) the provider password. Run with: npm run setup
const readline = require('readline');
const config = require('./config');

const MIN_LENGTH = 12;

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (hidden && process.stdin.isTTY) {
      // Don't echo the password as it is typed.
      rl._writeToOutput = (text) => {
        if (text.includes(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden && process.stdin.isTTY) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const current = config.load();
  console.log('Telehealth setup\n');

  let password = process.env.TELEHEALTH_PASSWORD;
  if (!password) {
    password = await ask(`Choose a provider password (at least ${MIN_LENGTH} characters): `, true);
    const again = await ask('Type it again: ', true);
    if (password !== again) {
      console.error('\nThe two passwords did not match. Nothing was changed.');
      process.exit(1);
    }
  }
  if (password.length < MIN_LENGTH) {
    console.error(`\nThe password must be at least ${MIN_LENGTH} characters. Nothing was changed.`);
    process.exit(1);
  }

  let providerName = process.env.TELEHEALTH_PROVIDER_NAME;
  if (providerName === undefined && process.stdin.isTTY) {
    providerName = await ask(`Name clients will see for you [${current.providerName}]: `, false);
  }

  current.password = config.hashPassword(password);
  if (providerName && providerName.trim()) current.providerName = providerName.trim().slice(0, 40);
  config.save(current);
  console.log(`\nSaved to ${config.CONFIG_FILE}`);
  console.log('Start the server with: npm start');
}

main();
