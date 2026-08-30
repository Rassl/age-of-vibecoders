/** Run lifecycle helpers shared by the game and the headless harness. */
import { CFG } from '../config.js'
import { resetWorld, STATE } from './world.js'
import { spawnSoldier, reassignSlots } from './roster.js'
import { spawnDrone } from './drones.js'
import { squadDPS } from '../curves.js'

export function startRun(w, seed = w.seed) {
  resetWorld(w, seed)
  for (let i = 0; i < CFG.squad.startCount; i++) {
    spawnSoldier(w, (w.rng.next() - 0.5) * 0.6, (w.rng.next() - 0.5) * 0.6)
  }
  w.count = w.soldiers.size
  w.stats.peakCount = w.count
  w.nominalDPS = squadDPS(w.count, w.tier)
  reassignSlots(w)
  // AFTER the state is meaningful but before the first step: the escort should
  // already be on screen on frame one, not fade in a second into the run.
  for (let i = 0; i < CFG.drone.startCount; i++) spawnDrone(w, CFG.drone.startPermanent)
  w.state = STATE.RUNNING
  return w
}
