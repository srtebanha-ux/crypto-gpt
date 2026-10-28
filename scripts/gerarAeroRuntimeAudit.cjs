'use strict';
// Build-time public compilation manifest. Never reads credentials or signs tx.
// Immutable offsets are emitted by solc; do not guess them from live bytecode.
const fs=require('node:fs'),path=require('node:path');
const root='.tmp/artifacts/build-info';
const target='contracts/TitanCacadorMorphoAero.sol',name='TitanCacadorMorphoAero';
let found=null;
for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.json'))){
 const b=JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
 const contract=b.output?.contracts?.[target]?.[name];
 if(contract?.evm?.deployedBytecode?.object){
   if(found)throw Error('multiple Aero build-info contracts; audit ambiguous');
   found={version:b.solcVersion,runtime:'0x'+contract.evm.deployedBytecode.object,
     immutableReferences:contract.evm.deployedBytecode.immutableReferences};
 }
}
if(!found||!/^0x[0-9a-f]+$/i.test(found.runtime)
  ||!found.immutableReferences||!Object.keys(found.immutableReferences).length)
 throw Error('Aero source compilation/immutable references missing');
const art=JSON.parse(fs.readFileSync('.tmp/artifacts/'+target+'/'+name+'.json','utf8'));
if(art.deployedBytecode.toLowerCase()!==found.runtime.toLowerCase())
 throw Error('Aero compiled artifact and build-info mismatch');
fs.writeFileSync('.tmp/artifacts/AeroRuntimeAudit.json',JSON.stringify(found));
console.log('Aero immutable-offset source manifest generated (read-only)');
