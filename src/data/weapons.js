/**
 * Weapon tiers. dpsMult is the ONLY balance-relevant field; rate/pellets/pierce
 * redistribute that same DPS into a different FEEL, so a tier can never be a
 * stealth nerf -- but it must always be instantly recognisable, because an
 * upgrade the player cannot see or hear is an upgrade that did not happen.
 *
 * The squad starts at tier 0, so progression is felt from the first bubble.
 *
 * The squad fires energy LASERS: every tier is a shade of cyan/blue (the squad's
 * own colour and the UI's), so the hue says "ours" and the tier still reads in
 * the bolt's length, width and rate. No tier ejects brass. The turret keeps its
 * hot orange, which now contrasts even harder with the squad's cyan.
 */
export const WEAPONS = [
  {
    id: 'pistol', name: 'PISTOL', dpsMult: 1.0, rate: 3.0, pellets: 1,
    spreadX: 0, pierce: 0, tracerColor: 0x6fe3ff, muzzleColor: 0xcff6ff,
    gunLength: 0.30, tracerWidth: 0.9, tracerLen: 0.75, casings: false,
    shotGain: 0.55, shotHz: 320, spin: 0,
  },
  {
    id: 'smg', name: 'SMG', dpsMult: 1.45, rate: 9.0, pellets: 1,
    spreadX: 0.05, pierce: 0, tracerColor: 0x8af0ff, muzzleColor: 0xddfbff,
    gunLength: 0.44, tracerWidth: 0.8, tracerLen: 0.85, casings: false,
    shotGain: 0.42, shotHz: 300, spin: 0,
  },
  {
    id: 'rifle', name: 'RIFLE', dpsMult: 2.1, rate: 4.5, pellets: 1,
    spreadX: 0, pierce: 1, tracerColor: 0x4fb8ff, muzzleColor: 0xd0eeff,
    gunLength: 0.68, tracerWidth: 1.0, tracerLen: 1.5, casings: false,
    shotGain: 0.72, shotHz: 235, spin: 0,
  },
  {
    id: 'shotgun', name: 'SHOTGUN', dpsMult: 3.0, rate: 2.2, pellets: 5,
    spreadX: 0.42, pierce: 0, tracerColor: 0x3ff5d8, muzzleColor: 0xc8fff6,
    gunLength: 0.56, tracerWidth: 1.5, tracerLen: 0.55, casings: false,
    shotGain: 1.0, shotHz: 150, spin: 0,
  },
  {
    id: 'minigun', name: 'MINIGUN', dpsMult: 4.3, rate: 14.0, pellets: 1,
    spreadX: 0.06, pierce: 2, tracerColor: 0xa8f0ff, muzzleColor: 0xffffff,
    gunLength: 0.70, tracerWidth: 0.75, tracerLen: 1.1, casings: false,
    shotGain: 0.34, shotHz: 400, spin: 34,
  },
]

export const MAX_TIER = WEAPONS.length - 1

/**
 * The mounted gun of TURRET mode. NOT a tier: nothing upgrades into it and no
 * soldier carries it, so it stays out of WEAPONS where every length-derived
 * clamp (grade, HUD name, gun geometry swap) would otherwise pick it up. It
 * borrows the tier index one past the roster so the tracer and audio tables
 * can key on it exactly the way they key on a weapon.
 */
export const TURRET_TIER = WEAPONS.length
export const TURRET = {
  id: 'turret', name: 'TURRET', tracerColor: 0xff7a55, muzzleColor: 0xffc0a0,
  tracerWidth: 1.05, tracerLen: 1.25, casings: false,
  shotGain: 0.40, shotHz: 380, spin: 30,
}
