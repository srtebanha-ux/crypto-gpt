/**
 * TITAN MEV: deterministic 2-pool constant-product seed, inspired by
 * Engenharia Avancada de Bots MEV, pages 8-9.
 *
 * IMPORTANT: only a theoretical PRE-FILTER. Fee-on-transfer tokens, non-CPAMM
 * pools, concentrated-liquidity ticks, pending state, loan callback and gas
 * are not proven by this equation. Never use the result to authorize a tx.
 */
export interface PoolCpamm{
 reservaEntrada:bigint;
 reservaSaida:bigint;
 taxaNumerador:bigint; // retained fraction, e.g. 997n / 1000n
 taxaDenominador:bigint;
}
export interface EstimativaCpamm{
 tamanhoSugerido:bigint;
 lucroTeoricoAntesGas:bigint;
 saidaTeorica:bigint;
 modelo:'cpamm-2-pools-nao-verificado';
 candidatosAvaliados:number;
}
export function raizQuadradaInteira(n:bigint):bigint{
 if(n<0n)throw Error('raiz de numero negativo');
 if(n<2n)return n;
 let a=1n<<BigInt((n.toString(2).length+1)>>1);
 while(true){
  const b=(a+n/a)>>1n;
  if(b>=a)return a;
  a=b;
 }
}
function validarPool(x:PoolCpamm){
 return x.reservaEntrada>0n&&x.reservaSaida>0n
  &&x.taxaNumerador>0n&&x.taxaDenominador>0n
  &&x.taxaNumerador<=x.taxaDenominador;
}
export function saidaCpamm(p:PoolCpamm,quantia:bigint):bigint{
 if(!validarPool(p)||quantia<=0n)return 0n;
 const eficaz=quantia*p.taxaNumerador;
 return (eficaz*p.reservaSaida)/(p.reservaEntrada*p.taxaDenominador+eficaz);
}
function custoEmprestimo(quantia:bigint,feeN:bigint,feeD:bigint):bigint{
 // Always ceil flash-loan principal + fee, never round repayment down.
 return (quantia*(feeD+feeN)+feeD-1n)/feeD;
}
export function estimarTamanhoCicloCpamm(
 primeira:PoolCpamm,segunda:PoolCpamm,
 maximo:bigint,granularidade=1n,
 taxaFlashNumerador=0n,taxaFlashDenominador=1n,
):EstimativaCpamm|null{
 if(!validarPool(primeira)||!validarPool(segunda)
    ||granularidade<=0n||maximo<granularidade
    ||taxaFlashNumerador<0n||taxaFlashDenominador<=0n)return null;
 // F(x) = A*x/(B+C*x), where second-pool input is first-pool output.
 const f=primeira.taxaNumerador,g=primeira.taxaDenominador;
 const h=segunda.taxaNumerador,j=segunda.taxaDenominador;
 const A=f*h*primeira.reservaSaida*segunda.reservaSaida;
 const B=g*j*primeira.reservaEntrada*segunda.reservaEntrada;
 const C=f*(j*segunda.reservaEntrada+h*primeira.reservaSaida);
 if(A*taxaFlashDenominador<=B*(taxaFlashDenominador+taxaFlashNumerador)
    ||C<=0n)return null;
 const raiz=raizQuadradaInteira(
  A*B*taxaFlashDenominador/(taxaFlashDenominador+taxaFlashNumerador)
 );
 if(raiz<=B)return null;
 const otimo=(raiz-B)/C;
 const candidato=(x:bigint)=>x/granularidade*granularidade;
 // Integer rounding and fee-ceil can move the optimum; test neighbors.
 const set=new Set<bigint>();
 for(const bps of [9000n,9500n,9900n,9950n,10000n,10050n,10100n,10500n,11000n]){
  const x=candidato(otimo*bps/10000n);
  if(x>=granularidade&&x<=maximo)set.add(x);
 }
 for(const x of [granularidade,maximo,maximo/2n,otimo-granularidade,
                   otimo,otimo+granularidade]){
  const q=candidato(x);if(q>=granularidade&&q<=maximo)set.add(q);
 }
 let best:EstimativaCpamm|null=null;
 for(const x of set){
  const y=saidaCpamm(primeira,x);
  const z=saidaCpamm(segunda,y);
  const profit=z-custoEmprestimo(x,taxaFlashNumerador,taxaFlashDenominador);
  if(profit<=0n)continue;
  if(!best||profit>best.lucroTeoricoAntesGas){
   best={tamanhoSugerido:x,lucroTeoricoAntesGas:profit,
    saidaTeorica:z,modelo:'cpamm-2-pools-nao-verificado',
    candidatosAvaliados:set.size};
  }
 }
 return best;
}
