import { JsonRpcProvider, type JsonRpcPayload, type JsonRpcResult } from 'ethers';

/** Shared by scanners and read-only probes in this process, per exact endpoint.
 * Quotas belonging to separate processes still require provider-side capacity.
 */
export class AgendaRpc {
    private fila: Promise<void> = Promise.resolve();
    private usos: number[] = [];
    private bloqueadoAte = 0;
    private recusas = 0;
    private reservas=0;
    private recusasTotal=0;
    private esperaMs=0;
    constructor(private readonly limite = 20,
        private readonly agora = () => Date.now(),
        private readonly esperar = (ms:number) => new Promise<void>(r=>setTimeout(r,ms))) {
        if (!Number.isSafeInteger(limite) || limite < 1) throw Error('limite RPC invalido');
    }
    reservar(custo=1): Promise<void> {
        if (!Number.isSafeInteger(custo) || custo<1 || custo>this.limite)
            return Promise.reject(Error('lote RPC excede capacidade coordenada'));
        const vaga=this.fila.then(async()=>{
            for (;;) {
                const t=this.agora();
                this.usos=this.usos.filter(x=>t-x<1000);
                const falta=Math.max(this.bloqueadoAte-t,
                    this.usos.length+custo>this.limite ? this.usos[0]!+1001-t : 0);
                if(falta<=0){for(let i=0;i<custo;i++)this.usos.push(t);this.reservas+=custo;return;}
                this.esperaMs+=falta;
                await this.esperar(falta);
            }
        });
        this.fila=vaga.catch(()=>{});
        return vaga;
    }
    estatisticas(){return {reservas:this.reservas,recusas:this.recusasTotal,esperaMs:this.esperaMs};}
    recusar(retryAfterMs=0):void {
        this.recusasTotal++;
        this.recusas=Math.min(5,this.recusas+1);
        this.bloqueadoAte=Math.max(this.bloqueadoAte,
            this.agora()+Math.max(retryAfterMs,1000*2**this.recusas));
    }
    passou():void {this.recusas=Math.max(0,this.recusas-1);}
}
const agendas=new Map<string,AgendaRpc>();
export function agendaRpc(url:string):AgendaRpc {
    let a=agendas.get(url);
    if(!a){a=new AgendaRpc();agendas.set(url,a);}
    return a;
}
export function resumoRpcCoordenado(){
    return [...agendas.values()].reduce((a,x)=>{
        const s=x.estatisticas();return {endpoints:a.endpoints+1,reservas:a.reservas+s.reservas,
            recusas:a.recusas+s.recusas,esperaMs:a.esperaMs+s.esperaMs};
    },{endpoints:0,reservas:0,recusas:0,esperaMs:0});
}
export function ehSaturacaoRpc(e:unknown):boolean {
    let texto:string|undefined;
    try{texto=typeof e==='string'?e:JSON.stringify(e);}
    catch{texto=e instanceof Error?e.message:String(e);}
    return /\b429\b|25\/second|rate[ -]?limit|request limit reached|too many requests|throttl/i.test(texto??'');
}

/** Coalesces simultaneous metadata reads. Failures are never cached. */
export class CacheLeituraRpc<T> {
    private valores=new Map<string,{ate:number;valor:T}>();
    private pendentes=new Map<string,Promise<T>>();
    constructor(private readonly ttlMs:number,private readonly agora=()=>Date.now()){}
    ler(chave:string,carregar:()=>Promise<T>):Promise<T>{
        const salvo=this.valores.get(chave);
        if(salvo&&salvo.ate>this.agora())return Promise.resolve(salvo.valor);
        const emCurso=this.pendentes.get(chave);
        if(emCurso)return emCurso;
        const p=Promise.resolve().then(carregar).then(valor=>{
            // Bound metadata memory even if configuration changes often.
            if(this.valores.size>=128)this.valores.delete(this.valores.keys().next().value!);
            this.valores.set(chave,{ate:this.agora()+this.ttlMs,valor});return valor;
        }).finally(()=>this.pendentes.delete(chave));
        this.pendentes.set(chave,p);return p;
    }
}

/** Only used by eth_call/estimateGas probes. Paid execution keeps fresh checks. */
export class ProviderSondaRpc extends JsonRpcProvider {
    private readonly agenda:AgendaRpc;
    constructor(url:string){
        super(url,8453,{staticNetwork:true,batchMaxCount:1,batchStallTime:0,cacheTimeout:0});
        this.agenda=agendaRpc(url);
    }
    override async _send(payload:JsonRpcPayload|JsonRpcPayload[]):Promise<JsonRpcResult[]>{
        await this.agenda.reservar(Array.isArray(payload)?payload.length:1);
        try{
            const resposta=await super._send(payload);
            if(resposta.some(r=>'error' in r&&ehSaturacaoRpc(r.error)))this.agenda.recusar();
            else this.agenda.passou();
            return resposta;
        }catch(e){if(ehSaturacaoRpc(e))this.agenda.recusar();throw e;}
    }
}
