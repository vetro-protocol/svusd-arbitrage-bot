// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {SVusdArbitrage} from "../contracts/SVusdArbitrage.sol";

/// @notice Deploy SVusdArbitrage, wire it (router allowlist + profit floor) as the temporary
///         deployer-owner, then hand ownership to OWNER via Ownable2Step. OWNER must call
///         acceptOwnership() to finish the handoff.
///
/// Env inputs:
///   BENEFICIARY     cold Safe that receives realized profit at settle
///   KEEPER          hot bot EOA (the keeper signer)
///   OWNER           governance Safe (final owner); if == deployer, ownership is kept
///   MIN_PROFIT_BPS  profit floor in bps (optional, default 30)
///
/// Run:
///   forge script script/Deploy.s.sol:Deploy --rpc-url "$ETHEREUM_RPC_URL" \
///     --private-key "$DEPLOYER_KEY" --broadcast --verify --etherscan-api-key "$KEY"
/// Fork dry-run: same command without --broadcast --verify.
contract Deploy is Script {
    // Mainnet ground truth (mirrors src/constants.ts).
    address constant SVUSD = 0x476310E34D2810f7d79C43A74E4D79405bd7a925;
    address constant CURVE_ROUTER = 0x16C6521Dff6baB339122a0FE25a9116693265353;

    function run() external returns (SVusdArbitrage arb) {
        address beneficiary = vm.envAddress("BENEFICIARY");
        address keeper = vm.envAddress("KEEPER");
        address owner = vm.envAddress("OWNER");
        uint256 minProfitBps = vm.envOr("MIN_PROFIT_BPS", uint256(30));

        address deployer = msg.sender;
        bool handoff = owner != deployer;

        vm.startBroadcast();
        arb = new SVusdArbitrage(SVUSD, beneficiary, keeper, deployer);
        arb.setAllowedSwapAddress(CURVE_ROUTER, true);
        arb.setMinProfitBps(minProfitBps);
        // Skip a self-transfer, which would leave a dangling pending owner.
        if (handoff) arb.transferOwnership(owner);
        vm.stopBroadcast();

        console2.log("SVusdArbitrage :", address(arb));
        console2.log("beneficiary    :", beneficiary);
        console2.log("keeper         :", keeper);
        console2.log("minProfitBps   :", minProfitBps);
        if (handoff) {
            console2.log("pending owner  :", owner);
            console2.log("(governance must call acceptOwnership to finish the handoff)");
        } else {
            console2.log("owner          :", deployer, "(deployer retains ownership)");
        }
    }
}
