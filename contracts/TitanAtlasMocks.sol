// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./MocksDeTeste.sol";

/** Read-only LOCAL TEST mocks: NOT to be deployed to Base. */
interface ITitanAtlasTestSolver {
    function atlasSolverCall(
        address solverOpFrom,address environment,address bidToken,uint256 bid,
        bytes calldata data,bytes calldata forwarded
    ) external payable;
}
contract AtlasTitanFalso {
    uint256 public calls;
    function shortfall() external pure returns(uint256 gasLiability,uint256 borrowLiability) {
        return(0,0);
    }
    function reconcile(uint256) external payable returns(uint256 owed) {
        return 0;
    }
    function run(address solver,address signatory,address env,uint256 bid,bytes calldata data) external {
        ITitanAtlasTestSolver(solver).atlasSolverCall(signatory,env,address(0),bid,data,hex"");
        calls++;
    }
}
contract WethTitanFalso is TokenFalso {
    constructor() TokenFalso("WETH") {}
    receive() external payable { balanceOf[msg.sender]+=msg.value; }
    function deposit() external payable { balanceOf[msg.sender]+=msg.value; }
    function withdraw(uint256 value) external {
        require(balanceOf[msg.sender]>=value,"insufficient WETH");
        balanceOf[msg.sender]-=value;
        (bool ok,)=msg.sender.call{value:value}("");
        require(ok,"unwrapping rejected");
    }
}
