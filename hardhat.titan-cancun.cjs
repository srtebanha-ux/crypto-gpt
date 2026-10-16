// Compila SÓ o contrato novo para Cancun, sem mudar o bytecode V3
// usado pelo executor original em producao. Testes LOCAL, sem fork.
const base=require('./hardhat.morpho-local.cjs');
module.exports={
    ...base,
    solidity:{version:'0.8.26',settings:{
        optimizer:{enabled:true,runs:200},evmVersion:'cancun'
    }},
    paths:{...base.paths,sources:'./contractsCancun',
        cache:'./.tmp/hhcache-cancun',artifacts:'./.tmp/artifacts-cancun'},
    networks:{hardhat:{chainId:8453,hardfork:'cancun',allowUnlimitedContractSize:true}}
};
