// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Voting} from "./Voting.sol";
import {VoterRegistry} from "./VoterRegistry.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title VotingFactory
 * @notice Deploys new isolated election instances with their own VoterRegistry.
 *
 * @dev Each election gets its own VoterRegistry (Ownable) and Voting contract,
 * enabling multiple simultaneous elections with independent voter whitelists.
 */
contract VotingFactory is Ownable {
    constructor(address _admin) Ownable(_admin) {}
    event ElectionCreated(
        address indexed voting,
        address indexed registry,
        string name,
        string[] candidates,
        uint256 commitDuration,
        uint256 revealDuration
    );

    /**
     * @notice Deploy a new election and register the admin as an eligible voter.
     * @param name Election name string.
     * @param candidates Candidate name strings (array).
     * @param commitDuration Commit phase duration in seconds.
     * @param revealDuration Reveal phase duration in seconds.
     * @param admin Address to whitelist as eligible voter (usually the deployer).
     * @return voting Address of the newly deployed Voting contract.
     * @return registry Address of the newly deployed VoterRegistry contract.
     */
    function createElection(
        string calldata name,
        string[] calldata candidates,
        uint256 commitDuration,
        uint256 revealDuration,
        address admin
    ) external onlyOwner returns (address voting, address registry) {
        // 1. Deploy new VoterRegistry with admin as initial whitelisted voter
        registry = address(new VoterRegistry(admin));

        // 2. Deploy new Voting contract pointing at this registry
        // Acceptance checks already happen in Voting constructor (no candidates, invalid durations)
        voting = address(new Voting(name, candidates, commitDuration, revealDuration, address(registry)));

        emit ElectionCreated(voting, registry, name, candidates, commitDuration, revealDuration);
    }
}
