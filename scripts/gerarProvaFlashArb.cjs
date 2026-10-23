// Builds strictly read-only FlashArb runtimes. Paid executor allows only
// exactly matching compiled executable code, owner immutable, and Base chain.
const fs=require('node:fs');
const path=require('node:path');
const solc=require('solc');
const source=fs.readFileSync('contracts/FlashArb.sol','utf8');
function compile(enabled){
 const input={language:'Solidity',sources:{'FlashArb.sol':{content:source}},
  settings:{optimizer:{enabled,runs:200},
   outputSelection:{'*':{'*':['evm.deployedBytecode.object',
     'evm.deployedBytecode.immutableReferences','evm.bytecode.object','abi']}}}};
 const output=JSON.parse(solc.compile(JSON.stringify(input)));
 const errors=(output.errors||[]).filter(e=>e.severity==='error');
 if(errors.length)throw Error(errors.map(e=>e.formattedMessage).join('\n'));
 const c=output.contracts['FlashArb.sol'].FlashArb;
 const ranges=Object.values(c.evm.deployedBytecode.immutableReferences).flat();
 if(!ranges.length||ranges.some(x=>x.length!==32))
  throw Error('FlashArb owner immutable reference missing or unexpected');
 return {runtime:'0x'+c.evm.deployedBytecode.object,
   creation:'0x'+c.evm.bytecode.object,ownerReferences:ranges,abi:c.abi,
   optimizerEnabled:enabled,compiler:solc.version()};
}
const optimized=compile(true);
const plain=compile(false);
const out={...optimized,variantes:[plain]};
const dest='.tmp/artifacts/FlashArbProva.json';
fs.mkdirSync(path.dirname(dest),{recursive:true});
fs.writeFileSync(dest,JSON.stringify(out));
process.stdout.write('FlashArb EVM variants built (optimizer on/off, owner refs)\n');
