/**
 * ORACLE SHADOW — market data ONLY, never signs or sends transactions.
 *
 * Binance Spot trades + Coinbase Exchange ticker provide early, asynchronous
 * indications of oracle movement. Aave's onchain oracle is STILL the only
 * source of liquidation eligibility. CACA's existing executor retains all
 * safeguards, nonce windows, gas budgets and onchain simulation.
 *
 * WebSocket cache is best effort, max age 2500ms. Stale/malformed/conflicting
 * quotes are discarded, not promoted to synthetic oracle answers.
 */
import WebSocket from 'ws';
import Decimal from 'decimal.js';
import { EQUIVALENTES } from './precoDeMercado';

export type OrigemShadow='binance'|'coinbase';
export interface CotacaoShadow {
    origem:OrigemShadow; par:string; preco:Decimal; recebidoEm:number;
}
export interface RetratoShadow {
    precos:Map<string,Decimal>;
    origem:string;
    divergentes:string[];
    quantidadeDeFontes:number;
}
const BINANCE_WS='wss://stream.binance.com:9443/stream?streams=';
const COINBASE_WS='wss://ws-feed.exchange.coinbase.com';
const MAX_IDADE_MS=2500;
const DIVERGENCIA_MAXIMA_BPS=35; // 0.35%; USDT/USD or cross-venue moves can differ

function precoValido(value:unknown): Decimal|null {
    if(typeof value!=='string'||!/^\d+(?:\.\d+)?$/.test(value))return null;
    try{
        const d=new Decimal(value);
        return d.isFinite() && d.greaterThan(0) ? d:null;
    }catch{return null;}
}
export function decodificarCotacaoShadow(
    origem:OrigemShadow,payload:unknown,pares:readonly string[],
    recebidoEm:number,
):CotacaoShadow|null {
    if(!Number.isSafeInteger(recebidoEm)||recebidoEm<=0
        ||!payload||typeof payload!=='object')return null;
    const bruto=payload as Record<string,unknown>;
    let par:string|null=null,valor:unknown;
    if(origem==='binance'){
        const e=bruto.data&&typeof bruto.data==='object'
            ? bruto.data as Record<string,unknown> : bruto;
        if(e.e!=='trade'||typeof e.s!=='string')return null;
        par=e.s.toUpperCase();
        valor=e.p;
    }else{
        if(bruto.type!=='ticker'||typeof bruto.product_id!=='string')return null;
        par=pares.find(x=>EQUIVALENTES[x]?.coinbase===bruto.product_id)??null;
        valor=bruto.price;
    }
    if(!par||!pares.includes(par))return null;
    const preco=precoValido(valor);
    return preco?{origem,par,preco,recebidoEm}:null;
}
/**
 * Dois provedores frescos e divergentes significam mercado incerto.
 * Nao usamos nenhum deles para "prever" o preco ate se alinharem.
 * Um provedor isolado pode ACORDAR a leitura onchain; nunca atira sozinho.
 */
export function consolidarShadow(
    pares:readonly string[],cotacoes:readonly CotacaoShadow[],agora:number,
    validadeMs=MAX_IDADE_MS,
):RetratoShadow {
    const precos=new Map<string,Decimal>();
    const fontes=new Set<string>(), divergentes:string[]=[];
    for(const par of pares){
        const fresh=cotacoes.filter(c=>c.par===par
            && c.recebidoEm<=agora && agora-c.recebidoEm<=validadeMs);
        const b=fresh.find(c=>c.origem==='binance');
        const c=fresh.find(c=>c.origem==='coinbase');
        if(b&&c){
            const desvio=b.preco.minus(c.preco).abs().dividedBy(c.preco).mul(10_000);
            if(desvio.greaterThan(DIVERGENCIA_MAXIMA_BPS)){
                divergentes.push(par);continue;
            }
            precos.set(par,b.preco.plus(c.preco).dividedBy(2));
            fontes.add('binance');fontes.add('coinbase');
        }else if(b||c){
            const x=(b??c)!;
            precos.set(par,x.preco);fontes.add(x.origem);
        }
    }
    return {precos,origem:[...fontes].join('+')||'indisponivel',
        divergentes,quantidadeDeFontes:fontes.size};
}
export class OracleShadow {
    private readonly recentes=new Map<string,CotacaoShadow>();
    private readonly conexoes=new Set<WebSocket>();
    private readonly temporizadores=new Set<ReturnType<typeof setTimeout>>();
    private ativo=false;
    private readonly pares:string[];
    private readonly avisar:(mensagem:string)=>void;
    constructor(pares:string[],avisar:(mensagem:string)=>void=()=>{}){
        this.pares=[...new Set(pares.filter(x=>EQUIVALENTES[x]))];
        this.avisar=avisar;
    }
    iniciar():void{
        if(this.ativo||this.pares.length===0)return;
        this.ativo=true;
        this.conectar('binance',0);
        this.conectar('coinbase',0);
    }
    parar():void{
        this.ativo=false;
        for(const t of this.temporizadores)clearTimeout(t);
        this.temporizadores.clear();
        for(const ws of this.conexoes){try{ws.terminate();}catch{}}
        this.conexoes.clear();
        this.recentes.clear();
    }
    retrato(agora=Date.now()):RetratoShadow{
        return consolidarShadow(this.pares,[...this.recentes.values()],agora);
    }
    private conectar(origem:OrigemShadow,tentativa:number):void{
        if(!this.ativo)return;
        const url=origem==='binance'
            ? BINANCE_WS+this.pares.map(p=>p.toLowerCase()+'@trade').join('/')
            : COINBASE_WS;
        const ws=new WebSocket(url,{handshakeTimeout:8000,perMessageDeflate:false});
        this.conexoes.add(ws);
        let fechado=false;
        const matar=()=>{
            if(fechado)return;fechado=true;
            this.conexoes.delete(ws);
            if(!this.ativo)return;
            const pausa=Math.min(60000,1000*2**Math.min(tentativa,6));
            const t=setTimeout(()=>{
                this.temporizadores.delete(t);
                if(this.ativo)this.conectar(origem,tentativa+1);
            },pausa);
            this.temporizadores.add(t);
        };
        ws.on('open',()=>{
            tentativa=0;
            if(origem==='coinbase'){
                ws.send(JSON.stringify({type:'subscribe',
                    product_ids:this.pares.map(p=>EQUIVALENTES[p]!.coinbase),
                    channels:['ticker','heartbeat']}));
            }
            this.avisar(origem+' websocket conectado');
        });
        ws.on('message',data=>{
            // Nao interpretar frames enormes nem cotacao de socket fechado.
            if(!this.ativo || ws.readyState!==WebSocket.OPEN || data.length>16_384)return;
            let parsed:unknown;
            try{parsed=JSON.parse(data.toString());}catch{return}
            const c=decodificarCotacaoShadow(origem,parsed,this.pares,Date.now());
            if(c)this.recentes.set(c.par+':'+origem,c);
        });
        // ws responde ping automaticamente; pong duplicado atrasa o fluxo.
        ws.on('error',err=>{this.avisar(origem+' WS indisponivel: '+err.message.slice(0,100));});
        ws.on('close',()=>matar());
    }
}
