/**
 * FlashArb.sol uses a V2 flash swap, not Aave/Balancer flash loans.
 *
 * The first hop (base -> alt) models borrowing alt and repaying base using
 * the V2 pool's input-side fee. Subtracting FLASH_LOAN_FEE a second time
 * double-counts financing and can reject profitable candidates prematurely.
 *
 * This helper is specific to FlashArb.sol; strategies funded by an external
 * flash-loan provider must use their own explicit fee schedule.
 */
import {Decimal} from 'decimal.js';
import type {FlashLoanCosts} from './ammMath';

export function custosDoFlashSwapV2(gasCostInToken:Decimal):FlashLoanCosts{
 if(!gasCostInToken.isFinite()||gasCostInToken.lt(0))
   throw Error('Gas do flash swap V2 deve ser finito e nao negativo');
 return {flashLoanFeeFraction:new Decimal(0),gasCostInToken};
}
