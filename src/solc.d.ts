// `solc` nao publica tipos. Usado so por `src/tiroForcado.ts`, que compila um
// stub de oraculo para provar o caminho do tiro sem esperar o mercado.
declare module 'solc' {
    const solc: { compile(entrada: string): string };
    export default solc;
}
