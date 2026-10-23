import {Wallet} from 'ethers';

/** Accept the same scalar with or without 0x; never include input in errors. */
export function normalizarChaveMegazord(value:unknown):string{
 if(typeof value!=='string')throw Error('credencial Megazord invalida');
 const hex=value.trim().replace(/^0x/i,'');
 if(!/^[0-9a-f]{64}$/i.test(hex))throw Error('credencial Megazord invalida');
 const key='0x'+hex;
 try{new Wallet(key);}catch{throw Error('credencial Megazord invalida');}
 return key;
}

/** Existing aliases are usable only if EVERY supplied alias is the same owner. */
export function resolverChaveMegazord(env:NodeJS.ProcessEnv):string{
 const values=[env.MEGAZORD_CHAVE_PRIVADA,env.CACA_CHAVE_PRIVADA,env.TITAN_CHAVE_PRIVADA]
   .filter((v):v is string=>v!==undefined);
 if(!values.length)throw Error('carteira publica e credencial do Megazord obrigatorias');
 const keys=values.map(normalizarChaveMegazord);
 const address=new Wallet(keys[0]!).address;
 if(keys.some(k=>new Wallet(k).address!==address))
   throw Error('Megazord exige a mesma carteira em todos os motores');
 return keys[0]!;
}

/** Called only after explicit execution authorization; no secrets in diagnostics. */
export function normalizarCredenciaisMegazord(env:NodeJS.ProcessEnv):void{
 const key=resolverChaveMegazord(env);
 for(const name of ['MEGAZORD_CHAVE_PRIVADA','CACA_CHAVE_PRIVADA','TITAN_CHAVE_PRIVADA'])
   env[name]=key;
}
