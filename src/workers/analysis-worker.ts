/**
 * Worker thread entry for parallel symbol analysis.
 * Parent posts { type: 'analyze', payload: AnalysisContext JSON }.
 * Avoids blocking main event loop when universe is large.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { loadConfig } from '../config/index.js';
import type { AnalysisContext } from '../types/strategy.js';
import { VwapEngine } from '../strategy/vwap/vwap-engine.js';
import { InstitutionalZoneDetector } from '../strategy/institutional/zone-detector.js';
import { MarketStructureEngine } from '../strategy/market-structure/structure-engine.js';
import { LiquidityDetector } from '../strategy/liquidity/liquidity-detector.js';
import { VolumeAnalyzer } from '../strategy/volume/volume-analyzer.js';
import { ScoringEngine } from '../strategy/scoring/scoring-engine.js';
import { SignalGenerator } from '../strategy/execution/signal-generator.js';

const config = loadConfig();
const vwap = new VwapEngine();
const zones = new InstitutionalZoneDetector({
  volumeMultiple: config.strategy.institutionalVolumeMultiple,
  minBodyRatio: config.strategy.minBodyRatio,
  maxWickRatio: config.strategy.maxWickRatio,
  volumeSmaPeriod: config.strategy.volumeSmaPeriod,
});
const structure = new MarketStructureEngine({
  swingLeft: config.strategy.swingLookback,
  swingRight: config.strategy.swingLookback,
});
const liquidity = new LiquidityDetector({
  equalTolerancePct: config.strategy.equalLevelTolerancePct,
});
const volume = new VolumeAnalyzer({ smaPeriod: config.strategy.volumeSmaPeriod });
const scoring = new ScoringEngine(vwap, config);
const generator = new SignalGenerator(
  vwap,
  zones,
  structure,
  liquidity,
  volume,
  scoring,
  config,
);

parentPort?.on('message', (msg: { type: string; id: string; payload?: AnalysisContext }) => {
  if (msg.type === 'analyze' && msg.payload) {
    try {
      const result = generator.analyze(msg.payload);
      parentPort?.postMessage({ type: 'result', id: msg.id, result });
    } catch (err) {
      parentPort?.postMessage({
        type: 'error',
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (msg.type === 'ping') {
    parentPort?.postMessage({ type: 'pong', id: msg.id });
  }
});
