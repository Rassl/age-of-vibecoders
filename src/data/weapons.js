/**
 * Weapon tiers. dpsMult is the ONLY balance-relevant field; rate/pellets/pierce
 * redistribute that same DPS into a different FEEL, so a tier can never be a
 * stealth nerf -- but it must always be instantly recognisable, because an
 * upgrade the player cannot see or hear is an upgrade that did not happen.
 *
 * The squad starts at tier 0, so progression is felt from the first bubble.
 */
export const WEAPONS = [
  {
    id: 'pistol', name: 'PISTOL', dpsMult: 1.0, rate: 3.0, pellets: 1,
    spreadX: 0, pierce: 0, tracerColor: 0xffd479, muzzleColor: 0xffe9b0,
    gunLength: 0.30, tracerWidth: 0.9, tracerLen: 0.75, casings: true,
    shotGain: 0.55, shotHz: 320, spin: 0,
  },
  {
    id: 'smg', name: 'SMG', dpsMult: 1.45, rate: 9.0, pellets: 1,
    spreadX: 0.05, pierce: 0, tracerColor: 0xffe2a0, muzzleColor: 0xfff0c8,
    gunLength: 0.44, tracerWidth: 0.8, tracerLen: 0.85, casings: true,
    shotGain: 0.42, shotHz: 300, spin: 0,
  },
  {
    id: 'rifle', name: 'RIFLE', dpsMult: 2.1, rate: 4.5, pellets: 1,
    spreadX: 0, pierce: 1, tracerColor: 0xffe08a, muzzleColor: 0xfff0c0,
    gunLength: 0.68, tracerWidth: 1.0, tracerLen: 1.5, casings: true,
    shotGain: 0.72, shotHz: 235, spin: 0,
  },
  {
    id: 'shotgun', name: 'SHOTGUN', dpsMult: 3.0, rate: 2.2, pellets: 5,
    spreadX: 0.42, pierce: 0, tracerColor: 0xffc46b, muzzleColor: 0xffdca0,
    gunLength: 0.56, tracerWidth: 1.5, tracerLen: 0.55, casings: true,
    shotGain: 1.0, shotHz: 150, spin: 0,
  },
  {
    id: 'minigun', name: 'MINIGUN', dpsMult: 4.3, rate: 14.0, pellets: 1,
    spreadX: 0.06, pierce: 2, tracerColor: 0xfff2c8, muzzleColor: 0xffffff,
    gunLength: 0.70, tracerWidth: 0.75, tracerLen: 1.1, casings: false,
    shotGain: 0.34, shotHz: 400, spin: 34,
  },
]

export const MAX_TIER = WEAPONS.length - 1
