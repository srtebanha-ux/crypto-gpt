/**
 * Classificacao de reversoes Solidity economicas do CacadorV3.
 *
 * Ethers encapsula revert data em Error.data, error.data e info.error.data.
 * Nao confundir PagamentoCurto com falha de RPC ou com lucro positivo.
 * O token cuja unidade aparece no erro pode ser WETH ou intermediario:
 * os numeradores abaixo sao sempre UNIDADES BRUTAS DO TOKEN DO CALLBACK.
 */
import { Interface } from 'ethers';

const erros=new Interface([
  'error PagamentoCurto(uint256 tem,uint256 devido)',
  'error LucroInsuficiente(uint256 obtido,uint256 minimo)',
]);

export type DiagnosticoEconomicoTitan=
  | {tipo:'pagamento-curto';tem:bigint;devido:bigint;deficit:bigint;deficitBps:bigint}
  | {tipo:'lucro-insuficiente';obtido:bigint;minimo:bigint;deficit:bigint};

function revertsNaArvore(v:unknown,profundidade=0):string[]{
  if(profundidade>5||v===null||typeof v!=='object')return [];
  const x=v as Record<string,unknown>;
  const result:string[]=[];
  // Cada nivel de Error pode encapsular bytes ou a resposta JSON-RPC inteira.
  if(typeof x.data==='string' && /^0x[0-9a-fA-F]+$/.test(x.data))
    result.push(x.data);
  if(typeof x.body==='string'&&x.body.length<12_000){
    try{result.push(...revertsNaArvore(JSON.parse(x.body),profundidade+1));}catch{}
  }
  for(const key of ['error','info','originalError','cause','result']){
    result.push(...revertsNaArvore(x[key],profundidade+1));
  }
  return result;
}

export function diagnosticarReversaoTitan(error:unknown):DiagnosticoEconomicoTitan|null{
  for(const data of revertsNaArvore(error)){
    try{
      const analisado=erros.parseError(data);
      if(!analisado)continue;
      if(analisado.name==='PagamentoCurto'){
        const tem=BigInt(analisado.args[0]);
        const devido=BigInt(analisado.args[1]);
        const deficit=devido>tem?devido-tem:0n;
        return {tipo:'pagamento-curto',tem,devido,deficit,
          deficitBps:devido>0n?(deficit*10_000n)/devido:0n};
      }
      if(analisado.name==='LucroInsuficiente'){
        const obtido=BigInt(analisado.args[0]);
        const minimo=BigInt(analisado.args[1]);
        return{tipo:'lucro-insuficiente',obtido,minimo,
          deficit:minimo>obtido?minimo-obtido:0n};
      }
    }catch{}
  }
  return null;
}

/** Microbusca limitada: pesquisar outro tamanho nao garante lucro.
 * Nao usar bissecao cega: ticks mudam a curva e monotonicidade nao e universal.
 * Testar metade primeiro e +/-1 unidade se o deficit foi realmente microscopico
 * <=1bp do token cobrado. Teto 3 propostas, sem duplicatas nem zero.
 */
export function tamanhosDePrecisaoTitan(
  tamanho:bigint,diagnostico:DiagnosticoEconomicoTitan|null,
):bigint[]{
  if(tamanho<=1n||diagnostico?.tipo!=='pagamento-curto'
    ||diagnostico.deficit<=0n)return [];
  const alt=[tamanho/2n];
  if(diagnostico.deficitBps<=1n){
    alt.push(tamanho-1n,tamanho+1n);
  }
  return [...new Set(alt.filter(x=>x>0n&&x!==tamanho)
    .map(x=>x.toString()))].slice(0,3).map(BigInt);
}

/** Decisao do ensaio atômico: um segundo teste SEM ENVIO, limitado ao
 * tamanho menor apos PagamentoCurto. Dust +/-1 e permitido so com deficit <=1bp.
 * Evita repetir a mesma cotacao e nunca autoriza broadcast sozinho.
 */
export function retentarTamanhoPorErroTitan(
  tamanho:bigint,erroContrato:string|undefined,deficitBps:string|undefined,
):bigint[]{
  if(erroContrato!=='pagamento-curto'||!deficitBps
    ||!/^\d+$/.test(deficitBps))return[];
  const bps=BigInt(deficitBps);
  if(bps>10_000n)return[];
  // Falha microscopica: experimente -1 unidade, que pode atravessar
  // um limite inteiro da curva. Se maior que 1bp, a variacao de um wei
  // dificilmente altera a economia: teste metade e reduza impacto de preco.
  const candidato=bps<=1n?tamanho-1n:tamanho/2n;
  return candidato>0n&&candidato!==tamanho?[candidato]:[];
}
