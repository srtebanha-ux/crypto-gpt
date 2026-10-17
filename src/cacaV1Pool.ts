/**
 * Cacador V1 usa um unico pool V2 conhecido WETH/USDC. Essa rota nao
 * recebe cbBTC/EURC. Nao desperdicamos RPC tentando swap impossivel.
 * Conserva o caminho antigo quando a pool foi customizada ou desconhecida.
 */
const WETH_BASE='0x4200000000000000000000000000000000000006';
const USDC_BASE='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export function permiteV1NaPoolPadrao(
  garantia:string,divida:string,poolUsada:string,poolConhecida:string,
):boolean{
 const g=garantia.toLowerCase(),d=divida.toLowerCase();
 if(g===d)return true; // contrato V1 pula venda
 if(poolUsada.toLowerCase()!==poolConhecida.toLowerCase())return true;
 return (g===WETH_BASE&&d===USDC_BASE)||(g===USDC_BASE&&d===WETH_BASE);
}
