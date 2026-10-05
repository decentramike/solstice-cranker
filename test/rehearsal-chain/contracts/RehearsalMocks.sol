// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity 0.8.36;

/// Stand-ins for the SWA and SRA, for rehearsal-mode tests on a local chain that reports calibnet's
/// chain id. Errors and events carry the real contracts' signatures, so the cranker decodes them
/// with the shipped ABI exactly as it would on calibnet. The gate's lastCheckedQuarter and steps
/// live in the real ERC-7201 slot, so the cranker reads them the way it reads the real SWA.
contract MockSWA {
    error StepWeightRecordsFailed(int256 code);
    error StepsComplete();
    event QuarterlyGateCheckResult(uint64 indexed quarter, bool passed, uint64 steps);

    bytes32 private constant GATE = 0xf9abab00248d945495524c8caf6be2b837274c1becd1964fb3775f62fd6e4600;

    /// 0 pass, 1 lands with passed = false, 2 revert StepWeightRecordsFailed(16), 3 revert StepsComplete()
    uint8 public mode;

    function setMode(uint8 m) external {
        mode = m;
    }

    function setLastChecked(uint64 q) external {
        bytes32 s = GATE;
        assembly {
            sstore(s, q)
        }
    }

    function quarterlyGateCheck() external {
        if (mode == 2) revert StepWeightRecordsFailed(16);
        if (mode == 3) revert StepsComplete();
        bytes32 s0 = GATE;
        bytes32 s3 = bytes32(uint256(GATE) + 3);
        uint64 last;
        uint64 steps;
        assembly {
            last := and(sload(s0), 0xffffffffffffffff)
            steps := and(sload(s3), 0xffffffffffffffff)
        }
        last += 1;
        bool passed = mode == 0;
        if (passed) steps += 1;
        assembly {
            sstore(s0, last)
            sstore(s3, steps)
        }
        emit QuarterlyGateCheckResult(last, passed, steps);
    }
}

contract MockSRA {
    error NotBound(uint64 q);
    error AlreadySubmitted(uint64 q);
    event SharesSubmitted(uint64 indexed q, uint256 recipientCount, uint256 totalUsd);

    uint64 public lastSubmitted;
    uint64 public latestBound = 7;

    function setLatestBound(uint64 q) external {
        latestBound = q;
    }

    function submitShares(uint64 q) external {
        if (q > latestBound) revert NotBound(q);
        if (q <= lastSubmitted) revert AlreadySubmitted(q);
        lastSubmitted = q;
        emit SharesSubmitted(q, 1, 0);
    }
}
