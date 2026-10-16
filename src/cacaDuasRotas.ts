/**
 * Disjuntor persistente COMPARTILHADO por V1, V2 e Multi-Hop.
 * Fica no MESMO processo e no volume /app/data; nunca cria outra carteira.
 * Uma reserva PENDENTE impede qualquer novo tiro ate recibo reconciliado.
 */
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export type TipoExecutor = 'V1'|'V2'|'MH';
type Reserva = {kind:'reserve';id:string;day:string;time:string;tipo:TipoExecutor;
    alvo:string;maxCostWei:string};
type Resposta = {kind:'result';id:string;time:string;outcome:'acertou'|'reverteu'|'sumiu';hash?:string};
type Registro = Reserva|Resposta;
const ARQUIVO='/app/data/caca-gas-diario.jsonl';
const DIA=(dt:Date)=>dt.toISOString().slice(0,10);

function carregar(caminho:string): Registro[]{
    if(!fs.existsSync(caminho))return [];
    const body=fs.readFileSync(caminho,'utf8');
    if(body.length>500_000)throw new Error('diario muito grande; requer rotacao revisada');
    if(body && !body.endsWith('\n'))throw new Error('diario incompleto; parar envio');
    return body.split('\n').filter(Boolean).map((linha)=>{
        const item=JSON.parse(linha) as Registro;
        if(item.kind!=='reserve' && item.kind!=='result')throw new Error('linha desconhecida');
        return item;
    });
}
function escrever(caminho:string,evento:Registro):void{
    fs.mkdirSync(path.dirname(caminho),{recursive:true});
    const fd=fs.openSync(caminho,'a',0o600);
    try{
        fs.writeSync(fd,JSON.stringify(evento)+'\n');
        fs.fsyncSync(fd);
    }finally{fs.closeSync(fd);}
}
export function reservarGasCompartilhado(args:{
    tipo:TipoExecutor;alvo:string;maxCostWei:bigint;maxPerTxWei:bigint;
    maxDailyWei:bigint;maxTxDia:number;when?:Date;file?:string;
}):{id:string|null;reason:string}{
    try{
        const now=args.when??new Date(),day=DIA(now),file=args.file??ARQUIVO;
        if(args.maxCostWei<=0n || args.maxPerTxWei<=0n || args.maxDailyWei<=0n
            || args.maxCostWei>args.maxPerTxWei || args.maxTxDia<1 || args.maxTxDia>10)
            return{id:null,reason:'teto de gasto por envio invalido ou excedido'};
        const registros=carregar(file);
        const reservas=registros.filter((x):x is Reserva=>x.kind==='reserve');
        const resultados=new Map(registros.filter((x):x is Resposta=>x.kind==='result').map(x=>[x.id,x]));
        if(reservas.some(r=>!resultados.has(r.id) || resultados.get(r.id)?.outcome==='sumiu'))
            return{id:null,reason:'transacao pendente ou recibo incerto: conciliar Base/nonce'};
        const hoje=reservas.filter(x=>x.day===day);
        const gastos=hoje.reduce((total,x)=>total+BigInt(x.maxCostWei),0n);
        if(hoje.length>=args.maxTxDia || gastos+args.maxCostWei>args.maxDailyWei)
            return{id:null,reason:'cota diaria de tx ou de gas comprometida'};
        if(hoje.some(x=>resultados.get(x.id)?.outcome==='reverteu'))
            return{id:null,reason:'houve revert hoje; disjuntor ate proximo dia UTC'};
        const ev:Reserva={kind:'reserve',id:randomUUID(),day,
            time:now.toISOString(),tipo:args.tipo,alvo:args.alvo,
            maxCostWei:args.maxCostWei.toString()};
        escrever(file,ev);return{id:ev.id,reason:'reserva persistente criada antes do nonce'};
    }catch(err){return{id:null,reason:'falha no diario persistente: '+String(err).slice(0,160)};}
}
export function conciliarGasCompartilhado(id:string,
    outcome:Resposta['outcome'],hash?:string,file:string=ARQUIVO):boolean{
    try{
        const entries=carregar(file);
        if(!entries.some(x=>x.kind==='reserve'&&x.id===id)
            || entries.some(x=>x.kind==='result'&&x.id===id))return false;
        escrever(file,{kind:'result',id,time:new Date().toISOString(),outcome,hash});
        return true;
    }catch{return false;}
}

/** Classificacao do mesmo token de divida: bruto - gas conservador. */
export function pontuacaoDeLiquidez(tipo:TipoExecutor,brutoOuLiquido:bigint,
    gasConservadorLegadoCru:bigint):bigint {
    if(brutoOuLiquido<=0n)return 0n;
    return tipo==='MH' ? brutoOuLiquido
        : brutoOuLiquido>gasConservadorLegadoCru
            ? brutoOuLiquido-gasConservadorLegadoCru : 0n;
}
