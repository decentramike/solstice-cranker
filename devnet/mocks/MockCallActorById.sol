// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity ^0.8.36;

/// @notice Stand-in for the FVM `CALL_ACTOR_BY_ID` precompile (0xfe..05) on a plain EVM devnet.
///
/// @dev Reached only via `delegatecall` from `FVMRewards._invoke`, which requires
///      `returndatasize() > 31` and reads the FIRST 32 BYTES of the return data as f02's
///      `int256` exit code, discarding everything after. Returning one zero word is therefore
///      a complete, faithful "f02 accepted the message".
///
/// @dev Because the caller delegatecalls, this code executes in the SRA's or SWA's storage
///      context. It MUST NOT write storage. It does not: the only memory it touches is scratch
///      it returns from immediately. The log is attributed to the calling actor's address, which
///      is what we want -- it is that actor that spoke to f02.
///
/// @dev The envelope is the hand-laid six-field tuple
///      (uint64 method, uint256 value, uint64 flags, uint64 codec, bytes params, uint64 actorId).
///      It is emitted verbatim rather than decoded, so no ABI-decoder edge case around the
///      unpadded trailing `params` can make the mock behave differently from the real precompile.
contract MockCallActorById {
    /// @dev keccak256("FvmActorCall(bytes)")
    bytes32 private constant TOPIC = 0xd19248b615d8ec871fc4c28ef31cd762a9c474cf1dd9101b05cb54efd667ef61;

    fallback() external payable {
        assembly ("memory-safe") {
            let len := calldatasize()
            let ptr := mload(0x40)
            calldatacopy(ptr, 0, len)
            log1(ptr, len, TOPIC)
            mstore(0x00, 0) // EXIT_SUCCESS
            return(0x00, 0x20)
        }
    }
}

/// @notice Same shape, but reports an f02 actor error so the cranker's failure path can be exercised.
/// @dev Exit code 17 (USR_ILLEGAL_ARGUMENT) drives `StepWeightRecordsFailed` / `SetSharesFailed`.
contract MockCallActorByIdFailing {
    fallback() external payable {
        assembly ("memory-safe") {
            mstore(0x00, 17)
            return(0x00, 0x20)
        }
    }
}

/// @notice Returns too little data, so `_invoke` falls through to EXIT_PRECOMPILE_FAILED.
contract MockCallActorByIdSilent {
    fallback() external payable {
        assembly ("memory-safe") {
            return(0x00, 0x00)
        }
    }
}
