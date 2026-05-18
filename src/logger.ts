import chalk from 'chalk';
import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { TradingSetup } from './types';

const LOG_DIR = process.env.LOG_DIR ?? './logs';
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

export const winstonLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'setups.log'),
      maxsize: 10_000_000,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
    }),
  ],
});

const BORDER  = chalk.gray('-'.repeat(72));
const DBORDER = chalk.gray('='.repeat(72));

export function logInfo(msg: string): void {
  console.log(chalk.cyan(`[INFO] `) + msg);
}

export function logWarn(msg: string): void {
  console.log(chalk.yellow(`[WARN] `) + msg);
}

export function logError(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : String(err ?? '');
  console.error(chalk.red(`[ERR]  `) + msg + (detail ? ` - ${detail}` : ''));
  winstonLogger.error({ message: msg, detail });
}

// Silent variant - persists to file only, no console noise
export function logSetupSilent(setup: TradingSetup): void {
  winstonLogger.info({ type: 'setup', ...setup });
}

export function logSetup(setup: TradingSetup): void {
  const dir   = setup.direction === 'long'
    ? chalk.greenBright('LONG')
    : chalk.redBright('SHORT');
  const conf  = setup.confidence >= 80
    ? chalk.greenBright(`${setup.confidence}%`)
    : setup.confidence >= 60
    ? chalk.yellow(`${setup.confidence}%`)
    : chalk.red(`${setup.confidence}%`);

  console.log('\n' + DBORDER);
  console.log(
    chalk.bold.white(` * SMC SETUP  `) +
    chalk.bold.yellow(setup.ticker) +
    chalk.gray(`  [${setup.timeframe}]  `) +
    dir +
    chalk.gray(`  conf: `) + conf
  );
  console.log(DBORDER);

  console.log(chalk.bold(' Setup:    ') + chalk.white(setup.setupType));
  console.log(chalk.bold(' Bias:     ') + chalk.cyan(setup.marketBias));
  console.log(chalk.bold(' Time:     ') + chalk.gray(setup.timestamp));

  console.log(BORDER);
  console.log(
    chalk.bold(' Entry:    ') +
    chalk.greenBright(`$${setup.entry.ideal.toFixed(2)}`) +
    chalk.gray(` (zone $${setup.entry.low.toFixed(2)} - $${setup.entry.high.toFixed(2)})`)
  );
  console.log(
    chalk.bold(' Stop:     ') +
    chalk.redBright(`$${setup.stopLoss.toFixed(2)}`) +
    chalk.gray(` (risk $${Math.abs(setup.entry.ideal - setup.stopLoss).toFixed(2)}/share)`)
  );

  setup.takeProfits.forEach((tp, i) => {
    const rrColor = tp.rr >= 3 ? chalk.greenBright : tp.rr >= 2 ? chalk.yellow : chalk.white;
    console.log(
      chalk.bold(` TP${i + 1}:      `) +
      chalk.white(`$${tp.price.toFixed(2)}`) +
      chalk.gray(` - `) +
      rrColor(`${tp.rr.toFixed(1)}R`) +
      chalk.gray(`  ${tp.label}`)
    );
  });

  // Position sizing for the user's $ target
  const ps = setup.positionSizing;
  if (ps) {
    console.log(BORDER);
    console.log(chalk.bold.white(` To make $${ps.targetProfitUsd} at TP1:`));
    console.log(
      chalk.bold(' Shares:   ') +
      chalk.cyan(`${ps.sharesForTarget}`) +
      chalk.gray(`  @  $${setup.entry.ideal.toFixed(2)}`)
    );
    console.log(
      chalk.bold(' Capital:  ') +
      chalk.white(`$${ps.capitalRequired.toFixed(2)}`) +
      chalk.gray(`  (needed to open position)`)
    );
    console.log(
      chalk.bold(' Risk:     ') +
      chalk.redBright(`-$${ps.maxLossUsd.toFixed(2)}`) +
      chalk.gray(`  (loss if stopped out)`)
    );
    console.log(
      chalk.bold(' Profit:   ') +
      chalk.greenBright(`+$${ps.profitAtTp1.toFixed(2)}`) + chalk.gray(' @ TP1  |  ') +
      chalk.greenBright(`+$${ps.profitAtTp2.toFixed(2)}`) + chalk.gray(' @ TP2  |  ') +
      chalk.greenBright(`+$${ps.profitAtTp3.toFixed(2)}`) + chalk.gray(' @ TP3')
    );
  }

  console.log(BORDER);
  if (setup.keyLevels.length) {
    console.log(chalk.bold(' Levels:   ') + setup.keyLevels.join('  |  '));
  }
  console.log(chalk.bold(' Note:     ') + chalk.gray(setup.structureNote));
  console.log(DBORDER + '\n');

  winstonLogger.info({ type: 'setup', ...setup });
}
