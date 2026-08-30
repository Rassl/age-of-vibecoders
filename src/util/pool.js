/**
 * Fixed-capacity object pool with a swap-remove free list.
 *
 * Live objects occupy indices [0, size). Releasing an object swaps the last
 * live object into its slot, so iteration over live objects is always a tight
 * contiguous loop with no holes and no allocation during play.
 *
 * Iterate BACKWARDS when you may release during iteration:
 *   for (let i = pool.size - 1; i >= 0; i--) { ... pool.release(i) ... }
 */
export class Pool {
  /**
   * @param {number} capacity hard maximum number of live objects
   * @param {() => object} factory allocates one object up front
   */
  constructor(capacity, factory) {
    this.capacity = capacity
    this.size = 0
    this.items = new Array(capacity)
    for (let i = 0; i < capacity; i++) this.items[i] = factory(i)
  }

  /** Returns the next free object, or null if the pool is exhausted. */
  acquire() {
    if (this.size >= this.capacity) return null
    return this.items[this.size++]
  }

  /** Release the live object at index i (swap-remove). */
  release(i) {
    const last = --this.size
    if (i !== last) {
      const tmp = this.items[i]
      this.items[i] = this.items[last]
      this.items[last] = tmp
    }
  }

  clear() {
    this.size = 0
  }

  /** Call fn(item, index) for each live item, forwards. */
  forEach(fn) {
    for (let i = 0; i < this.size; i++) fn(this.items[i], i)
  }
}
