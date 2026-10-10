// Arquivo: src/prng.ts
//
// Gerador pseudoaleatório com seed (mulberry32) + amostrador gaussiano
// (Box-Muller) — usado pela simulação Monte Carlo. `Math.random()` não tem
// seed, então não dá pra escrever um teste determinístico em cima dele;
// isso aqui permite reproduzir exatamente a mesma sequência a partir do
// mesmo seed, essencial para testar a simulação sem depender de sorte.
export type RandomSource = () => number; // uniforme em [0, 1)

/** mulberry32: PRNG simples, rápido, de qualidade suficiente para simulação (não criptográfico). */
export function createSeededRandom(seed: number): RandomSource {
    let state = seed >>> 0;
    return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Amostra de N(mean, stdDev) via transformação Box-Muller, a partir de uma fonte uniforme [0,1). */
export function gaussianSample(random: RandomSource, mean: number, stdDev: number): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = random();
    while (v === 0) v = random();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + z * stdDev;
}
